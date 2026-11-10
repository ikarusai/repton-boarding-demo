// Add this file to Jarvis Daily Fry House Sync, which supplies JARVIS_ROSTER
// and the advanced Sheets service. Set the bridge properties before deploying.
const JARVIS_BRIDGE_PLANNER = {
  calendar: { range: "'Personal Calendar'!A1:G", columns: 7, operationColumn: 2 },
  progress: { range: "'Boarder Progress'!A1:D", columns: 4, operationColumn: 1 }
};
const JARVIS_BRIDGE_ROSTER_RANGES = [
  "'Boarder Performance'!A1:E", "'Behaviour Events'!A1:F",
  "'Attendance'!A1:C", "'Subject Grades'!A1:E"
];

function doPost(event) {
  const reply = value => ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
  try {
    const input = event?.postData?.contents;
    if (typeof input !== "string" || input.length > 24000) return reply({ ok: false });
    const { payload, signature } = JSON.parse(input);
    if (typeof payload !== "string" || !/^[a-f0-9]{64}$/.test(signature || "")) return reply({ ok: false });
    const properties = PropertiesService.getScriptProperties();
    const key = properties.getProperty("JARVIS_SHEETS_BRIDGE_KEY");
    if (!/^[a-f0-9]{64}$/.test(key || "")) return reply({ ok: false });
    const expected = Utilities.computeHmacSha256Signature(payload, key, Utilities.Charset.UTF_8)
      .map(byte => (byte & 255).toString(16).padStart(2, "0")).join("");
    let mismatch = 0;
    for (let index = 0; index < expected.length; index++) {
      mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
    }
    if (mismatch) return reply({ ok: false });

    const request = JSON.parse(payload);
    const studentId = request.studentId;
    const configuredIds = properties.getProperty("JARVIS_SHEETS_BRIDGE_BOARDER_IDS");
    const allowedIds = configuredIds ? JSON.parse(configuredIds) : [properties.getProperty("JARVIS_SHEETS_BRIDGE_BOARDER_ID")];
    if (typeof studentId !== "string" || !studentId || !Array.isArray(allowedIds) ||
        !allowedIds.includes(studentId) || !Number.isSafeInteger(request.timestamp) ||
        Math.abs(Date.now() - request.timestamp) > 60000) return reply({ ok: false });

    if (request.operation === "roster") {
      const ranges = JARVIS_BRIDGE_ROSTER_RANGES.slice();
      if (request.includeTimetable === true) ranges.push("'Student Timetable'!A1:G");
      const rows = jarvisBridgeRead_(JARVIS_ROSTER, ranges);
      const roster = rows.map((tab, index) =>
        tab.filter((row, rowIndex) => rowIndex === 0 || String(row[index === 1 ? 1 : 0]) === studentId)
      );
      return reply({ ok: true, roster });
    }

    const workbook = properties.getProperty("JARVIS_SHEETS_BRIDGE_PLANNER_ID");
    const tab = Object.prototype.hasOwnProperty.call(JARVIS_BRIDGE_PLANNER, request.tab)
      ? JARVIS_BRIDGE_PLANNER[request.tab] : null;
    if (!tab || !/^[A-Za-z0-9_-]{20,}$/.test(workbook || "") || workbook === JARVIS_ROSTER) return reply({ ok: false });
    const load = () => jarvisBridgeRead_(workbook, [tab.range])[0]
      .filter((row, index) => index === 0 || String(row[0]) === studentId);
    if (request.operation === "read") return reply({ ok: true, rows: load() });
    if (request.operation !== "append") return reply({ ok: false });
    const row = request.row;
    if (!Array.isArray(row) || row.length !== tab.columns || row[0] !== studentId ||
        !row.every(value => typeof value === "string" && value.length <= 8192) ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row[tab.operationColumn])) return reply({ ok: false });

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return reply({ ok: false });
    try {
      if (!load().some(saved => saved[tab.operationColumn] === row[tab.operationColumn])) {
        Sheets.Spreadsheets.Values.append({ values: [row] }, workbook, tab.range, {
          valueInputOption: "RAW", insertDataOption: "INSERT_ROWS"
        });
      }
      return reply({ ok: true });
    } finally {
      lock.releaseLock();
    }
  } catch {
    return reply({ ok: false });
  }
}

function jarvisBridgeRead_(workbook, ranges) {
  const { valueRanges } = Sheets.Spreadsheets.Values.batchGet(workbook, {
    ranges, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER"
  });
  if (valueRanges?.length !== ranges.length) throw new Error("Unexpected Sheets response");
  return valueRanges.map(range => range.values || []);
}
