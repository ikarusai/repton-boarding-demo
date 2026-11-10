import { appendSheetRow, dateCell, readRanges, rosterSpreadsheetId, schoolSheetsBridge, schoolSheetsRequest, sheetsToken, timeCell } from "./google-sheets.mjs";

const range = "'Personal Calendar'!A1:G";
const headers = ["Student ID", "Entry ID", "Operation ID", "Action", "Previous revision", "Event JSON", "Saved at"];
const categories = new Set(["reminder", "deadline", "training", "fixture", "exam", "personal"]);
const actions = new Set(["create", "edit", "remove"]);
const writeScope = "https://www.googleapis.com/auth/spreadsheets";
const idFormat = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const id = value => typeof value === "string" && idFormat.test(value);
const dayMs = 86_400_000;

function normalizeEvent(value) {
  if (!value || typeof value.title !== "string" || !categories.has(value.category)) return null;
  const title = value.title.trim();
  const detail = typeof value.detail === "string" ? value.detail.trim() : "";
  const date = typeof value.date === "string" ? dateCell(value.date) : "";
  const time = timeCell(value.time);
  const end = timeCell(value.end);
  if (!title || title.length > 80 || detail.length > 100 || !date ||
      (value.time && !time) || (value.end && !end) || (end && (!time || end <= time))) return null;

  const event = { title, category: value.category, date, time, end, detail };
  if (value.repeatDays !== undefined || value.repeatUntil) {
    const days = value.repeatDays;
    const until = typeof value.repeatUntil === "string" ? dateCell(value.repeatUntil) : "";
    if (!Array.isArray(days) || !days.length || days.length > 7 ||
        days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || !until) return null;
    const first = Date.parse(date + "T00:00:00Z");
    const span = (Date.parse(until + "T00:00:00Z") - first) / dayMs;
    if (span < 0 || span > 366 ||
        !Array.from({ length: Math.min(span + 1, 7) }, (_, offset) => new Date(first + offset * dayMs).getUTCDay())
          .some(day => days.includes(day))) return null;
    event.repeatDays = [...new Set(days)].sort((a, b) => a - b);
    event.repeatUntil = until;
  }
  return event;
}

function normalizeOperation(value) {
  if (!value || !actions.has(value.action) || !id(value.id) || !id(value.operationId) ||
      (value.action === "create" ? value.previous !== "" : !id(value.previous))) return null;
  const event = value.action === "remove" ? null : normalizeEvent(value.event);
  if (!event && value.action !== "remove") return null;
  return { action: value.action, id: value.id, operationId: value.operationId, previous: value.previous, event };
}

function canApply(entries, operation) {
  const entry = entries.get(operation.id);
  return operation.action === "create" ? !entry : Boolean(entry?.event && entry.revision === operation.previous);
}

function projectEntries(rows, studentId) {
  if (!headers.every((header, index) => rows[0]?.[index] === header)) throw new Error("Planner headers changed");
  const entries = new Map(), operations = new Map();
  for (const [owner, entryId, operationId, action, previous, eventJson] of rows.slice(1)) {
    if (String(owner) !== studentId || operations.has(operationId)) continue;
    const operation = normalizeOperation({ action, id: entryId, operationId, previous,
      event: action === "remove" ? null : JSON.parse(eventJson) });
    if (!operation) throw new Error("Invalid saved planner row");
    const applied = canApply(entries, operation);
    operations.set(operationId, { operation, applied });
    if (applied) entries.set(entryId, { revision: operationId, event: operation.event });
  }
  const events = [];
  for (const [entryId, entry] of entries) {
    if (entry.event) events.push({ ...entry.event, id: entryId, revision: entry.revision });
  }
  return { entries, operations, events };
}

export async function readPlannerJson(request, limit = 4096) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let body = "", bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      return null;
    }
    body += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(body + decoder.decode());
  } catch {
    return null;
  }
}

export function plannerWorkbook(env) {
  const workbook = env.JARVIS_PLANNER_SPREADSHEET_ID;
  const email = env.JARVIS_PLANNER_CLIENT_EMAIL;
  const key = env.JARVIS_PLANNER_PRIVATE_KEY;
  const bridge = email && key ? null : schoolSheetsBridge(env);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(workbook || "") || workbook === rosterSpreadsheetId ||
      workbook === env.JARVIS_CALENDAR_SPREADSHEET_ID || workbook === env.JARVIS_RECOGNITION_SPREADSHEET_ID ||
      (!bridge && (!email || !key || email.trim().toLowerCase() === env.FRY_HOUSE_SHEETS_CLIENT_EMAIL?.trim().toLowerCase()))) {
    return null;
  }
  return { workbook, email, key, bridge };
}

export async function plannerSheet({ workbook, email, key, bridge }, tab, range, studentId, write) {
  if (bridge) return {
    read: async () => (await schoolSheetsRequest(bridge, { operation: "read", tab, studentId })).rows,
    append: row => schoolSheetsRequest(bridge, { operation: "append", tab, studentId, row }),
  };
  const token = await sheetsToken(email, key, write ? writeScope : undefined);
  return {
    read: async () => (await readRanges(token, workbook, [range]))[0],
    append: row => appendSheetRow(token, workbook, range, row),
  };
}

export async function servePersonalCalendar(request, env, studentId, responseHeaders) {
  const reply = (data, status = 200) => Response.json(data, { status, headers: responseHeaders });
  const config = plannerWorkbook(env);
  if (!config) return reply({ error: "Calendar saving is not set up yet." }, 503);
  let operation;
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type")?.split(";")[0].trim();
    if (request.headers.get("Origin") !== new URL(request.url).origin || contentType !== "application/json") {
      return reply({ error: "Open Jarvis to change your calendar." }, 403);
    }
    operation = normalizeOperation(await readPlannerJson(request));
    if (!operation) return reply({ error: "Check the event details. Weekly repeats can run for up to one year." }, 400);
  }

  const sheet = await plannerSheet(config, "calendar", range, studentId, Boolean(operation));
  const load = async () => projectEntries(await sheet.read(), studentId);

  let calendar = await load();
  if (!operation) return reply({ events: calendar.events });

  if (!calendar.operations.has(operation.operationId) && canApply(calendar.entries, operation)) {
    await sheet.append([studentId, operation.id, operation.operationId, operation.action,
      operation.previous, operation.event ? JSON.stringify(operation.event) : "", new Date().toISOString()]);
    calendar = await load();
    if (!calendar.operations.has(operation.operationId)) throw new Error("Planner write could not be verified");
  }
  const recorded = calendar.operations.get(operation.operationId);
  if (!recorded?.applied || JSON.stringify(recorded.operation) !== JSON.stringify(operation)) {
    return reply({ error: "This entry has changed. Check your calendar and try again.", events: calendar.events }, 409);
  }
  return reply({ events: calendar.events });
}
