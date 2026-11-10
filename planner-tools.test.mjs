import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftDay, matchesEvent, agendaEvents, eventClashes, calendarFile, outsideCoverage } from './planner-tools.mjs';

test('agenda spans Dubai date boundaries, filters all words and detects actual timed overlaps', () => {
  assert.equal(shiftDay('2027-01-31', 1), '2027-02-01');
  assert.equal(shiftDay('2027-03-01', -1), '2027-02-28');
  const events = [{ date: '2027-01-31', title: 'House games', time: '17:00', end: '18:00', category: 'boarding' },
    { date: '2027-01-31', title: 'Revision', time: '17:30', end: '18:30' },
    { date: '2027-01-31', title: 'Dinner', time: '18:30', end: '19:00' },
    { date: '2027-01-31', title: 'Free', time: '17:30', end: '18:00', category: 'free' }];
  assert.ok(matchesEvent(events[0], 'HOUSE games'));
  assert.equal(matchesEvent(events[0], 'house trip'), false);
  assert.equal(agendaEvents(date => events.filter(event => event.date === date), '2027-01-31', 2, 'games').length, 1);
  assert.equal(eventClashes(events).length, 1);
});

test('calendar export uses UTC for Dubai times, exclusive all-day ends, safe folded UTF-8 and stable IDs', () => {
  const events = [{ id: 'one', date: '2027-01-04', time: '01:00', end: '02:00', title: 'Prep; notes, quiz\nBEGIN:VEVENT' },
    { date: '2027-01-05', title: 'é'.repeat(100), tentative: true }];
  const result = calendarFile(events, new Date('2026-11-09T00:00:00Z'));
  assert.match(result, /DTSTART:20270103T210000Z/);
  assert.match(result, /DTEND;VALUE=DATE:20270106/);
  assert.match(result, /Prep\\; notes\\, quiz\\nBEGIN:VEVENT/);
  assert.equal(result.match(/\r\nBEGIN:VEVENT\r\n/g).length, 2);
  assert.match(result, /STATUS:TENTATIVE/);
  for (const line of result.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.deepEqual(result.match(/UID:.*/g), calendarFile(events).match(/UID:.*/g));
  assert.equal(result.match(/UID:.*/)[0], calendarFile([{ ...events[0], date:'2027-01-06', time:'02:00',end:'03:00' }]).match(/UID:.*/)[0]);
  assert.match(calendarFile([{id:'plan',date:'2027-01-10',title:'Trip',sourceDocument:'supplied-plan'}]), /STATUS:TENTATIVE/);
});

test('supplied coverage clips crossing fallback holidays without duplicate days or lost outside dates', () => {
  const source = [{date:'2026-12-12',through:'2027-01-03',title:'Winter break'}, {date:'2027-01-04',title:'School starts'}, {date:'2027-07-02',title:'Term ends'}];
  const result = outsideCoverage(source, {start:'2027-01-01',end:'2027-06-30'});
  assert.deepEqual(result, [{...source[0],through:'2026-12-31'},source[2]]);
  assert.deepEqual(outsideCoverage([{date:'2026-12-01',through:'2027-07-31'}],{start:'2027-01-01',end:'2027-06-30'}),[{date:'2026-12-01',through:'2026-12-31'},{date:'2027-07-01',through:'2027-07-31'}]);
});
