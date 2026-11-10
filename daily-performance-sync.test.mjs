import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("./daily-performance-sync.gs", import.meta.url), "utf8");
const roster = [["a", "Avery", 9, "2026-08-31", "2026-11-05"], ["b", "Robin", 10, "2026-08-31", "2026-11-05"]];
const students = [
  ["a", "external-1", "Avery", "", "", 9, "Fry", "Boarder", true],
  ["b", "external-2", "Robin", "", "", 10, "Fry", "Boarder", true],
  ["c", "external-3", "Drew", "", "", 9, "Fry", "Boarder", true]
];
const events = [
  ["reward-1", "a", "2026-11-06", "", "R1", "reward"],
  ["reward-1", "a", "2026-11-06", "", "R1", "reward"],
  ["sanction-2", "b", "2026-11-05", "", "B2", "sanction"],
  ["unapproved", "c", "2026-11-06", "", "R1", "reward"]
];
const days = [["2026-08-31", true, "Autumn", "2026/27"]];
const academic = [
  { studentId: "a", date: "2026-11-06", subject: "Whole-school settling and engagement", note: "Attendance 94.5%. Internal text." },
  { studentId: "a", date: "2026-11-06", subject: "Maths", currentGrade: "5", createdAt: "2026-11-06T08:00:00Z" },
  { studentId: "a", date: "2026-11-06", subject: "Maths", currentGrade: "6", targetGrade: "7", createdAt: "2026-11-06T09:00:00Z" },
  { studentId: "c", date: "2026-11-06", subject: "Science", currentGrade: "8" }
];
const settings = [["weight_R1", "2"], ["academic_records_chunks", 1], ["academic_records_000", JSON.stringify(academic)]];
const initial = [roster, [["reward-1", "a", "2026-11-06", "reward", "R1", 1]], [], [["a", "English", "2026-10-12", "6", "7"]]];
const toPlain = value => JSON.parse(JSON.stringify(value));

test("refresh maps only approved IDs, handles corrections and repeats without duplicates", () => {
  const project = runInNewContext(script + "\nprojectJarvisDaily_");
  const result = project(students, events, days, settings, initial, "2026-11-08");
  assert.equal(result.coverage, "2026-11-06");
  assert.deepEqual(toPlain(result), [
    roster.map(row => [...row.slice(0, 4), "2026-11-06"]),
    [["reward-1", "a", "2026-11-06", "reward", "R1", 2], ["sanction-2", "b", "2026-11-05", "sanction", "B2", ""]],
    [["a", "2026-11-06", 94.5]],
    [["a", "English", "2026-10-12", "6", "7"], ["a", "Maths", "2026-11-06", "6", "7"]]
  ]);
  assert.deepEqual(toPlain(project(students, events, days, settings, result, "2026-11-09")), toPlain(result));
  assert.throws(() => project(students, events, days, settings.slice(0, 2), initial, "2026-11-08"));
  assert.throws(() => project(students, [], days, settings, initial, "2026-11-08"));
  assert.throws(() => project(students, [...events, ["reward-1", "b", "2026-11-06", "", "R1", "reward"]], days, settings, initial, "2026-11-08"));
});

test("dry run leaves Sheets untouched, install refreshes atomically and schedules in Dubai", () => {
  const source = {
    students: [["id", "externalStudentId", "firstName", "surname", "preferredName", "yearGroup", "house", "boardingStatus", "active"], ...students],
    behaviourEvents: [["id", "studentId", "eventDate", "eventTime", "behaviourCode", "eventType"], ...events],
    schoolDays: [["date", "isSchoolDay", "term", "academicYear"], ...days],
    settings: [["key", "value"], ...settings]
  };
  const destination = Object.fromEntries(Object.entries(runInNewContext(script + "\nJARVIS_TABLES"))
    .map(([name, header], index) => [name, [header, ...initial[index]]]));
  const book = data => ({
    getSpreadsheetTimeZone: () => "Asia/Dubai",
    getSheetByName: name => {
      const rows = data[name];
      return rows && {
        getLastRow: () => rows.length,
        getMaxRows: () => 2,
        getSheetId: () => Object.keys(data).indexOf(name),
        getRange: () => ({ getValues: () => rows, getFormulas: () => [[]] })
      };
    }
  });
  const ids = runInNewContext(script + "\n({ FRY_SOURCE, JARVIS_ROSTER, JARVIS_OWNER })");
  const writes = [], triggers = [], messages = [];
  let failWrite = false;
  const trigger = {
    timeBased: () => trigger,
    inTimezone: zone => { assert.equal(zone, "Asia/Dubai"); return trigger; },
    atHour: hour => { assert.equal(hour, 6); return trigger; },
    everyDays: interval => { assert.equal(interval, 1); return trigger; },
    create: () => triggers.push({ getHandlerFunction: () => "syncJarvisPerformance" })
  };
  const app = runInNewContext(script + "\n({previewJarvisPerformance, installJarvisDailySync})", {
    console: { info: message => messages.push(message) },
    Session: { getEffectiveUser: () => ({ getEmail: () => ids.JARVIS_OWNER }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate: () => "2026-11-08" },
    SpreadsheetApp: { openById: id => {
      assert.ok(id === ids.FRY_SOURCE || id === ids.JARVIS_ROSTER);
      return book(id === ids.FRY_SOURCE ? source : destination);
    } },
    Sheets: { Spreadsheets: { batchUpdate: ({ requests }, id) => {
      if (failWrite) throw new Error("Private source data");
      assert.equal(id, ids.JARVIS_ROSTER);
      writes.push(toPlain(requests));
    } } },
    PropertiesService: { getScriptProperties: () => ({ setProperty: key => assert.equal(key, "JARVIS_LAST_SUCCESS") }) },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      newTrigger: name => { assert.equal(name, "syncJarvisPerformance"); return trigger; }
    }
  });
  app.previewJarvisPerformance();
  assert.equal(writes.length, 0);
  assert.match(messages[0], /Dry run passed.*2026-11-06/);
  failWrite = true;
  assert.throws(() => app.installJarvisDailySync(), /^Error: Jarvis refresh stopped at: Update Jarvis in one Sheets transaction\.$/);
  assert.equal(triggers.length, 0);
  failWrite = false;
  app.installJarvisDailySync();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filter(request => request.updateCells).length, 4);
  assert.ok(writes[0].some(request => request.appendDimension));
  assert.equal(triggers.length, 1);
  app.installJarvisDailySync();
  assert.equal(triggers.length, 1);
});
