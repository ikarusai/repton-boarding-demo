import { dateCell } from "./google-sheets.mjs";

// Transcribed from all six pages of the supplied Fry House January-June 2027
// calendar and visually checked against its month grids. These are plan entries,
// not a claim of school approval. Named birthdays remain in the private source.
export const houseCalendarSource = Object.freeze({
  id: "fry-house-jan-jun-2027",
  title: "Fry House plan · January–June 2027",
  file: "Fry_House_Calendar_January-June_2027 (2).pdf",
  coverage: Object.freeze({ start: "2027-01-01", end: "2027-06-30" }),
  transcribedOn: "2026-11-09",
  schoolVerified: false,
  omittedBirthdayEntries: 18,
  omittedBirthdayMentions: 21,
  notes: Object.freeze([
    "Dates follow the supplied plan. The school must confirm activities, participating years and any changes.",
    "The PDF supplies no start or end times. Date-only activities do not establish availability.",
    "Named birthdays are omitted. Only school-approved, year-filtered birthday rows from the existing shared calendar are displayed.",
    "22 March padel is a faint handwritten entry in the source; confirm before use.",
    "Lunar holiday dates are provisional and need school confirmation.",
    "A reviewed boarding or term-dates source replaces the matching supplied-plan entries, including when its approved event list is empty."
  ])
});

const rows = [
  ["2027-01-01", "Holiday", "holiday", "2027-01-03"],
  ["2027-01-04", "School starts", "term"],
  ["2027-01-10", "D.F.C.", "trip"],
  ["2027-01-13", "Fry House games: Olympiad / trivia", "event"],
  ["2027-01-17", "X-Strike", "trip"],
  ["2027-01-24", "Zabeel", "trip"],
  ["2027-01-31", "Top Golf", "trip"],
  ["2027-02-07", "Ski Dubai", "trip"],
  ["2027-02-14", "Go-karting", "trip"],
  ["2027-02-21", "Motiongate", "trip"],
  ["2027-02-24", "Global Village", "trip"],
  ["2027-03-04", "Meydan Iftar", "trip"],
  ["2027-03-08", "Eid al-Fitr holiday (provisional)", "holiday", "2027-03-12", "Lunar holiday dates need school confirmation."],
  ["2027-03-14", "Boarders return", "boarding"],
  ["2027-03-17", "Fry House games: Football", "event"],
  ["2027-03-21", "Motiongate", "trip"],
  ["2027-03-22", "Fry House games: Padel (unconfirmed)", "event", "", "The PDF footnote identifies padel as a faint handwritten entry; confirm before use."],
  ["2027-03-28", "Bounce DFC", "trip"],
  ["2027-03-31", "Fry House games: Basketball", "event"],
  ["2027-04-02", "Term ends", "term"],
  ["2027-04-12", "Term starts", "term"],
  ["2027-04-18", "Atlantis Aquaventure", "trip"],
  ["2027-04-25", "Karting", "trip"],
  ["2027-05-17", "Eid al-Adha (provisional)", "holiday", "2027-05-18", "Lunar holiday dates need school confirmation."],
  ["2027-05-30", "Ski Dubai", "trip"],
  ["2027-06-05", "Islamic New Year (provisional)", "holiday", "", "Lunar holiday dates need school confirmation."],
  ["2027-06-06", "Dubai Mall trip", "trip"],
  ["2027-06-13", "Bullzeye Arena", "trip"],
  ["2027-06-20", "Paintball", "trip"],
  ["2027-06-27", "Legoland Waterpark", "trip"]
];

export const houseCalendarEvents = Object.freeze(rows.map(([date, title, category, through, caution]) => {
  const page = Number(date.slice(5, 7));
  const isTerm = category === "term" || category === "holiday";
  return Object.freeze({
    id: "fry-2027-" + date.slice(5) + "-" + category,
    date, ...(through ? { through } : {}), title, category,
    source: isTerm ? "term-dates" : "boarding",
    sourceDocument: houseCalendarSource.id,
    sourcePage: page,
    tentative: Boolean(caution),
    detail: ["Supplied Fry House plan · page " + page,
      isTerm ? "School confirmation pending." : "Time and participating years to be confirmed.",
      caution].filter(Boolean).join(" ")
  });
}));

export function projectHouseCalendar(year, sharedCalendar) {
  const allowedYear = Number.isInteger(year) && year >= 7 && year <= 13;
  const replacedSources = ["boarding", "term-dates"].filter(source =>
    Boolean(dateCell(sharedCalendar?.sources?.[source])));
  return {
    ...houseCalendarSource,
    coverage: { ...houseCalendarSource.coverage },
    notes: [...houseCalendarSource.notes],
    replacedSources,
    events: allowedYear ? houseCalendarEvents
      .filter(event => !replacedSources.includes(event.source))
      .map(event => ({ ...event })) : []
  };
}
