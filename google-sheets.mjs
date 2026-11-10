export const rosterSpreadsheetId = "REPLACE_WITH_PRIVATE_JARVIS_ROSTER_ID";
const tokenUrl = "https://oauth2.googleapis.com/token";
const scope = "https://www.googleapis.com/auth/spreadsheets.readonly";
const encoder = new TextEncoder();
const sheetEpoch = Date.UTC(1899, 11, 30);
const dayMs = 86_400_000;
const text = value => typeof value === "string" ? value.trim() : "";

export function dateCell(value) {
  const date = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2_958_465
    ? new Date(sheetEpoch + Math.floor(value) * dayMs).toISOString().slice(0, 10)
    : text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date + "T00:00:00Z").toJSON()?.slice(0, 10) === date ? date : "";
}

export function timeCell(value) {
  if (typeof value === "number" && value >= 0 && value < 1) {
    const minutes = Math.round(value * 1440);
    if (minutes >= 1440) return "";
    return [Math.floor(minutes / 60), minutes % 60].map(part => String(part).padStart(2, "0")).join(":");
  }
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(text(value));
  return match && Number(match[1]) < 24 ? match[1].padStart(2, "0") + ":" + match[2] : "";
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encodeClaim = value => base64url(encoder.encode(JSON.stringify(value)));

export async function sheetsToken(email, privateKey, requestedScope = scope) {
  const pem = privateKey.replace(/\\n/g, "\n").trim();
  const match = pem.match(/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
  if (!match) throw new Error("Invalid Sheets service key");
  const keyBytes = Uint8Array.from(atob(match[1].replace(/\s/g, "")), char => char.charCodeAt(0));
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, algorithm, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: email, scope: requestedScope, aud: tokenUrl, iat: now, exp: now + 300 };
  const unsigned = encodeClaim({ alg: "RS256", typ: "JWT" }) + "." + encodeClaim(claim);
  const signature = await crypto.subtle.sign(algorithm.name, key, encoder.encode(unsigned));
  const response = await fetch(tokenUrl, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + base64url(new Uint8Array(signature))
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("Sheets authorization unavailable");
  const { access_token: token } = await response.json();
  if (typeof token !== "string" || !token) throw new Error("Missing Sheets access token");
  return token;
}

export async function readRanges(token, workbookId, ranges) {
  const url = new URL("https://sheets.googleapis.com/v4/spreadsheets/" + workbookId + "/values:batchGet");
  url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");
  for (const range of ranges) url.searchParams.append("ranges", range);
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error("Fry House workbook is unavailable");
  const data = await response.json();
  if (data.spreadsheetId !== workbookId || data.valueRanges?.length !== ranges.length) {
    throw new Error("Unexpected Fry House workbook response");
  }
  return data.valueRanges.map(range => range.values || []);
}

export async function readJarvisRoster(email, privateKey, includeTimetable, calendarWorkbookId, recognitionWorkbookId) {
  const token = await sheetsToken(email, privateKey);
  const ranges = ["'Boarder Performance'!A1:E", "'Behaviour Events'!A1:F", "'Attendance'!A1:C", "'Subject Grades'!A1:E"];
  if (includeTimetable) ranges.push("'Student Timetable'!A1:G");
  function optionalWorkbook(id, tabs) {
    if (!id) return undefined;
    if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) return null;
    return readRanges(token, id, tabs).catch(() => null);
  }
  const [roster, calendar, recognition] = await Promise.all([
    readRanges(token, rosterSpreadsheetId, ranges),
    optionalWorkbook(calendarWorkbookId, ["'Calendar Sources'!A1:B", "'Calendar Events'!A1:I"]),
    optionalWorkbook(recognitionWorkbookId, ["'Recognition'!A1:F", "'Roll Call Sessions'!A1:A", "'Morning Roll Call'!A1:C"])
  ]);
  return { roster, calendar, recognition };
}

export async function appendSheetRow(token, workbookId, range, values) {
  const url = new URL("https://sheets.googleapis.com/v4/spreadsheets/" + workbookId + "/values/" + encodeURIComponent(range) + ":append");
  url.searchParams.set("valueInputOption", "RAW");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [values] }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error("Planner write unavailable");
  const result = await response.json();
  if (result.spreadsheetId !== workbookId || result.updates?.updatedRows !== 1) {
    throw new Error("Unexpected planner write response");
  }
}

export function schoolSheetsBridge(env) {
  const { JARVIS_SHEETS_BRIDGE_URL: url, JARVIS_SHEETS_BRIDGE_KEY: secret } = env;
  if (!url && !secret) return null;
  if (!/^https:\/\/script\.google\.com\/(?:a\/macros\/cognita\.com|macros)\/s\/[A-Za-z0-9_-]+\/exec$/.test(url || "") ||
      !/^[a-f0-9]{64}$/.test(secret || "")) throw new Error("Invalid school Sheets bridge settings");
  return { url, secret };
}

export async function schoolSheetsRequest({ url, secret }, request) {
  const payload = JSON.stringify({ ...request, timestamp: Date.now() });
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  const signature = Array.from(signed, byte => byte.toString(16).padStart(2, "0")).join("");
  const initial = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, signature }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000)
  });
  let response = initial;
  if (initial.status === 302 || initial.status === 303) {
    const location = new URL(initial.headers.get("Location") || url);
    if (location.origin !== "https://script.googleusercontent.com") throw new Error("Unexpected school Sheets redirect");
    response = await fetch(location, { redirect: "manual", signal: AbortSignal.timeout(12_000) });
  }
  if (!response.ok) throw new Error("School Sheets bridge is unavailable");
  const result = await response.json();
  if (result.ok !== true) throw new Error("School Sheets bridge declined the request");
  return result;
}
