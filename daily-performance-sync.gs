const FRY_SOURCE = "REPLACE_WITH_PRIVATE_PERFORMANCE_SOURCE_ID";
const JARVIS_ROSTER = "REPLACE_WITH_PRIVATE_JARVIS_ROSTER_ID";
const JARVIS_ZONE = "Asia/Dubai";
const JARVIS_OWNER = "workbook-owner@example.invalid";

const JARVIS_TABLES = {
  "Boarder Performance": ["Student ID", "Boarder", "Year group", "Term start", "Through"],
  "Behaviour Events": ["Event ID", "Student ID", "Event date", "Type", "Code", "Reward points"],
  "Attendance": ["Student ID", "Report date", "Attendance %"],
  "Subject Grades": ["Student ID", "Subject", "Report date", "Current grade", "Target grade"]
};

function previewJarvisPerformance() {
  runJarvisPerformance_(false);
}

function syncJarvisPerformance() {
  runJarvisPerformance_(true);
}

function installJarvisDailySync() {
  // Validate the live sources and complete an initial write before scheduling.
  syncJarvisPerformance();
  if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === "syncJarvisPerformance")) {
    ScriptApp.newTrigger("syncJarvisPerformance").timeBased()
      .inTimezone(JARVIS_ZONE).atHour(6).everyDays(1).create();
  }
  console.info("Jarvis daily trigger is installed for the 06:00 Dubai hour.");
}

function runJarvisPerformance_(write) {
  if (Session.getEffectiveUser().getEmail().toLowerCase() !== JARVIS_OWNER) {
    throw new Error("Run this project as the Cognita workbook owner.");
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error("Another Jarvis sync is running.");
  let stage = "Open school workbooks";
  try {
    const source = SpreadsheetApp.openById(FRY_SOURCE);
    const roster = SpreadsheetApp.openById(JARVIS_ROSTER);
    const read = (book, name, headers, destination = false) => {
      const sheet = book.getSheetByName(name);
      const length = sheet?.getLastRow();
      if (!length || length > 30000) throw new Error("Missing or oversized tab: " + name);
      const range = sheet.getRange(1, 1, length, headers.length);
      const values = range.getValues();
      if (!headers.every((key, index) => values[0][index] === key)) throw new Error("Header changed in " + name);
      if (destination && range.getFormulas().some(row => row.some(Boolean))) {
        throw new Error("Formulas require review in " + name);
      }
      const zone = book.getSpreadsheetTimeZone();
      return { sheet, length, rows: values.slice(1).filter(row => row.some(cell => cell !== ""))
        .map(row => row.map(cell => cell instanceof Date ? Utilities.formatDate(cell, zone, "yyyy-MM-dd") : cell)) };
    };
    stage = "Read and validate source tabs";
    const students = read(source, "students",
      ["id", "externalStudentId", "firstName", "surname", "preferredName", "yearGroup", "house", "boardingStatus", "active"]).rows;
    const events = read(source, "behaviourEvents",
      ["id", "studentId", "eventDate", "eventTime", "behaviourCode", "eventType"]).rows;
    const schoolDays = read(source, "schoolDays", ["date", "isSchoolDay", "term", "academicYear"]).rows;
    const settings = read(source, "settings", ["key", "value"]).rows.filter(([key]) =>
      /^weight_R[1-4]$|^academic_records_(?:chunks|[0-9]{3})$/.test(key));
    stage = "Read and validate Jarvis tabs";
    const names = Object.keys(JARVIS_TABLES);
    const tabs = names.map(name => read(roster, name, JARVIS_TABLES[name], true));
    stage = "Match and validate records";
    const today = Utilities.formatDate(new Date(), JARVIS_ZONE, "yyyy-MM-dd");
    const result = projectJarvisDaily_(students, events, schoolDays, settings, tabs.map(tab => tab.rows), today);
    const requests = names.flatMap((name, index) => {
      const tab = tabs[index];
      const rows = result[index];
      if (JSON.stringify(rows) === JSON.stringify(tab.rows)) return [];
      const width = JARVIS_TABLES[name].length;
      const end = Math.max(tab.length, rows.length + 1);
      const sheetId = tab.sheet.getSheetId();
      const update = { updateCells: {
        range: { sheetId, startRowIndex: 1, endRowIndex: end, startColumnIndex: 0, endColumnIndex: width },
        rows: rows.map(row => ({ values: row.map(value => ({ userEnteredValue:
          typeof value === "number" ? { numberValue: value } : { stringValue: String(value ?? "") }
        })) })),
        fields: "userEnteredValue"
      } };
      const extra = end - tab.sheet.getMaxRows();
      return extra > 0 ? [{ appendDimension: { sheetId, dimension: "ROWS", length: extra } }, update] : [update];
    });
    if (write && requests.length) {
      stage = "Update Jarvis in one Sheets transaction";
      Sheets.Spreadsheets.batchUpdate({ requests }, JARVIS_ROSTER);
    }
    if (write) PropertiesService.getScriptProperties().setProperty("JARVIS_LAST_SUCCESS", new Date().toISOString());
    console.info((write ? "Sync" : "Dry run") + " passed. Tabs with changes: " +
      requests.filter(request => request.updateCells).length + ". Source event coverage: " + result.coverage + ".");
  } catch (error) {
    // Error details from Google or source parsing can contain records. Report only our stage.
    throw new Error("Jarvis refresh stopped at: " + stage + ".");
  } finally {
    lock.releaseLock();
  }
}

function projectJarvisDaily_(students, events, schoolDays, settingsRows, existing, today) {
  const str = value => String(value ?? "").trim();
  const key = value => str(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(value + "T00:00:00Z").toJSON()?.slice(0, 10) === value;
  const fail = () => { throw new Error("Invalid or incomplete source data"); };
  const unique = (rows, getKey) => {
    const map = new Map();
    for (const row of rows) {
      const id = getKey(row);
      if (!id || map.has(id)) fail();
      map.set(id, row);
    }
    return map;
  };
  const [roster, oldEvents, oldAttendance, oldGrades] = existing;
  const settings = unique(settingsRows, row => row[0]);
  const allStudents = unique(students, row => str(row[0]));
  const approved = unique(roster, row => str(row[0]));
  if (!approved.size || [...approved.keys()].some(id => !allStudents.has(id))) fail();
  const linked = new Set([...approved.keys()].filter(id => {
    const row = allStudents.get(id);
    return str(row[7]).toLowerCase() === "boarder" && str(row[8]).toLowerCase() === "true";
  }));
  if (!linked.size) fail();

  const sourceEvents = new Map();
  let coverage = "";
  for (const [rawId, rawStudent, eventDate, , code, type] of events) {
    const id = str(rawId), studentId = str(rawStudent);
    if (!date(eventDate) || eventDate > today || !id ||
        !(type === "reward" && /^R[1-4]$/.test(code) || type === "sanction" && /^B[1-4]$/.test(code))) continue;
    if (eventDate > coverage) coverage = eventDate;
    if (!linked.has(studentId)) continue;
    const weight = str(settings.get("weight_" + code)?.[1]);
    const points = weight === "" ? Number(code[1]) : Number(weight);
    if (type === "reward" && (!Number.isFinite(points) || points < 0)) fail();
    const row = [id, studentId, eventDate, type, code, type === "reward" ? points : ""];
    if (sourceEvents.has(id) && JSON.stringify(sourceEvents.get(id)) !== JSON.stringify(row)) fail();
    sourceEvents.set(id, row);
  }
  if (!coverage || !sourceEvents.size) fail();

  const terms = schoolDays.filter(([day, , term, year]) => date(day) && day <= coverage && term && year)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const latestTerm = terms.at(-1);
  const termStart = latestTerm ? terms.find(([, , term, year]) => term === latestTerm[2] && year === latestTerm[3])[0] : "";
  const nextRoster = roster.map(row => {
    const [id, , , start, through] = row;
    if (!linked.has(str(id))) return row;
    if (!date(start) || !date(through) || start > through || through > today) fail();
    return [row[0], row[1], row[2], termStart > through ? termStart : start, coverage > through ? coverage : through];
  });

  const nextEvents = unique(oldEvents, row => str(row[0]));
  for (const [id, row] of sourceEvents) {
    if (nextEvents.has(id) && str(nextEvents.get(id)[1]) !== row[1]) fail();
    nextEvents.set(id, row);
  }

  const nextAttendance = new Map(oldAttendance.map(row => [JSON.stringify([str(row[0]), row[1]]), row]));
  const nextGrades = new Map(oldGrades.map(row => [JSON.stringify([str(row[0]), key(row[1]), row[2]]), row]));
  const rawCount = settings.get("academic_records_chunks")?.[1];
  if (rawCount !== undefined && str(rawCount) !== "") {
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 1 || count > 100) fail();
    const chunks = Array.from({ length: count }, (_, i) => settings.get("academic_records_" + String(i).padStart(3, "0"))?.[1]);
    if (chunks.some(chunk => typeof chunk !== "string" || !chunk)) fail();
    const academic = JSON.parse(chunks.join(""));
    if (!Array.isArray(academic)) fail();
    const newest = rowsByKey => {
      const rows = new Map();
      for (const [recordKey, value, timestamp] of rowsByKey) {
        const prior = rows.get(recordKey);
        if (!prior || timestamp > prior[1]) rows.set(recordKey, [value, timestamp]);
        else if (timestamp === prior[1] && JSON.stringify(value) !== JSON.stringify(prior[0])) fail();
      }
      return rows;
    };
    const attendance = [], grades = [];
    for (const record of academic) {
      const id = str(record?.studentId), day = record?.date, subject = str(record?.subject);
      if (!linked.has(id) || !date(day) || day > today || !key(subject)) continue;
      if (key(subject) === "wholeschoolsettlingandengagement") {
        const percent = Number(str(record.note).match(/\bAttendance\s+(\d+(?:\.\d+)?)\s*%/i)?.[1]);
        if (percent >= 0 && percent <= 100) attendance.push([JSON.stringify([id, day]), [id, day, percent], str(record.createdAt)]);
      } else {
        const current = str(record.currentGrade), target = str(record.targetGrade);
        if (current || target) grades.push([JSON.stringify([id, key(subject), day]), [id, subject, day, current, target], str(record.createdAt)]);
      }
    }
    for (const [id, [row]] of newest(attendance)) nextAttendance.set(id, row);
    for (const [id, [row]] of newest(grades)) nextGrades.set(id, row);
  }
  const result = [nextRoster, [...nextEvents.values()], [...nextAttendance.values()], [...nextGrades.values()]];
  result.coverage = coverage;
  return result;
}
