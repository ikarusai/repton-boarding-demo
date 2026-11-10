// These credentials are deliberately public, fictional, local-demo-only values.
// Production provisioning must never use them.
export const demoAccounts = Object.freeze([
  Object.freeze({ username: "demo.avery", email: "demo.avery@reptondubai.net", studentId: "demo-avery", name: "Avery Example", year: 10,
    code: "DEMO_AVERY_0123456789_ABCDEFGHIJKL" }),
  Object.freeze({ username: "demo.robin", email: "demo.robin@reptondubai.net", studentId: "demo-robin", name: "Robin Example", year: 12,
    code: "DEMO_ROBIN_0123456789_ABCDEFGHIJKL" })
]);

export const demoCalendarHeaders = Object.freeze(["Student ID", "Entry ID", "Operation ID", "Action", "Previous revision", "Event JSON", "Saved at"]);
export const demoProgressHeaders = Object.freeze(["Student ID", "Operation ID", "Progress JSON", "Saved at"]);

export function emptyDemoState() {
  return { version: 1, calendar: [[...demoCalendarHeaders]], progress: [[...demoProgressHeaders]] };
}

export function createDemoRoster(now = new Date()) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Dubai", dateStyle: "short" }).format(now);
  const shift = days => new Date(Date.parse(today + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
  const timetable = [["Student ID", "Date", "Start", "End", "Title", "Category", "Location"]];
  for (let offset = 0; offset < 14; offset += 1) {
    const date = shift(offset), day = new Date(date + "T00:00:00Z").getUTCDay();
    if (day === 0 || day === 6) continue;
    for (const account of demoAccounts) {
      timetable.push([account.studentId, date, "08:15", "09:05", account.year === 10 ? "Example mathematics" : "Example physics", "school", "Demo classroom"]);
      timetable.push([account.studentId, date, "09:15", "10:05", "Free period", "free", ""]);
      if (day !== 5) timetable.push([account.studentId, date, "17:00", "18:00", "Example evening prep", "prep", "Demo study room"]);
    }
  }
  return [
    [["Student ID", "Boarder", "Year group", "Term start", "Through"],
      ...demoAccounts.map(account => [account.studentId, account.name, account.year, shift(-28), today])],
    [["Event ID", "Student ID", "Event date", "Type", "Code", "Reward points"],
      ["demo-a-reward-1", "demo-avery", shift(-3), "reward", "R2", 5],
      ["demo-a-reward-2", "demo-avery", shift(-1), "reward", "R1", 3],
      ["demo-b-reward-1", "demo-robin", shift(-2), "reward", "R3", 10]],
    [["Student ID", "Report date", "Attendance %"], ["demo-avery", today, 98], ["demo-robin", today, 96]],
    [["Student ID", "Subject", "Report date", "Current grade", "Target grade"],
      ["demo-avery", "Mathematics", today, "6", "7"], ["demo-avery", "English", today, "6", "7"],
      ["demo-robin", "Physics", today, "B", "A"], ["demo-robin", "Mathematics", today, "A", "A*"]],
    timetable
  ];
}
