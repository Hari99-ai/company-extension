import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMatchTime,
  parseMatchTime,
  isSeekDetected,
  isDuplicateEvent
} from '../utils/timestamps.js';

test('formatMatchTime converts seconds to MM:SS and HH:MM:SS correctly', () => {
  assert.equal(formatMatchTime(0), '00:00');
  assert.equal(formatMatchTime(59), '00:59');
  assert.equal(formatMatchTime(60), '01:00');
  assert.equal(formatMatchTime(506.4), '08:26'); // Matches prompt example 08:26
  assert.equal(formatMatchTime(526.4), '08:46');
  assert.equal(formatMatchTime(3600), '01:00:00');
  assert.equal(formatMatchTime(3665), '01:01:05');
  assert.equal(formatMatchTime(null), '00:00');
  assert.equal(formatMatchTime(-10), '00:00');
});

test('parseMatchTime converts strings to internal seconds accurately', () => {
  assert.equal(parseMatchTime('00:00'), 0);
  assert.equal(parseMatchTime('08:26'), 506);
  assert.equal(parseMatchTime('08:46'), 526);
  assert.equal(parseMatchTime('01:00:00'), 3600);
  assert.equal(parseMatchTime('01:01:05'), 3665);
  assert.equal(parseMatchTime('invalid'), 0);
});

test('isSeekDetected detects rewind and fast forward jumps', () => {
  // Normal playback: 100ms real elapsed, 0.1s media elapsed
  assert.equal(isSeekDetected(10.0, 10.1, 100, 1.0), false);

  // Normal playback at 2x: 100ms real elapsed, 0.2s media elapsed
  assert.equal(isSeekDetected(10.0, 10.2, 100, 2.0), false);

  // Rewind jump (backwards by 5s)
  assert.equal(isSeekDetected(20.0, 15.0, 50, 1.0), true);

  // Forward seek jump (skipped ahead by 30s)
  assert.equal(isSeekDetected(20.0, 50.0, 50, 1.0), true);
});

test('isDuplicateEvent accurately identifies identical events within threshold', () => {
  const existingEvents = [
    {
      id: 'e1',
      matchTimestamp: 506.4,
      eventType: 'shot',
      team: 'Team A'
    },
    {
      id: 'e2',
      matchTimestamp: 600.0,
      eventType: 'goal',
      team: 'Team A'
    }
  ];

  // Exact match within window
  assert.equal(
    isDuplicateEvent(
      { matchTimestamp: 507.0, eventType: 'shot', team: 'Team A' },
      existingEvents,
      2.5
    ),
    true
  );

  // Different event type at same time
  assert.equal(
    isDuplicateEvent(
      { matchTimestamp: 506.8, eventType: 'pass', team: 'Team A' },
      existingEvents,
      2.5
    ),
    false
  );

  // Different team
  assert.equal(
    isDuplicateEvent(
      { matchTimestamp: 507.0, eventType: 'shot', team: 'Team B' },
      existingEvents,
      2.5
    ),
    false
  );

  // Outside time window (e.g. 10 seconds later)
  assert.equal(
    isDuplicateEvent(
      { matchTimestamp: 520.0, eventType: 'shot', team: 'Team A' },
      existingEvents,
      2.5
    ),
    false
  );
});
