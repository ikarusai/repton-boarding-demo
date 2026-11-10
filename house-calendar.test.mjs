import assert from "node:assert/strict";
import test from "node:test";
import { dateCell } from "./google-sheets.mjs";
import { houseCalendarEvents, projectHouseCalendar } from "./house-calendar.mjs";
import { readFryHouseProfile } from "./performance.mjs";
import { projectSharedCalendar } from "./shared-calendar.mjs";

test("the six-page house plan preserves date-only events, uncertainty and birthday approval boundaries", () => {
  const calendar = projectHouseCalendar(10);
  assert.equal(calendar.events.length, 30);
  assert.equal(new Set(calendar.events.map(event => event.id)).size, 30);
  assert.deepEqual([...new Set(calendar.events.map(event => event.sourcePage))], [1, 2, 3, 4, 5, 6]);
  assert.equal(calendar.schoolVerified, false);
  assert.equal(calendar.omittedBirthdayEntries, 18);
  assert.equal(calendar.omittedBirthdayMentions, 21);
  assert.ok(calendar.events.every(event => dateCell(event.date) === event.date && !event.time && !event.end));
  assert.ok(calendar.events.every(event => event.date >= calendar.coverage.start && (event.through || event.date) <= calendar.coverage.end));
  assert.ok(calendar.events.every(event => event.category !== "birthday"));
  assert.equal(calendar.events.find(event => event.date === "2027-03-08").through, "2027-03-12");
  assert.equal(calendar.events.find(event => event.date === "2027-05-17").through, "2027-05-18");
  assert.deepEqual(calendar.events.filter(event => event.tentative).map(event => event.date),
    ["2027-03-08", "2027-03-22", "2027-05-17", "2027-06-05"]);
  assert.match(calendar.events.find(event => event.date === "2027-03-22").detail, /faint handwritten/);
  assert.equal(calendar.events.find(event => event.date === "2027-02-24").title, "Global Village");
  assert.equal(calendar.events.find(event => event.date === "2027-06-27").title, "Legoland Waterpark");
  for (const year of [7, 8, 9, 10, 11, 12, 13]) assert.equal(projectHouseCalendar(year).events.length, 30);
  for (const year of [6, 14, undefined, "all", "10", 10.5]) assert.deepEqual(projectHouseCalendar(year).events, []);
  calendar.events[0].title = "Changed locally";
  assert.equal(houseCalendarEvents[0].title, "Holiday");
});

test("reviewed school sources replace supplied plan entries without reviving cancellations or other years", () => {
  const shared = projectSharedCalendar([
    [["Source", "Last reviewed"], ["boarding", "2026-11-09"], ["birthdays", "2026-11-09"]],
    [["Source", "Date", "Through", "Start", "End", "Title", "Category", "Years", "Approved"],
      ["boarding", "2027-02-07", "", "", "", "Year 12 outing", "trip", "12", "yes"],
      ["birthdays", "2027-02-07", "", "", "", "Avery Example birthday", "birthday", "10", "yes"],
      ["birthdays", "2027-02-08", "", "", "", "Unapproved birthday", "birthday", "10", "no"]]
  ], 10);
  const fallback = projectHouseCalendar(10, shared);
  assert.ok(fallback.events.every(event => event.source === "term-dates"));
  assert.deepEqual(fallback.replacedSources, ["boarding"]);
  assert.deepEqual(shared.events.map(event => event.title), ["Avery Example birthday"]);
  assert.equal(projectHouseCalendar(10, { sources: { boarding: "2026-11-09", "term-dates": "2026-11-09" }, events: [] }).events.length, 0);
  assert.equal(projectHouseCalendar(10, { unavailable: true, sources: {} }).events.length, 30);
  assert.equal(projectHouseCalendar(10, { sources: { boarding: "2027-02-30" } }).events.length, 30);
});

test("a bridge-only boarder profile includes the supplied plan and no second boarder records", async t => {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Dubai", dateStyle: "short" }).format(new Date());
  const roster = [
    [["Student ID", "Boarder", "Year group", "Term start", "Through"],
      ["sample-a", "Avery Example", 10, today, today], ["sample-b", "Robin Example", 12, today, today]],
    [["Event ID", "Student ID", "Event date", "Type", "Code", "Reward points"]],
    [["Student ID", "Report date", "Attendance %"]],
    [["Student ID", "Subject", "Report date", "Current grade", "Target grade"]]
  ];
  const fetch = t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.equal(String(input), "https://script.google.com/macros/s/fictional-calendar-test/exec");
    const body = JSON.parse(JSON.parse(options.body).payload);
    assert.equal(body.operation, "roster");
    assert.equal(body.studentId, "sample-a");
    return Response.json({ ok: true, roster });
  });
  const profile = await readFryHouseProfile("sample-a", {
    JARVIS_SHEETS_BRIDGE_URL: "https://script.google.com/macros/s/fictional-calendar-test/exec",
    JARVIS_SHEETS_BRIDGE_KEY: "a".repeat(64)
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(profile.name, "Avery Example");
  assert.equal(profile.houseCalendar.events.length, 30);
  assert.doesNotMatch(JSON.stringify(profile), /Robin Example|sample-b/);
  assert.equal(profile.sharedCalendar, undefined);
});
