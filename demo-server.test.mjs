import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { get } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startDemoServer } from "./demo-server.mjs";
import { demoAccounts } from "./demo-fixtures.mjs";

test("the localhost demo uses real Worker routes with fictional isolation and restart persistence", async t => {
  const networkFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), "jarvis-demo-test-"));
  const stateFile = join(directory, "state.json");
  let instance;
  t.after(async () => {
    if (instance) await instance.close();
    await rm(directory, { recursive: true, force: true });
  });
  instance = await startDemoServer({ port: 0, stateFile, quiet: true });
  const visit = (path, options) => networkFetch(instance.origin + path, { redirect: "manual", ...options });
  const login = async account => {
    const response = await visit("/sign-in", { method: "POST", headers: { Origin: instance.origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: account.username, code: account.code }) });
    assert.equal(response.status, 303);
    assert.match(response.headers.get("Set-Cookie"), /Secure; HttpOnly; SameSite=Strict/);
    return response.headers.get("Set-Cookie").split(";")[0];
  };
  const publicPage = await visit("/demo/sign-in");
  assert.equal(publicPage.status, 200);
  assert.equal(publicPage.headers.get("X-Jarvis-Demo"), "fictional-local-only");
  const publicHtml = await publicPage.text();
  assert.match(publicHtml, /Local demo/);
  assert.match(publicHtml, /<form method="post" action="\/sign-in" class="jc-demo-account">/);
  assert.match(publicHtml, /<button type="submit">Try Avery<\/button>/);
  assert.match(publicHtml, /<button type="submit">Try Robin<\/button>/);
  for (const account of demoAccounts) assert.ok(publicHtml.includes('type="hidden" name="code" value="' + account.code + '"'));
  const hostileHostStatus = await new Promise((resolve, reject) => {
    get(instance.origin, { headers: { Host: "not-local.example" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await visit("/api/personal-calendar")).status, 403);
  const a = await login(demoAccounts[0]);
  const b = await login(demoAccounts[1]);
  const page = await visit("/", { headers: { Cookie: a } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<button type="submit">Try Avery<\/button>/);
  assert.match(html, /<button type="submit">Try Robin<\/button>/);
  const profile = JSON.parse(html.match(/id="jarvis-fry-house-record" type="application\/json">([^<]*)<\/script>/)[1]);
  assert.equal(profile.name, "Avery Example");
  assert.equal(profile.houseCalendar.events.length, 30);
  assert.doesNotMatch(JSON.stringify(profile), /Robin Example|demo-robin/);
  const change = { action: "create", id: randomUUID(), operationId: randomUUID(), previous: "", event: {
    title: "Fictional study slot", category: "personal", date: "2027-01-10", time: "14:00", end: "14:30", detail: "Demo test"
  } };
  const save = (origin = instance.origin) => visit("/api/personal-calendar", { method: "POST", headers: { Cookie: a, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(change) });
  assert.equal((await save("https://untrusted.example")).status, 403);
  assert.equal((await save()).status, 200);
  assert.equal((await save()).status, 200);
  const read = async cookie => (await (await visit("/api/personal-calendar?studentId=demo-avery", { headers: { Cookie: cookie } })).json()).events;
  assert.equal((await read(a)).length, 1);
  assert.deepEqual(await read(b), []);
  assert.equal((await visit("/staff/sanctions", { headers: { Cookie: a } })).status, 403);
  const stored = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(stored.calendar.length, 2);
  assert.equal(stored.calendar[1][0], "demo-avery");
  assert.doesNotMatch(JSON.stringify(stored), /SESSION_SECRET|BRIDGE_KEY|DEMO_AVERY/);
  const parallelChanges = ["One", "Two"].map(label => ({ ...change, id: randomUUID(), operationId: randomUUID(),
    event: { ...change.event, title: "Concurrent fictional slot " + label } }));
  const results = await Promise.all([...parallelChanges, ...parallelChanges].map(operation =>
    visit("/api/personal-calendar", { method: "POST", headers: { Cookie: a, Origin: instance.origin, "Content-Type": "application/json" },
      body: JSON.stringify(operation) })));
  assert.ok(results.every(response => response.status === 200));
  assert.equal((await read(a)).length, 3);
  assert.deepEqual(await read(b), []);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).calendar.length, 4);
  // A second process must be rejected before loading/rewriting our state.
  const beforeSecondProcess = await readFile(stateFile, "utf8");
  const second = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    "import { startDemoServer } from './demo-server.mjs'; try { const instance = await startDemoServer({port: 0, stateFile: process.argv[1], quiet:true}); await instance.close(); process.exitCode=1; } catch (error) { if (!error.message.includes('locked by another demo process')) throw error; }", stateFile],
  { cwd: new URL(".", import.meta.url) });
  assert.equal(second.stderr, "");
  assert.equal(await readFile(stateFile, "utf8"), beforeSecondProcess);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  await instance.close();
  instance = null;
  instance = await startDemoServer({ port: 0, stateFile, quiet: true });
  const freshA = await login(demoAccounts[0]);
  assert.equal((await read(freshA))[0].title, "Fictional study slot");
  await assert.rejects(globalThis.fetch("https://example.invalid"), /blocks all external service requests/);
});

test("demo opens without credentials, remembers account choice and keeps APIs authenticated", async t => {
  const networkFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), "jarvis-demo-access-"));
  const instance = await startDemoServer({ port: 0, stateFile: join(directory, "state.json"), quiet: true });
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  const visit = (path, options) => networkFetch(instance.origin + path, { redirect: "manual", ...options });
  const profileOf = html => JSON.parse(html.match(/id="jarvis-fry-house-record" type="application\/json">([^<]*)<\/script>/)[1]);
  for (const path of ["/api/personal-calendar", "/api/boarder-goals", "/api/boarder-progress", "/staff/sanctions"]) {
    const denied = await visit(path);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("Set-Cookie"), null);
  }
  const automatic = await visit("/");
  assert.equal(automatic.status, 303);
  assert.equal(automatic.headers.get("Location"), "/");
  assert.match(automatic.headers.get("Set-Cookie"), /Secure; HttpOnly; SameSite=Strict/);
  const averyCookie = automatic.headers.get("Set-Cookie").split(";")[0];
  assert.equal(profileOf(await (await visit("/", { headers: { Cookie: averyCookie } })).text()).name, "Avery Example");
  const invalidCookie = await visit("/", { headers: { Cookie: "__Host-jarvis-session=stale.invalid" } });
  assert.equal(invalidCookie.status, 303);
  assert.ok(invalidCookie.headers.get("Set-Cookie"));
  const robin = await visit("/sign-in", { method: "POST", headers: { Origin: instance.origin },
    body: new URLSearchParams({ email: demoAccounts[1].username, code: demoAccounts[1].code }) });
  assert.equal(robin.status, 303);
  const robinCookie = robin.headers.get("Set-Cookie").split(";")[0];
  const remembered = await visit("/", { headers: { Cookie: robinCookie } });
  assert.equal(remembered.status, 200);
  assert.equal(remembered.headers.get("Set-Cookie"), null);
  assert.equal(profileOf(await remembered.text()).name, "Robin Example");
  const preview = await visit("/demo/sign-in", { headers: { Cookie: robinCookie } });
  assert.equal(preview.status, 200);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /type="password"/);
  assert.doesNotMatch(previewHtml, /<script\b[^>]*id="jarvis-fry-house-record"/);
  assert.equal((await visit("/sign-out", { method: "POST", headers: { Cookie: robinCookie, Origin: "https://untrusted.example" } })).status, 403);
  const signOut = await visit("/sign-out", { method: "POST", headers: { Cookie: robinCookie, Origin: instance.origin } });
  assert.equal(signOut.status, 303);
  assert.equal(signOut.headers.get("Location"), "/demo/choose");
  assert.match(signOut.headers.get("Set-Cookie"), /Max-Age=0/);
  const chooser = await visit("/demo/choose");
  assert.equal(chooser.status, 200);
  const chooserHtml = await chooser.text();
  assert.match(chooserHtml, /Try Avery/);
  assert.match(chooserHtml, /Try Robin/);
  assert.doesNotMatch(chooserHtml, /<input\b[^>]*type="password"/);
  assert.doesNotMatch(chooserHtml, /<script\b[^>]*id="jarvis-fry-house-record"/);
  assert.equal(chooser.headers.get("Set-Cookie"), null);
});

test("demo startup reserves one process owner, releases locks on failure and closes idempotently", async t => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-demo-ownership-"));
  const stateFile = join(directory, "state.json");
  const originalFetch = globalThis.fetch;
  let instance;
  t.after(async () => { if (instance) await instance.close(); await rm(directory, { recursive: true, force: true }); });
  const first = startDemoServer({ port: 0, stateFile, quiet: true });
  await assert.rejects(startDemoServer({ port: 0, stateFile, quiet: true }), /Only one fictional demo server/);
  instance = await first;
  await Promise.all([instance.close(), instance.close()]);
  instance = null;
  assert.equal(globalThis.fetch, originalFetch);
  await assert.rejects(stat(stateFile + ".lock"), { code: "ENOENT" });

  await writeFile(stateFile, "not-json");
  await assert.rejects(startDemoServer({ port: 0, stateFile, quiet: true }), SyntaxError);
  assert.equal(globalThis.fetch, originalFetch);
  await assert.rejects(stat(stateFile + ".lock"), { code: "ENOENT" });
});

test('shared demo uses the explicit HTTPS origin and retains mutation checks', async t => {
  const networkFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-shared-test-'));
  const publicOrigin = 'https://fictional-test.trycloudflare.com';
  const instance = await startDemoServer({port:0,stateFile:join(directory,'state.json'),quiet:true,publicOrigin});
  t.after(async()=>{await instance.close();await rm(directory,{recursive:true,force:true});});
  const visit = (path, options={}) => networkFetch(instance.origin+path,{redirect:'manual',...options});
  const entry = await visit('/');
  assert.equal(entry.status,303);
  const cookie = entry.headers.get('set-cookie').split(';')[0];
  assert.match(await (await visit('/',{headers:{Cookie:cookie}})).text(),/Shared test accounts/);
  const operation = {action:'create',id:randomUUID(),operationId:randomUUID(),previous:'',event:{title:'Public fictional test',category:'personal',date:'2027-01-10',time:'14:00',end:'14:30',detail:'Test'}};
  const save = origin => visit('/api/personal-calendar',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(operation)});
  assert.equal((await save('https://unrelated.example')).status,403);
  assert.equal((await save(publicOrigin)).status,200);
  assert.equal((await visit('/staff/sanctions',{headers:{Cookie:cookie}})).status,403);
});

test('hosted demo validates its origin, serves health checks and accepts only its configured public Host', async t => {
  const networkFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-hosted-test-'));
  const stateFile = join(directory,'state.json');
  await assert.rejects(startDemoServer({port:0,stateFile,quiet:true,hosted:true,publicOrigin:'https://unrelated.example'}), /exact Render HTTPS origin/);
  const publicOrigin = 'https://repton-boarding-demo.onrender.com';
  const instance = await startDemoServer({port:0,stateFile,quiet:true,hosted:true,publicOrigin});
  t.after(async()=>{await instance.close();await rm(directory,{recursive:true,force:true});});
  const visit=(path,options={})=>networkFetch(instance.origin+path,{redirect:'manual',...options});
  const hostVisit = (host, cookie = '') => new Promise((resolve, reject) => {
    get(instance.origin, {headers:{Host:host,Cookie:cookie}}, response => {
      const chunks=[]; response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
    }).on('error',reject);
  });
  assert.equal((await visit('/healthz')).status,200);
  assert.equal((await hostVisit('unrelated.example')).status,403);
  const entry=await hostVisit(new URL(publicOrigin).host);
  assert.equal(entry.status,303);
  const cookie=entry.headers.get('set-cookie').split(';')[0];
  const page=await hostVisit(new URL(publicOrigin).host,cookie);
  assert.match(await page.text(),/Shared fictional accounts · Resets on restart/);
  assert.equal((await visit('/api/boarder-goals')).status,403);
  const operation={action:'create',id:randomUUID(),operationId:randomUUID(),previous:'',event:{title:'Hosted fictional test',category:'personal',date:'2027-01-10',time:'14:00',end:'14:30',detail:'Test'}};
  const save=origin=>visit('/api/personal-calendar',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(operation)});
  assert.equal((await save('https://unrelated.example')).status,403);
  assert.equal((await save(publicOrigin)).status,200);
});
