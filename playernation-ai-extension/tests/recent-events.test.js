import test from 'node:test';
import assert from 'node:assert/strict';
import { getRecentEventsAroundTime } from '../logs/recent-events.js';

const makeEvents = timestamps => timestamps.map(matchTimestamp => ({ matchTimestamp }));

test('returns the five closest past and upcoming events around the live clock', () => {
  const events = makeEvents([30, 5, 60, 25, 45, 10, 50, 20, 40, 15, 55, 35]);
  const { past, upcoming } = getRecentEventsAroundTime(events, 30);

  assert.deepEqual(past.map(event => event.matchTimestamp), [30, 25, 20, 15, 10]);
  assert.deepEqual(upcoming.map(event => event.matchTimestamp), [35, 40, 45, 50, 55]);
});

test('uses an event at the current clock as past and ignores invalid timestamps', () => {
  const { past, upcoming } = getRecentEventsAroundTime([
    { matchTimestamp: 10 },
    { matchTimestamp: 12 },
    { matchTimestamp: Number.NaN }
  ], 10);

  assert.deepEqual(past.map(event => event.matchTimestamp), [10]);
  assert.deepEqual(upcoming.map(event => event.matchTimestamp), [12]);
});

test('supports fewer available events and configurable result limits', () => {
  const { past, upcoming } = getRecentEventsAroundTime(makeEvents([1, 2, 3, 4]), 3, 1);

  assert.deepEqual(past.map(event => event.matchTimestamp), [3]);
  assert.deepEqual(upcoming.map(event => event.matchTimestamp), [4]);
});
