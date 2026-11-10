import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import worker from "./worker.mjs";

test("the planner persists only the signed-in boarder's entries, including retries and concurrent edits", async t => {
  const workbook = "planner-test-workbook-id";
  const email = "planner@example.invalid";
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const env = {
    JARVIS_ACCESS_AUDIENCE: "planner-test",
    JARVIS_BOARDER_LINKS: '{"a@example.invalid":"student-a","b@example.invalid":"student-b"}',
    FRY_HOUSE_SHEETS_CLIENT_EMAIL: "reader@example.invalid",
    JARVIS_PLANNER_SPREADSHEET_ID: workbook,
    JARVIS_PLANNER_CLIENT_EMAIL: email,
    JARVIS_PLANNER_PRIVATE_KEY: key
  };
  const rows = [["Student ID", "Entry ID", "Operation ID", "Action", "Previous revision", "Event JSON", "Saved at"]];
  const sheetScope = "https://www.googleapis.com/auth/spreadsheets";
  let loseAppendResponse = false;
  let waitForCompetingAppend = false;
  let releaseAppend;
  const google = t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") {
      const assertion = options.body.get("assertion").split(".");
      const { iss, scope } = JSON.parse(Buffer.from(assertion[1], "base64url").toString());
      assert.equal(iss, email);
      assert.ok([sheetScope, sheetScope + ".readonly"].includes(scope));
      return Response.json({ access_token: scope });
    }
    assert.equal(url.hostname, "sheets.googleapis.com");
    assert.equal(url.pathname.split("/")[3], workbook);
    if (options.method === "POST") {
      assert.match(decodeURIComponent(url.pathname), /Personal Calendar'!A1:G:append$/);
      assert.equal(options.headers.Authorization, "Bearer " + sheetScope);
      assert.equal(url.searchParams.get("valueInputOption"), "RAW");
      assert.equal(url.searchParams.get("insertDataOption"), "INSERT_ROWS");
      const [row] = JSON.parse(options.body).values;
      if (waitForCompetingAppend) {
        if (releaseAppend) {
          waitForCompetingAppend = false;
          releaseAppend();
        } else {
          await new Promise(resolve => { releaseAppend = resolve; });
        }
      }
      rows.push(row);
      if (loseAppendResponse) {
        loseAppendResponse = false;
        throw new Error("Connection dropped after Google committed the row");
      }
      return Response.json({ spreadsheetId: workbook, updates: { updatedRows: 1 } });
    }
    assert.deepEqual(url.searchParams.getAll("ranges"), ["'Personal Calendar'!A1:G"]);
    return Response.json({ spreadsheetId: workbook, valueRanges: [{ values: rows }] });
  });

  const url = "https://pilot.example.invalid/api/personal-calendar?studentId=student-b";
  const caller = email => ({ access: { aud: env.JARVIS_ACCESS_AUDIENCE, getIdentity: async () => ({ email }) } });
  const read = (email, deployment = env) => worker.fetch(new Request(url), deployment, email ? caller(email) : {});
  const write = (email, operation, origin = new URL(url).origin) => worker.fetch(new Request(url, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(operation)
  }), env, caller(email));
  const create = event => ({ action: "create", id: randomUUID(), operationId: randomUUID(), previous: "", event });

  assert.equal((await read(null)).status, 403);
  assert.equal((await read("unlinked@example.invalid")).status, 403);
  assert.equal((await read("a@example.invalid", { ...env, JARVIS_PLANNER_CLIENT_EMAIL: env.FRY_HOUSE_SHEETS_CLIENT_EMAIL })).status, 503);
  const reminder = create({ title: "Bring boots", category: "reminder", date: "2026-11-10" });
  assert.equal((await write("a@example.invalid", reminder, "https://different.invalid")).status, 403);
  assert.equal(google.mock.callCount(), 0);

  assert.equal((await write("a@example.invalid", { ...reminder, studentId: "student-b" })).status, 200);
  assert.equal(rows[1][0], "student-a");
  const deadline = create({ title: "Maths homework", category: "deadline", date: "2026-11-12" });
  assert.equal((await write("a@example.invalid", deadline)).status, 200);
  const training = create({ title: "Rugby", category: "training", date: "2026-11-10", time: "16:00", end: "17:00",
    repeatDays: [2, 5], repeatUntil: "2026-11-20" });
  loseAppendResponse = true;
  assert.equal((await write("a@example.invalid", training)).status, 503);
  assert.equal((await write("a@example.invalid", training)).status, 200);
  assert.equal(rows.length, 4);

  const secondDevice = await (await read("a@example.invalid")).json();
  assert.deepEqual(secondDevice.events.map(event => event.title), ["Bring boots", "Maths homework", "Rugby"]);
  const saved = secondDevice.events[2];
  assert.deepEqual(saved.repeatDays, [2, 5]);
  assert.deepEqual(await (await read("b@example.invalid")).json(), { events: [] });

  const edit = { action: "edit", id: saved.id, operationId: randomUUID(), previous: saved.revision,
    event: { ...saved, title: "Rugby on pitch 2" } };
  assert.equal((await write("b@example.invalid", edit)).status, 409);
  assert.equal(rows.length, 4);

  waitForCompetingAppend = true;
  const alternate = { ...edit, operationId: randomUUID(), event: { ...saved, title: "Rugby on pitch 3" } };
  const competing = await Promise.all([write("a@example.invalid", edit), write("a@example.invalid", alternate)]);
  assert.deepEqual(competing.map(response => response.status).sort(), [200, 409]);
  const updated = (await (await read("a@example.invalid")).json()).events[2];
  assert.ok(["Rugby on pitch 2", "Rugby on pitch 3"].includes(updated.title));
  const remove = { action: "remove", id: updated.id, operationId: randomUUID(), previous: updated.revision };
  assert.equal((await write("b@example.invalid", remove)).status, 409);
  assert.equal((await write("a@example.invalid", remove)).status, 200);
  assert.deepEqual((await (await read("a@example.invalid")).json()).events.map(event => event.title),
    ["Bring boots", "Maths homework"]);
});
