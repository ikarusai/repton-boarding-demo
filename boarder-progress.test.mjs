import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import worker from "./worker.mjs";

test("boarder progress replays independent changes, keeps retries idempotent and isolates accounts", async () => {
  const originalFetch = globalThis.fetch;
  const workbook = "private-boarder-progress-test";
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const env = {
    JARVIS_ACCESS_AUDIENCE: "progress-test",
    JARVIS_BOARDER_LINKS: '{"first@example.invalid":"a","second@example.invalid":"b"}',
    JARVIS_PLANNER_SPREADSHEET_ID: workbook,
    JARVIS_PLANNER_CLIENT_EMAIL: "planner@example.invalid",
    JARVIS_PLANNER_PRIVATE_KEY: key
  };
  const rows = [["Student ID", "Operation ID", "Progress JSON", "Saved at"]];
  const origin = "https://jarvis.example.invalid";
  const identity = email => ({ access: { aud: env.JARVIS_ACCESS_AUDIENCE, getIdentity: async () => ({ email }) } });
  const operation = (action, payload) => ({ operationId: randomUUID(), action, ...payload });
  const request = (change, email = "first@example.invalid", requestOrigin = origin) =>
    worker.fetch(new Request(origin + "/api/boarder-progress?studentId=b", change ? {
      method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin },
      body: JSON.stringify({ ...change, studentId: "b" })
    } : {}), env, email ? identity(email) : {});
  let dropWriteResponse = false;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "test" });
    assert.match(url.href, new RegExp("/" + workbook + "/"));
    if (options.method === "POST") {
      assert.match(decodeURIComponent(url.pathname), /Boarder Progress/);
      assert.equal(url.searchParams.get("valueInputOption"), "RAW");
      rows.push(JSON.parse(options.body).values[0]);
      if (dropWriteResponse) throw new Error("Response lost after commit");
      return Response.json({ spreadsheetId: workbook, updates: { updatedRows: 1 } });
    }
    assert.deepEqual(url.searchParams.getAll("ranges"), ["'Boarder Progress'!A1:D"]);
    return Response.json({ spreadsheetId: workbook, valueRanges: [{ values: rows }] });
  };

  try {
    assert.equal((await request(null, null)).status, 403);
    assert.equal((await request(null, "unknown@example.invalid")).status, 403);
    assert.equal((await request(operation("collect-stone", { stone: "emotions" }), "first@example.invalid", "https://other.example.invalid")).status, 403);
    assert.equal((await request(operation("collect-stone", { stone: "private notes" }))).status, 400);
    assert.equal(rows.length, 1);
    const planId = randomUUID();
    const plan = { id: planId, subject: "Biology", examDate: "2026-11-20",
      sessions: [{ date: "2026-11-19", title: "Recall", minutes: 15, detail: "Practise key ideas.", done: false }] };
    assert.equal((await request({ operationId: planId, action: "create-plan", plan })).status, 200);
    assert.equal((await request(operation("set-session", { planId, date: "2026-11-19", done: true }))).status, 200);

    const focus = operation("finish-focus", { landmark: "burj", minutes: 5 });
    dropWriteResponse = true;
    assert.equal((await request(focus)).status, 503);
    dropWriteResponse = false;
    assert.equal((await request(focus)).status, 200);
    assert.equal((await request({ ...focus, minutes: 20 })).status, 409);
    assert.equal((await request(operation("collect-stone", { stone: "emotions" }))).status, 200);
    assert.equal((await request(operation("collect-stone", { stone: "emotions" }))).status, 200);
    const saved = await request();
    assert.equal(saved.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual((await saved.json()).progress, {
      plans: [{ ...plan, sessions: [{ ...plan.sessions[0], done: true }] }],
      stones: ["emotions"], study: { landmarks: ["burj"], minutes: 5 }
    });
    assert.ok(rows.slice(1).every(row => row[0] === "a"));
    assert.deepEqual((await (await request(null, "second@example.invalid")).json()).progress, {
      plans: [], stones: [], study: { landmarks: [], minutes: 0 }
    });
    assert.equal((await request(operation("remove-plan", { planId }))).status, 200);
    assert.deepEqual((await (await request()).json()).progress.plans, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
