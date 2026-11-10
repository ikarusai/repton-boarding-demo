import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { rosterSpreadsheetId } from "./google-sheets.mjs";
import worker from "./worker.mjs";

test("the Sheets bridge isolates approved boarders and deduplicates writes", async t => {
  const origin = "https://jarvis.example.invalid";
  const endpoint = "https://script.google.com/macros/s/example-deployment/exec";
  const workbook = "private-planner-example-workbook";
  const secret = randomBytes(32).toString("hex");
  const pilot = "sample-a";
  const other = "sample-b";
  const properties = new Map([
    ["JARVIS_SHEETS_BRIDGE_KEY", secret],
    ["JARVIS_SHEETS_BRIDGE_BOARDER_ID", pilot],
    ["JARVIS_SHEETS_BRIDGE_PLANNER_ID", workbook],
  ]);
  const through = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Dubai", dateStyle: "short" }).format(new Date());
  const roster = [
    [["Student ID", "Boarder", "Year group", "Term start", "Through"],
      [pilot, "Avery Example", 10, through, through], [other, "Robin Example", 10, through, through]],
    [["Event ID", "Student ID", "Event date", "Type", "Code", "Reward points"],
      ["example-event", other, through, "reward", "R1", 2]],
    [["Student ID", "Report date", "Attendance %"]],
    [["Student ID", "Subject", "Report date", "Current grade", "Target grade"]],
  ];
  const progressRows = [
    ["Student ID", "Operation ID", "Progress JSON", "Saved at"],
    [other, randomUUID(), '{"action":"collect-stone","stone":"identity"}', new Date().toISOString()],
  ];
  const calendarRows = [
    ["Student ID", "Entry ID", "Operation ID", "Action", "Previous revision", "Event JSON", "Saved at"],
  ];
  const plannerTabs = new Map([["'Boarder Progress'!A1:D", progressRows], ["'Personal Calendar'!A1:G", calendarRows]]);
  const code = await readFile(new URL("school-sheets-bridge.gs", import.meta.url), "utf8");
  const context = vm.createContext({
    JARVIS_ROSTER: rosterSpreadsheetId,
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties.get(name) }) },
    ContentService: { MimeType: { JSON: "application/json" }, createTextOutput: value => ({ setMimeType: () => value }) },
    Utilities: { Charset: { UTF_8: "UTF-8" }, computeHmacSha256Signature: (payload, key) => [...createHmac("sha256", key).update(payload).digest()] },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Sheets: { Spreadsheets: { Values: {
      batchGet(id, { ranges }) {
        if (id === rosterSpreadsheetId) return { valueRanges: roster.map(values => ({ values })) };
        assert.equal(id, workbook);
        return { valueRanges: ranges.map(range => ({ values: plannerTabs.get(range) })) };
      },
      append({ values }, id, range, options) {
        assert.equal(id, workbook);
        assert.equal(options.valueInputOption, "RAW");
        plannerTabs.get(range).push(...values);
      },
    } } },
  });
  vm.runInContext(code, context);
  const call = body => JSON.parse(context.doPost({ postData: { contents: body } }));
  const payload = JSON.stringify({ timestamp: Date.now(), operation: "roster", studentId: pilot });
  assert.deepEqual(call(JSON.stringify({ payload, signature: "0".repeat(64) })), { ok: false });
  const env = {
    JARVIS_ACCESS_AUDIENCE: "test-access",
    JARVIS_BOARDER_LINKS: JSON.stringify({ "a@example.invalid": pilot, "b@example.invalid": other }),
    JARVIS_SHEETS_BRIDGE_URL: endpoint,
    JARVIS_SHEETS_BRIDGE_KEY: secret,
    JARVIS_PLANNER_SPREADSHEET_ID: workbook,
  };
  const responses = new Map();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === endpoint) {
      assert.equal(options.method, "POST");
      const redirect = "https://script.googleusercontent.com/macros/echo?key=" + randomUUID();
      responses.set(redirect, call(options.body));
      return Response.redirect(redirect, 302);
    }
    assert.equal(options.method, undefined);
    assert.equal(options.redirect, "manual");
    assert.ok(responses.has(String(url)));
    return Response.json(responses.get(String(url)));
  });
  const session = (email = "a@example.invalid") => ({ access: {
    aud: "test-access", getIdentity: async () => ({ email }),
  } });
  const visit = (path, change, identity = session()) => worker.fetch(new Request(origin + path, change ? {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(change),
  } : {}), env, identity);

  const profile = await visit("/");
  assert.equal(profile.status, 200);
  const html = await profile.text();
  assert.match(html, /Avery Example/);
  assert.doesNotMatch(html, /Robin Example/);
  assert.equal((await visit("/api/boarder-progress", null, {})).status, 403);
  assert.equal((await visit("/api/boarder-progress", null, session("b@example.invalid"))).status, 503);
  const stone = { operationId: randomUUID(), action: "collect-stone", stone: "emotions" };
  assert.equal((await visit("/api/boarder-progress", stone)).status, 200);
  assert.equal((await visit("/api/boarder-progress", stone)).status, 200);
  assert.deepEqual((await (await visit("/api/boarder-progress")).json()).progress.stones, ["emotions"]);
  assert.equal(progressRows.length, 3);
  const calendar = await visit("/api/personal-calendar");
  assert.equal(calendar.status, 200);
  assert.deepEqual((await calendar.json()).events, []);

  properties.set("JARVIS_SHEETS_BRIDGE_BOARDER_IDS", JSON.stringify([pilot, other]));
  const secondProfile = await visit("/", null, session("b@example.invalid"));
  assert.equal(secondProfile.status, 200);
  const secondHtml = await secondProfile.text();
  assert.match(secondHtml, /Robin Example/);
  assert.doesNotMatch(secondHtml, /Avery Example/);
  assert.deepEqual((await (await visit("/api/boarder-progress?studentId=sample-a", null, session("b@example.invalid"))).json()).progress.stones, ["identity"]);
  assert.deepEqual((await (await visit("/api/boarder-progress?studentId=sample-b")).json()).progress.stones, ["emotions"]);
});
