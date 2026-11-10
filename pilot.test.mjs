import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import worker from "./worker.mjs";
import { rosterSpreadsheetId } from "./google-sheets.mjs";
import { boarderIdForEmail, projectJarvisRoster } from "./performance.mjs";

const date = days => new Date(Date.UTC(2026, 10, 9 + days)).toISOString().slice(0, 10);
const now = new Date("2026-11-12T10:00:00+04:00");
const calendarId = "test-shared-calendar-book";
const recognitionId = "test-house-recognition-book";
const photoId = "approved-private-photo";
const hiddenPhoto = "unapproved-private-photo";
const recognitionRows = [
  [["Student ID", "Display name", "Show points", "Show streak", "Photo file ID", "Show photo"],
    ["sample-a", "Avery E.", "yes", "yes", photoId, "yes"],
    ["sample-b", "Private display name", "no", "no", hiddenPhoto, "yes"]],
  [["Date"], [date(0)], [date(1)], [date(2)], [date(3)]],
  [["Student ID", "Date", "Result"],
    ["sample-a", date(0), "on-time"], ["sample-a", date(1), "excused"],
    ["sample-a", date(2), "on-time"], ["sample-a", date(3), "on-time"]]
];
const calendarRows = [
  [["Source", "Last reviewed"], ["myrepton", date(2)], ["boarding", date(3)], ["birthdays", date(3)]],
  [["Source", "Date", "Through", "Start", "End", "Title", "Category", "Years", "Approved"],
    ["myrepton", date(3), "", "14:00", "15:00", "Year 10 rehearsal", "school-event", 10, "yes"],
    ["myrepton", date(3), "", "", "", "Sixth form fixture", "fixture", "12,13", "yes"],
    ["boarding", date(5), date(6), "", "", "Fry House beach trip", "trip", "all", "yes"],
    ["boarding", date(4), "", "", "", "Unapproved trip", "trip", "all", "no"],
    ["boarding", date(4), "", "", "", "Unknown audience", "trip", "7,all", "yes"],
    ["birthdays", date(4), "", "", "", "Avery’s birthday", "birthday", 10, "yes"],
    ["term-dates", date(4), "", "", "", "Unreviewed closure", "holiday", "all", "yes"]]
];
const timetableDate = (Date.UTC(2026, 10, 11) - Date.UTC(1899, 11, 30)) / 86_400_000;
const rows = [
  [["Student ID", "Boarder", "Year group", "Term start", "Through"],
    ["sample-a", "Avery Example", "Year 10", date(-10), date(3)],
    ["sample-b", "Robin Example", 12, date(-10), date(3)]],
  [["Event ID", "Student ID", "Event date", "Type", "Code", "Reward points"],
    ["old", "sample-a", date(-11), "reward", "R1", 5],
    ["one", "sample-a", date(1), "reward", "R1", 3],
    ["two", "sample-b", date(1), "reward", "R3", 27],
    ["three", "sample-a", date(2), "sanction", "B2", ""]],
  [["Student ID", "Report date", "Attendance %"], ["sample-a", date(1), 96.8], ["sample-b", date(1), 92.1]],
  [["Student ID", "Subject", "Report date", "Current grade", "Target grade"],
    ["sample-a", "Algebra", date(1), 5, 6], ["sample-b", "Robotics", date(2), "A", "A*"]],
  [["Student ID", "Date", "Start", "End", "Title", "Category", "Location"],
    ["sample-a", timetableDate, 8.25 / 24, "09:05", "Algebra", "school", "R14"],
    ["sample-a", timetableDate, "09:15", "10:05", "Free period", "free", ""],
    ["sample-a", date(4), "14:45", "15:45", "Rugby training", "training", "Pitch 1"],
    ["sample-b", timetableDate, "13:15", "14:05", "Robotics", "school", "Lab 4"]]
];

test("roster projects only the requested student's term, reports and dated timetable", () => {
  const result = projectJarvisRoster(rows, "sample-a", now);
  assert.equal(result.year, 10);
  assert.deepEqual(result.rewards, [[date(1), 3, "R1"]]);
  assert.deepEqual(result.sanctions, [[date(2), "B2"]]);
  assert.deepEqual(result.reports.attendance, [{ date: date(1), percent: 96.8 }]);
  assert.deepEqual(result.reports.subjects, [{ subject: "Algebra", date: date(1), current: "5", target: "6" }]);
  assert.deepEqual(result.timetable.map(({ date, time, title }) => [date, time, title]),
    [[date(2), "08:15", "Algebra"], [date(2), "09:15", "Free period"], [date(4), "14:45", "Rugby training"]]);
  assert.equal(projectJarvisRoster(rows.slice(0, 4), "sample-a", now).timetable.length, 0);
  assert.equal(projectJarvisRoster(rows, "missing", now), null);
  const shifted = structuredClone(rows);
  shifted[4][0][0] = "Name";
  assert.throws(() => projectJarvisRoster(shifted, "sample-a", now), /headers/);
});

test("duplicate IDs or account aliases do not resolve", () => {
  assert.equal(boarderIdForEmail('{"a@example.invalid":"sample-a","b@example.invalid":" sample-a "}', "a@example.invalid"), null);
  assert.equal(boarderIdForEmail('{"a@example.invalid":"sample-a","A@example.invalid":"sample-b"}', "a@example.invalid"), null);
});

test("Worker rejects unauthorised requests and delivers only the signed-in boarder's record", async t => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const env = {
    JARVIS_ACCESS_AUDIENCE: "test-only", JARVIS_TIMETABLE_ENABLED: "true",
    JARVIS_CALENDAR_SPREADSHEET_ID: calendarId,
    JARVIS_RECOGNITION_SPREADSHEET_ID: recognitionId,
    JARVIS_STAFF_EMAILS: '["tutor@example.invalid"]',
    JARVIS_HELP_CONTACTS: '{"duty":{"instructions":"Test duty desk","phone":"+12025550123"},"backup":{"instructions":"Test backup desk","phone":"javascript:alert(1)"}}',
    JARVIS_BOARDER_LINKS: '{"a@example.invalid":"sample-a","b@example.invalid":"sample-b"}',
    FRY_HOUSE_SHEETS_CLIENT_EMAIL: "reader@example.invalid", FRY_HOUSE_SHEETS_PRIVATE_KEY: pem
  };
  let calendarAvailable = true;
  const sharedRows = structuredClone(calendarRows);
  const houseRows = structuredClone(recognitionRows);
  const fetch = t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.href === "https://oauth2.googleapis.com/token") {
      assert.equal(init.method, "POST");
      const jwt = init.body.get("assertion").split(".");
      const { scope } = JSON.parse(Buffer.from(jwt[1], "base64url"));
      assert.ok(["https://www.googleapis.com/auth/spreadsheets.readonly", "https://www.googleapis.com/auth/drive.readonly"].includes(scope));
      return Response.json({ access_token: scope.endsWith("drive.readonly") ? "fake-drive-token" : "fake-local-token" });
    }
    if (url.host === "www.googleapis.com") {
      assert.equal(url.pathname, "/drive/v3/files/" + photoId);
      assert.equal(init.headers.Authorization, "Bearer fake-drive-token");
      return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "Content-Type": "image/jpeg" } });
    }
    assert.equal(url.host, "sheets.googleapis.com");
    assert.equal(init.headers.Authorization, "Bearer fake-local-token");
    const ranges = url.searchParams.getAll("ranges");
    if (url.pathname.includes(recognitionId)) {
      const expected = ["'Recognition'!A1:F", "'Roll Call Sessions'!A1:A", "'Morning Roll Call'!A1:C"];
      assert.deepEqual(ranges, ranges.length === 1 ? expected.slice(0, 1) : expected);
      return Response.json({ spreadsheetId: recognitionId, valueRanges: houseRows.slice(0, ranges.length).map(values => ({ values })) });
    }
    if (url.pathname.includes(calendarId)) {
      assert.deepEqual(ranges, ["'Calendar Sources'!A1:B", "'Calendar Events'!A1:I"]);
      if (!calendarAvailable) return new Response(null, { status: 403 });
      return Response.json({ spreadsheetId: calendarId, valueRanges: sharedRows.map(values => ({ values })) });
    }
    assert.equal(url.pathname, "/v4/spreadsheets/" + rosterSpreadsheetId + "/values:batchGet");
    assert.equal(ranges.at(-1), ranges.length === 2 ? "'Behaviour Events'!A1:F" : "'Student Timetable'!A1:G");
    return Response.json({ spreadsheetId: url.pathname.split("/")[3], valueRanges: rows.slice(0, ranges.length).map(values => ({ values })) });
  });
  const request = new Request("https://pilot.example.invalid/?studentId=sample-b");
  const identity = (email, aud = "test-only") => ({ access: { aud, getIdentity: async () => ({ email }) } });
  assert.equal((await worker.fetch(request, env, {})).status, 403);
  const claimedSchoolIdentity = new Request(request.url, {
    headers: { "Cf-Access-Authenticated-User-Email": "a@example.invalid" }
  });
  assert.equal((await worker.fetch(claimedSchoolIdentity, env, {})).status, 403);
  assert.equal((await worker.fetch(request, env, identity("a@example.invalid", "wrong"))).status, 403);
  assert.equal((await worker.fetch(request, env, identity("unknown@example.invalid"))).status, 403);
  assert.equal(fetch.mock.callCount(), 0);
  const [a, b] = await Promise.all([
    worker.fetch(request, env, identity("A@EXAMPLE.INVALID")),
    worker.fetch(request, env, identity("b@example.invalid"))
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.headers.get("Cache-Control"), "private, no-store");
  const html = await a.text(), other = await b.text();
  assert.match(html, /Avery Example/);
  assert.match(html, /"helpContacts":\{"duty":\{"instructions":"Test duty desk","phone":"\+12025550123"\},"backup":\{"instructions":"Test backup desk"\}\}/);
  assert.match(html, /"rewards":\[\["2026-11-10",3,"R1"\]\]/);
  assert.match(html, /Rugby training/);
  assert.doesNotMatch(html, /Robin Example|Robotics","date|sample-b|reader@example.invalid|fake-local-token/);
  assert.match(other, /Robin Example/);
  assert.match(other, /Robotics/);
  assert.doesNotMatch(other, /Avery Example|"R14"|sample-a/);
  assert.match(html, /Year 10 rehearsal/);
  assert.match(html, /Avery’s birthday/);
  assert.doesNotMatch(html, /Sixth form fixture|Unapproved trip|Unknown audience|Unreviewed closure/);
  assert.match(other, /Sixth form fixture/);
  assert.doesNotMatch(other, /Year 10 rehearsal|Avery’s birthday/);
  assert.match(html, /Fry House beach trip/);
  assert.match(other, /Fry House beach trip/);
  assert.match(other, /"ranks":\[\{"name":"Avery E.","points":3,"photo":"\/house\/photo\/approved-private-photo"\}\]/);
  assert.match(other, /"streaks":\[\{"name":"Avery E.","count":3\}\]/);
  const otherRecord = other.match(/id="jarvis-fry-house-record" type="application\/json">([^<]*)<\/script>/)[1];
  assert.doesNotMatch(otherRecord, /"B2"|Private display name|unapproved-private-photo/);
  const sanctionsRequest = new Request(new URL("/staff/sanctions", request.url));
  assert.equal((await worker.fetch(sanctionsRequest, env, identity("b@example.invalid"))).status, 403);
  const staff = await worker.fetch(sanctionsRequest, env, identity("tutor@example.invalid"));
  assert.equal(staff.status, 200);
  assert.match(await staff.text(), /Avery Example<\/th><td>10<\/td><td>0<\/td><td>1<\/td>/);
  const photoRequest = new Request(new URL("/house/photo/" + photoId, request.url));
  assert.equal((await worker.fetch(photoRequest, env, {})).status, 403);
  const photo = await worker.fetch(photoRequest, env, identity("b@example.invalid"));
  assert.equal(photo.headers.get("Content-Type"), "image/jpeg");
  const rejectedPhoto = new Request(new URL("/house/photo/" + hiddenPhoto, request.url));
  assert.equal((await worker.fetch(rejectedPhoto, env, identity("b@example.invalid"))).status, 404);
  houseRows[2].splice(-1); // The latest scheduled roll call is missing for Avery.
  sharedRows[1].find(row => row[5] === "Fry House beach trip")[5] = "Fry House museum trip";
  const refreshed = await worker.fetch(request, env, identity("a@example.invalid"));
  const refreshedHtml = await refreshed.text();
  assert.match(refreshedHtml, /Fry House museum trip/);
  assert.match(refreshedHtml, /"streaks":\[\]/);
  assert.doesNotMatch(refreshedHtml, /Fry House beach trip/);
  calendarAvailable = false;
  const offline = await worker.fetch(request, env, identity("a@example.invalid"));
  assert.equal(offline.status, 200);
  assert.match(await offline.text(), /"unavailable":true/);
  if (process.env.JARVIS_TEST_HTML) await writeFile(process.env.JARVIS_TEST_HTML, html);
});
