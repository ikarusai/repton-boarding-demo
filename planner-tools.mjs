// Dates are Dubai calendar dates; date-only arithmetic never uses the host timezone.
export function shiftDay(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

export function matchesEvent(event, query) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [event.title, event.detail, event.category, event.source, event.date].join(' ').toLocaleLowerCase();
  return words.every(word => text.includes(word));
}

export function outsideCoverage(events, coverage) {
  if (!coverage) return events;
  return events.flatMap(event => {
    const end = event.through || event.date;
    if (end < coverage.start || event.date > coverage.end) return [event];
    const parts = [];
    if (event.date < coverage.start) parts.push({ ...event, through: shiftDay(coverage.start, -1) });
    if (end > coverage.end) parts.push({ ...event, date: shiftDay(coverage.end, 1) });
    return parts;
  });
}

export function agendaEvents(eventsOn, start, days = 14, query = '') {
  return Array.from({ length: Math.max(1, Math.min(days, 366)) }, (_, index) => shiftDay(start, index))
    .flatMap(date => eventsOn(date).filter(event => matchesEvent(event, query)).map(event => ({ ...event, date })));
}

export function eventClashes(events) {
  const timed = events.filter(event => event.time && event.end && event.category !== 'free');
  const clashes = [];
  for (let a = 0; a < timed.length; a++) for (let b = a + 1; b < timed.length; b++) {
    if (timed[a].date === timed[b].date && timed[a].time < timed[b].end && timed[b].time < timed[a].end) {
      clashes.push([timed[a], timed[b]]);
    }
  }
  return clashes;
}

const escapeCalendar = value => String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n|\r/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const stamp = value => value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function foldCalendar(line) {
  const encoder = new TextEncoder();
  let result = '', size = 0;
  for (const char of line) {
    const length = encoder.encode(char).length;
    if (size + length > 75) { result += '\r\n '; size = 1; }
    result += char; size += length;
  }
  return result;
}
function eventKey(value) {
  // Stable identifier for repeat exports; this is not a security hash.
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return hash.toString(16);
}

export function calendarFile(events, now = new Date()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jarvis//Boarding Planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const seen = new Set();
  for (const event of events) {
    const occurrence = event.series || event.repeatDays || event.through || event.startDate;
    const key = event.id ? [event.id, occurrence ? event.date : ''].join('|')
      : [event.title, event.date, event.time, event.source, event.category].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push('BEGIN:VEVENT', 'UID:' + eventKey(key) + '@jarvis.local', 'DTSTAMP:' + stamp(now));
    if (event.time) {
      lines.push('DTSTART:' + stamp(new Date(event.date + 'T' + event.time + ':00+04:00')));
      if (event.end) lines.push('DTEND:' + stamp(new Date(event.date + 'T' + event.end + ':00+04:00')));
    } else {
      lines.push('DTSTART;VALUE=DATE:' + event.date.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + shiftDay(event.date, 1).replace(/-/g, ''));
    }
    lines.push('SUMMARY:' + escapeCalendar(event.title), 'DESCRIPTION:' + escapeCalendar([event.detail, event.time ? 'Dubai time' : 'Date only; confirm any meeting time with staff.'].filter(Boolean).join('\n')),
      'CLASS:PRIVATE', 'STATUS:' + (event.tentative || event.sourceDocument ? 'TENTATIVE' : 'CONFIRMED'), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldCalendar).join('\r\n') + '\r\n';
}
