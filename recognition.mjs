import { dateCell, readRanges, sheetsToken } from "./google-sheets.mjs";

const approvalHeaders = ["Student ID", "Display name", "Show points", "Show streak", "Photo file ID", "Show photo"];
const idCell = value => String(value ?? "").trim();
const allowed = value => typeof value === "string" && value.trim().toLowerCase() === "yes";
const fileIdPattern = /^[A-Za-z0-9_-]{15,100}$/;
const approvedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const imageLimit = 262_144;

function hasHeaders(rows, headers) {
  return headers.every((header, index) => rows?.[0]?.[index] === header);
}

function approvedBoarders(rows) {
  if (!hasHeaders(rows, approvalHeaders)) throw new Error("Invalid recognition sheet");
  const byId = new Map();
  for (const [rawId, rawName, points, streak, photoId, photo] of rows.slice(1)) {
    const id = idCell(rawId);
    if (!id) continue;
    const displayName = typeof rawName === "string" ? rawName.trim() : "";
    if (byId.has(id) || !displayName || displayName.length > 60) {
      byId.set(id, null);
      continue;
    }
    byId.set(id, { id, displayName, points: allowed(points), streak: allowed(streak),
      photoId: allowed(points) && allowed(photo) && typeof photoId === "string" && fileIdPattern.test(photoId) ? photoId : "" });
  }
  return [...byId.values()].filter(Boolean);
}

function rollCall(sessions, marks, period) {
  if (!hasHeaders(sessions, ["Date"]) || !hasHeaders(marks, ["Student ID", "Date", "Result"])) return null;
  const dates = [...new Set(sessions.slice(1).map(([date]) => dateCell(date)))]
    .filter(date => date && date >= period.start && date <= period.end).sort().reverse();
  const results = new Map();
  for (const [rawId, rawDate, rawResult] of marks.slice(1)) {
    const id = idCell(rawId), date = dateCell(rawDate), result = idCell(rawResult).toLowerCase();
    if (!id || !date) continue;
    const key = id + "\u0000" + date;
    if (!results.has(key)) results.set(key, result);
    else if (results.get(key) !== result) results.set(key, "conflict");
  }
  return { dates, results };
}

export function projectRecognition(tables, roster, period) {
  if (!tables) return { unavailable: true };
  const [approvals, sessions, marks] = tables;
  const eligible = new Map(roster.filter(row => row.period.start === period.start && row.period.end === period.end)
    .map(row => [row.id, row]));
  const roll = rollCall(sessions, marks, period);
  const ranks = [], streaks = [];
  for (const approved of approvedBoarders(approvals)) {
    const record = eligible.get(approved.id);
    if (!record) continue;
    if (approved.points) ranks.push({
      name: approved.displayName, points: record.points,
      photo: approved.photoId ? "/house/photo/" + approved.photoId : ""
    });
    if (!approved.streak || !roll?.dates.length) continue;
    let count = 0;
    for (const date of roll.dates) {
      const result = roll.results.get(approved.id + "\u0000" + date);
      if (result === "excused") continue;
      if (result !== "on-time") break;
      count++;
    }
    if (count >= 3) streaks.push({ name: approved.displayName, count });
  }
  ranks.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  streaks.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { ranks, streaks, through: period.end, rollCallThrough: roll?.dates[0] || "" };
}

export async function readApprovedPhoto(fileId, env, headers) {
  const workbook = env.JARVIS_RECOGNITION_SPREADSHEET_ID;
  if (!fileIdPattern.test(fileId) || !/^[A-Za-z0-9_-]{20,}$/.test(workbook || "")) return null;
  const { FRY_HOUSE_SHEETS_CLIENT_EMAIL: email, FRY_HOUSE_SHEETS_PRIVATE_KEY: key } = env;
  const rosterToken = await sheetsToken(email, key);
  const [rows] = await readRanges(rosterToken, workbook, ["'Recognition'!A1:F"]);
  if (!approvedBoarders(rows).some(approved => approved.photoId === fileId)) return null;

  const token = await sheetsToken(email, key, "https://www.googleapis.com/auth/drive.readonly");
  const response = await fetch("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media", {
    headers: { Authorization: "Bearer " + token, Range: "bytes=0-" + imageLimit },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000)
  });
  const type = response.headers.get("Content-Type")?.split(";")[0];
  if (!response.ok || !approvedImageTypes.has(type) ||
      Number(response.headers.get("Content-Length")) > imageLimit) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > imageLimit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (!size) return null;
  return new Response(new Blob(chunks, { type }), {
    headers: { ...headers, "Content-Type": type, "Cross-Origin-Resource-Policy": "same-origin" }
  });
}
