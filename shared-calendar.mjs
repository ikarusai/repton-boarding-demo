import { dateCell, timeCell } from "./google-sheets.mjs";

const allowedCategories = {
  myrepton: new Set(["school-event", "fixture", "interhouse", "eca", "deadline"]),
  "term-dates": new Set(["term", "holiday"]),
  boarding: new Set(["boarding", "trip", "event", "training"]),
  birthdays: new Set(["birthday"])
};
const sourceHeaders = ["Source", "Last reviewed"];
const eventHeaders = ["Source", "Date", "Through", "Start", "End", "Title", "Category", "Years", "Approved"];
const text = value => typeof value === "string" ? value.trim() : "";

function hasHeaders(rows, headers) {
  return headers.every((header, index) => rows?.[0]?.[index] === header);
}

function includesYear(value, year) {
  const audience = String(value ?? "").trim().toLowerCase();
  if (audience === "all") return true;
  const years = audience.split(",").map(item => item.trim());
  return years.every(item => /^(7|8|9|10|11|12|13)$/.test(item)) && years.includes(String(year));
}

export function projectSharedCalendar(tables, year) {
  const [sourceRows, eventRows] = tables || [];
  const sources = Object.fromEntries(Object.keys(allowedCategories).map(source => [source, ""]));
  const result = { sources, events: [] };
  if (!hasHeaders(sourceRows, sourceHeaders) || !hasHeaders(eventRows, eventHeaders)) {
    return { ...result, unavailable: true };
  }

  for (const source of Object.keys(sources)) {
    const matches = sourceRows.slice(1).filter(row => text(row[0]) === source);
    if (matches.length === 1) sources[source] = dateCell(matches[0][1]);
  }

  const events = new Map();
  for (const [rawSource, rawDate, rawThrough, rawStart, rawEnd, rawTitle, rawCategory, years, approval] of eventRows.slice(1)) {
    const source = text(rawSource);
    if (!Object.hasOwn(sources, source) || !sources[source] || text(approval).toLowerCase() !== "yes" || !includesYear(years, year)) continue;
    const date = dateCell(rawDate), through = dateCell(rawThrough), time = timeCell(rawStart), end = timeCell(rawEnd);
    const title = text(rawTitle), category = text(rawCategory);
    if (!date || !title || title.length > 180 || !allowedCategories[source].has(category)) continue;
    if ((rawThrough !== "" && rawThrough != null && !through) || (through && (through < date || category === "birthday"))) continue;
    if ((rawStart !== "" && rawStart != null && !time) || (rawEnd !== "" && rawEnd != null && !end) || (end && (!time || end <= time))) continue;
    if (category === "birthday" && time) continue;

    const event = { source, title, category, date };
    if (through && through !== date) event.through = through;
    if (time) event.time = time;
    if (end) event.end = end;
    events.set(JSON.stringify(event), event);
  }
  result.events = [...events.values()];
  return result;
}
