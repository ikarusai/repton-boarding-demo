import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir, stat, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import worker from "./worker.mjs";
import { inviteSessionEmail } from "./boarder-sign-in.mjs";
import { createDemoRoster, demoAccounts, demoCalendarHeaders, demoProgressHeaders, emptyDemoState } from "./demo-fixtures.mjs";

const endpoint = "https://script.google.com/macros/s/JARVIS_FICTIONAL_LOCAL_DEMO/exec";
const owners = new Set(demoAccounts.map(account => account.studentId));
const maxStateBytes = 5 * 1024 * 1024;
let active = false;

function validState(state) {
  if (state?.version !== 1) return false;
  for (const [name, headers] of [["calendar", demoCalendarHeaders], ["progress", demoProgressHeaders]]) {
    const rows = state[name];
    if (!Array.isArray(rows) || !rows.length || rows.length > 10000 ||
        !Array.isArray(rows[0]) || rows[0].length !== headers.length || headers.some((header, i) => rows[0][i] !== header)) return false;
    if (rows.slice(1).some(row => !Array.isArray(row) || row.length !== headers.length || !owners.has(row[0]) ||
      row.some(value => typeof value !== "string" || value.length > 16384))) return false;
  }
  return true;
}

export async function startDemoServer(options = {}) {
  if (active) throw new Error("Only one fictional demo server may run in this process.");
  // Reserve this before the first await; overlapping calls must not both replace
  // global fetch or own different in-memory snapshots of the same planner.
  active = true;
  const stateFile = resolve(options.stateFile || fileURLToPath(new URL(".demo-state.json", import.meta.url)));
  const lockPath = stateFile + ".lock";
  let lock;
  const unlock = async () => {
    if (!lock) return;
    await lock.close();
    await unlink(lockPath);
    lock = null;
  };
  try {
    await mkdir(dirname(stateFile), { recursive: true });
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("This fictional state is locked by another demo process. Close that process first. If it crashed, verify it has stopped before removing " + lockPath);
      throw error;
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    const instance = await createDemoServer({ ...options, stateFile });
    let closing;
    return { ...instance, close() {
      if (!closing) closing = (async () => {
        try { await instance.close(); }
        finally { try { await unlock(); } finally { active = false; } }
      })();
      return closing;
    } };
  } catch (error) {
    try { await unlock(); } finally { active = false; }
    throw error;
  }
}

async function createDemoServer({ port = 8788, stateFile, quiet = false, publicOrigin = "", hosted = false }) {
  const hostedOrigin = /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(publicOrigin);
  if (hosted && !hostedOrigin) throw new Error("Hosted demo requires its exact Render HTTPS origin.");
  if (publicOrigin && !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(publicOrigin) && !(hosted && hostedOrigin)) throw new Error("Use an exact supported HTTPS origin for the shared fictional demo.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid demo port.");
  const statePath = resolve(stateFile);
  let state = emptyDemoState();
  try {
    if ((await stat(statePath)).size > maxStateBytes) throw new Error("Demo state exceeds the local size limit.");
    state = JSON.parse(await readFile(statePath, "utf8"));
    if (!validState(state)) throw new Error("Demo state must contain only the two fictional accounts and existing planner schemas.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(statePath), { recursive: true });
  const writeState = async next => {
    const json = JSON.stringify(next, null, 2) + "\n";
    if (Buffer.byteLength(json) > maxStateBytes) throw new Error("Demo state is full.");
    const temporary = statePath + "." + randomBytes(6).toString("hex") + ".tmp";
    try {
      await writeFile(temporary, json, { mode: 0o600, flag: "wx" });
      await rename(temporary, statePath);
      state = next;
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  };
  let writes = Promise.resolve();
  const persist = next => {
    const pending = writes.then(() => writeState(next));
    writes = pending.catch(() => {});
    return pending;
  };
  const bridgeSecret = randomBytes(32).toString("hex");
  // Construct bindings explicitly: .env, .dev.vars and process credentials are
  // never read. Random secrets are process-local and not printed or persisted.
  const env = {
    JARVIS_BOARDER_LINKS: JSON.stringify(Object.fromEntries(demoAccounts.map(account => [account.email, account.studentId]))),
    JARVIS_INVITE_HASHES: JSON.stringify(Object.fromEntries(demoAccounts.map(account => [account.email, createHash("sha256").update(account.code).digest("hex")]))),
    JARVIS_SESSION_SECRET: randomBytes(32).toString("hex"),
    JARVIS_SHEETS_BRIDGE_URL: endpoint,
    JARVIS_SHEETS_BRIDGE_KEY: bridgeSecret,
    JARVIS_PLANNER_SPREADSHEET_ID: "fictional-local-demo-planner-book",
    JARVIS_TIMETABLE_ENABLED: "true",
    JARVIS_HELP_CONTACTS: JSON.stringify({
      duty: { instructions: "Demo only. Ask a trusted adult or the school's verified duty team for real support." },
      backup: { instructions: "Demo only. Confirm the school's backup support route before real use." }
    })
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    // A closed synthetic transport: no network fallback is possible.
    if (String(input) !== endpoint || options.method !== "POST") throw new Error("The fictional demo blocks all external service requests.");
    let payload, signature, request;
    try {
      ({ payload, signature } = JSON.parse(options.body));
      if (typeof payload !== "string" || payload.length > 32768 || !/^[a-f0-9]{64}$/.test(signature)) throw new Error();
      const expected = createHmac("sha256", bridgeSecret).update(payload).digest();
      if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) throw new Error();
      request = JSON.parse(payload);
      if (!owners.has(request.studentId) || !Number.isSafeInteger(request.timestamp) || Math.abs(Date.now() - request.timestamp) > 60000) throw new Error();
    } catch {
      return Response.json({ ok: false });
    }
    const { studentId, operation, tab } = request;
    if (operation === "roster") {
      const tables = createDemoRoster().slice(0, request.includeTimetable ? 5 : 4);
      const roster = tables.map((rows, index) => [rows[0], ...rows.slice(1).filter(row => row[index === 1 ? 1 : 0] === studentId)]);
      return Response.json({ ok: true, roster });
    }
    if (!Object.hasOwn(state, tab) || !["calendar", "progress"].includes(tab)) return Response.json({ ok: false });
    if (operation === "read") {
      await writes;
      return Response.json({ ok: true, rows: [state[tab][0], ...state[tab].slice(1).filter(row => row[0] === studentId)] });
    }
    if (operation === "append") {
      const row = request.row, operationIndex = tab === "calendar" ? 2 : 1;
      if (!Array.isArray(row) || row[0] !== studentId || row.length !== state[tab][0].length || row.some(value => typeof value !== "string")) return Response.json({ ok: false });
      // Serialize read/deduplicate/write so overlapping retries cannot lose rows.
      const appended = writes.then(async () => {
        const duplicate = state[tab].slice(1).find(item => item[0] === studentId && item[operationIndex] === row[operationIndex]);
        if (duplicate) return;
        const next = structuredClone(state);
        next[tab].push(row);
        if (!validState(next)) throw new Error("Invalid fictional state.");
        await writeState(next);
      });
      writes = appended.catch(() => {});
      await appended;
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false });
  };
  let actualPort;
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (hosted && incoming.method === "GET" && incoming.url === "/healthz") {
        outgoing.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        outgoing.end("Fictional demo ready");
        return;
      }
      const host = incoming.headers.host;
      if (host !== "127.0.0.1:" + actualPort && host !== "localhost:" + actualPort && !(hosted && host === new URL(publicOrigin).host)) {
        outgoing.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        outgoing.end("The fictional demo accepts only localhost requests.");
        return;
      }
      const method = incoming.method || "GET";
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      // Never trust forwarded visitor or Access headers on this local adapter.
      headers.delete("cf-access-jwt-assertion");
      headers.delete("cf-access-authenticated-user-email");
      headers.set("cf-connecting-ip", incoming.socket.remoteAddress || "127.0.0.1");
      const init = { method, headers };
      if (method !== "GET" && method !== "HEAD") Object.assign(init, { body: Readable.toWeb(incoming), duplex: "half" });
      const requestUrl = new URL(incoming.url || "/", publicOrigin || "http://" + host);
      if (requestUrl.origin !== (publicOrigin || "http://" + host)) {
        outgoing.writeHead(403, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        outgoing.end("The fictional demo accepts only localhost requests.");
        return;
      }
      let request = new Request(requestUrl, init);
      const preview = method === "GET" && ["/demo/sign-in", "/demo/choose"].includes(requestUrl.pathname);
      if (preview) {
        const publicHeaders = new Headers(headers);
        publicHeaders.delete("cookie");
        request = new Request(new URL("/", requestUrl), { headers: publicHeaders });
      }
      let response;
      if (method === "GET" && requestUrl.pathname === "/" && !await inviteSessionEmail(request, env)) {
        // Only the loopback demo adapter opens a fixed fictional account.
        // Issue the real Worker session; API and staff routes still authenticate.
        const account = demoAccounts[0];
        response = await worker.fetch(new Request(new URL("/sign-in", requestUrl), {
          method: "POST",
          headers: { Origin: requestUrl.origin, "CF-Connecting-IP": headers.get("cf-connecting-ip") },
          body: new URLSearchParams({ email: account.username, code: account.code })
        }), env, {});
      } else {
        response = await worker.fetch(request, env, {});
      }
      const responseHeaders = Object.fromEntries(response.headers);
      responseHeaders["X-Jarvis-Demo"] = "fictional-local-only";
      if (requestUrl.pathname === "/sign-out" && response.status === 303) responseHeaders.location = "/demo/choose";
      // HSTS is a production transport policy; local HTTP is intentional here.
      delete responseHeaders["strict-transport-security"];
      let body = Buffer.from(await response.arrayBuffer());
      if (response.headers.get("Content-Type")?.includes("text/html")) {
        let html = body.toString("utf8");
        const signedOut = !/<script\b[^>]*id=["']jarvis-fry-house-record["']/i.test(html);
        // Fixed, public fictional credentials only. Ordinary POST forms keep
        // the real sign-in flow, Origin checks and CSP in force without scripts.
        const shortcuts = '<div class="jc-demo-actions">' + demoAccounts.map((account, index) =>
          '<form method="post" action="/sign-in" class="jc-demo-account">' +
          '<input type="hidden" name="email" value="' + account.username + '">' +
          '<input type="hidden" name="code" value="' + account.code + '">' +
          '<button type="submit">Try ' + (index === 0 ? "Avery" : "Robin") + '</button></form>').join("") + '</div>';
        if (requestUrl.pathname === "/demo/choose") {
          html = html.replace(/<section class="jl-public-signin"[\s\S]*?<\/section>/,
            '<section class="jl-public-signin" id="sign-in" aria-labelledby="jc-sign-in-title">' +
            '<p class="jl-eyebrow">No account needed</p><h2 id="jc-sign-in-title">Make yourself at home.</h2>' +
            '<p>Choose a fictional boarder and explore the calendar, goals and study tools. Your demo changes stay on this computer.</p>' +
            shortcuts.replaceAll('Try ', 'Explore as ') + '</section>');
        }
        if (!signedOut) html = html.replace('>Sign out</button>', '>Demo accounts</button>');
        const activeEmail = signedOut ? "" : await inviteSessionEmail(request, env);
        const account = demoAccounts.find(item => item.email === activeEmail);
        const banner = '<aside class="jc-demo-banner" role="note">' +
          '<span>Local demo' + (account ? ' · ' + (account === demoAccounts[0] ? 'Avery' : 'Robin') : '') +
          (hosted ? ' · Shared fictional accounts · Resets on restart' : publicOrigin ? ' · Shared test accounts — use fictional notes only' : ' · Fictional records · No school services connected') + '</span>' + shortcuts + '</aside>';
        body = Buffer.from(html.replace(/(<body\b[^>]*>)/i, "$1" + banner));
      }
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.end(body);
    } catch {
      outgoing.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      outgoing.end("The fictional demo is temporarily unavailable.");
    }
  });
  try {
    await persist(state);
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, hosted ? "0.0.0.0" : "127.0.0.1", resolveListen);
    });
    actualPort = server.address().port;
  } catch (error) {
    globalThis.fetch = originalFetch;
    throw error;
  }
  const origin = "http://localhost:" + actualPort;
  if (!quiet) {
    console.log("Jarvis fictional local demo: " + origin);
    console.log("Opens directly as fictional Avery. Use the demo buttons to switch accounts; no credentials needed.");
    console.log("Fictional planner state: " + statePath);
  }
  return { server, origin, stateFile: statePath, async close() {
    await new Promise(resolveClose => server.close(resolveClose));
    await writes;
    globalThis.fetch = originalFetch;
  } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const flags = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] === "--port" && /^\d+$/.test(flags[i + 1] || "")) options.port = Number(flags[i + 1]);
    else if (flags[i] === "--state" && flags[i + 1]) options.stateFile = flags[i + 1];
    else if (flags[i] === "--public-origin" && flags[i + 1]) options.publicOrigin = flags[i + 1];
    else throw new Error("Usage: node demo-server.mjs [--port 8788] [--state /path/to/fictional-state.json] [--public-origin https://name.trycloudflare.com]");
  }
  const instance = await startDemoServer(options);
  const stop = () => instance.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
