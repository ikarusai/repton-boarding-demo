import { dateCell, readJarvisRoster, schoolSheetsBridge, schoolSheetsRequest, timeCell } from "./google-sheets.mjs";
import { projectSharedCalendar } from "./shared-calendar.mjs";
import { projectRecognition } from "./recognition.mjs";
import { projectHouseCalendar } from "./house-calendar.mjs";

const dubaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Dubai", dateStyle: "short" });
const timetableCategories = new Set(["school", "free", "eca", "training", "fixture", "boarding", "prep", "exam"]);
const text = value => typeof value === "string" ? value.trim() : "";
const idCell = value => typeof value === "number" ? String(value) : text(value);
const normalizeEmail = value => text(value).toLowerCase();

export function boarderIdForEmail(mapping, email) {
  const links = JSON.parse(mapping);
  if (!links || Array.isArray(links) || typeof links !== "object") throw new Error("Invalid account links");
  const verifiedEmail = normalizeEmail(email);
  if (!verifiedEmail) return null;
  const entries = Object.entries(links);
  const matches = entries.filter(([key]) => normalizeEmail(key) === verifiedEmail);
  if (matches.length !== 1) return null;
  const [, studentId] = matches[0];
  if (typeof studentId !== "string" || !studentId.trim() ||
      entries.filter(([, id]) => typeof id === "string" && id.trim() === studentId.trim()).length !== 1) return null;
  return studentId.trim();
}

function rowsFor(rows, headers, studentId, key = 0) {
  if (!Array.isArray(rows) || headers.some((value, index) => rows[0]?.[index] !== value)) {
    throw new Error("Jarvis roster headers changed");
  }
  return rows.slice(1).filter(row => idCell(row[key]) === studentId);
}

function numberCell(value) {
  if (typeof value === "number") return value;
  return /^\d+(?:\.\d+)?$/.test(text(value)) ? Number(value) : NaN;
}

function timetableFor(rows, studentId) {
  if (!rows) return [];
  const slots = rowsFor(rows, ["Student ID", "Date", "Start", "End", "Title", "Category", "Location"], studentId);
  const events = new Map();
  for (const [, rawDate, rawStart, rawEnd, rawTitle, rawCategory, rawLocation] of slots) {
    const date = dateCell(rawDate), time = timeCell(rawStart), end = timeCell(rawEnd);
    const title = text(rawTitle), category = text(rawCategory).toLowerCase(), detail = text(rawLocation);
    if (!date || !time || !end || time >= end || !title || !timetableCategories.has(category)) {
      throw new Error("Invalid timetable row for linked student");
    }
    const event = { date, time, end, title, category, detail };
    events.set(JSON.stringify(event), event);
  }
  return [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

const rosterHeaders = ["Student ID", "Boarder", "Year group", "Term start", "Through"];

function termRecord(row, today) {
  const [, rawName, rawYear, rawStart, rawThrough] = row;
  const name = text(rawName);
  const year = Number(idCell(rawYear).match(/^(?:year\s*)?(7|8|9|10|11|12|13)$/i)?.[1]);
  const start = dateCell(rawStart), through = dateCell(rawThrough);
  const end = through > today ? today : through;
  return name && year && start && end && start <= end ? { name, year, period: { start, end } } : null;

}

function termBehaviour(behaviourRows, studentId, period) {
  const { start, end } = period;
  const rewards = [], sanctions = [], seen = new Set();
  for (const [rawId, , rawDate, type, code, rawPoints] of rowsFor(behaviourRows,
      ["Event ID", "Student ID", "Event date", "Type", "Code", "Reward points"], studentId, 1)) {
    const id = idCell(rawId), date = dateCell(rawDate);
    if (!id || !date || date < start || date > end || seen.has(id)) continue;
    seen.add(id);
    const points = numberCell(rawPoints);
    if (type === "reward" && /^R[1-4]$/.test(code) && Number.isFinite(points) && points >= 0) rewards.push([date, points, code]);
    if (type === "sanction" && /^B[1-4]$/.test(code)) sanctions.push([date, code]);
  }
  rewards.sort((a, b) => b[0].localeCompare(a[0]));
  sanctions.sort((a, b) => b[0].localeCompare(a[0]));

  return { rewards, sanctions };
}

export function projectHouseTerms(tables, now = new Date()) {
  const [rosterRows, behaviourRows] = tables;
  if (!rosterHeaders.every((header, i) => rosterRows[0]?.[i] === header)) throw new Error("Jarvis roster headers changed");
  const today = dubaiDate.format(now);
  const ids = rosterRows.slice(1).map(row => idCell(row[0])).filter(Boolean);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  return rosterRows.slice(1).flatMap(row => {
    const id = idCell(row[0]);
    const record = termRecord(row, today);
    if (counts.get(id) !== 1 || !record) return [];
    const { rewards, sanctions } = termBehaviour(behaviourRows, id, record.period);
    return [{ ...record, id, points: rewards.reduce((total, [, points]) => total + points, 0), sanctions }];
  });
}

export function projectJarvisRoster(tables, studentId, now = new Date()) {
  const [rosterRows, behaviourRows, attendanceRows, gradeRows, timetableRows] = tables;
  const today = dubaiDate.format(now);
  const matches = rowsFor(rosterRows, rosterHeaders, studentId);
  if (matches.length !== 1) return null;
  const record = termRecord(matches[0], today);
  if (!record) throw new Error("Invalid linked roster row");
  const { rewards, sanctions } = termBehaviour(behaviourRows, studentId, record.period);

  const attendance = new Map(), subjects = new Map();
  for (const [, rawDate, rawPercent] of rowsFor(attendanceRows, ["Student ID", "Report date", "Attendance %"], studentId)) {
    const date = dateCell(rawDate), percent = numberCell(rawPercent);
    if (date && date <= today && percent >= 0 && percent <= 100) attendance.set(date, { date, percent });
  }
  for (const [, rawSubject, rawDate, rawCurrent, rawTarget] of rowsFor(gradeRows,
      ["Student ID", "Subject", "Report date", "Current grade", "Target grade"], studentId)) {
    const date = dateCell(rawDate), subject = text(rawSubject);
    const current = idCell(rawCurrent), target = idCell(rawTarget);
    const key = subject.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!date || date > today || !key || (!current && !target) || subjects.get(key)?.date >= date) continue;
    subjects.set(key, { subject, date, current, target });
  }
  return { ...record, rewards, sanctions, reports: {
    attendance: [...attendance.values()].sort((a, b) => b.date.localeCompare(a.date)),
    subjects: [...subjects.values()].sort((a, b) => a.subject.localeCompare(b.subject))
  }, timetable: timetableFor(timetableRows, studentId) };
}

export async function readFryHouseProfile(studentId, env) {
  const { FRY_HOUSE_SHEETS_CLIENT_EMAIL: email, FRY_HOUSE_SHEETS_PRIVATE_KEY: privateKey } = env;
  const includeTimetable = env.JARVIS_TIMETABLE_ENABLED === "true";
  const bridge = email && privateKey ? null : schoolSheetsBridge(env);
  if (!bridge && (!email || !privateKey)) throw new Error("Jarvis roster connection is incomplete");
  const { roster, calendar, recognition } = bridge
    ? await schoolSheetsRequest(bridge, { operation: "roster", studentId, includeTimetable })
    : await readJarvisRoster(email, privateKey, includeTimetable,
      env.JARVIS_CALENDAR_SPREADSHEET_ID, env.JARVIS_RECOGNITION_SPREADSHEET_ID);
  const profile = projectJarvisRoster(roster, studentId);
  if (profile && calendar !== undefined) profile.sharedCalendar = projectSharedCalendar(calendar, profile.year);
  // The supplied, labelled plan is available with either roster connection.
  // Reviewed live sources retain precedence, including explicit empty sources.
  if (profile) profile.houseCalendar = projectHouseCalendar(profile.year, profile.sharedCalendar);
  if (profile && recognition !== undefined) {
    try {
      profile.houseRecognition = projectRecognition(recognition, projectHouseTerms(roster), profile.period);
    } catch {
      profile.houseRecognition = { unavailable: true };
    }
  }
  return profile;
}
