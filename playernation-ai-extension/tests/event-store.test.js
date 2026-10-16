import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchEventStore } from '../logs/event-store.js';

test('adds bulk events with player details and persists them as a batch', () => {
  const store = new MatchEventStore();
  let persistCount = 0;
  store.persist = () => {
    persistCount += 1;
  };

  const result = store.addEvents([
    {
      eventType: 'shot',
      eventLabel: 'Shot',
      matchTimestamp: 615,
      playerName: 'Alex',
      pid: 'A1',
      jersey: '9',
      manualId: 'M-12',
      status: 'confirmed',
      source: 'bulk-import'
    },
    {
      eventType: 'shot',
      matchTimestamp: 615,
      playerName: 'Alex',
      pid: 'A1'
    },
    {
      eventType: 'shot',
      matchTimestamp: 615,
      playerName: 'Sam',
      pid: 'A2'
    }
  ]);

  assert.equal(result.added.length, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(persistCount, 1);
  assert.equal(result.added[0].playerId, 'A1');
  assert.equal(result.added[0].playerName, 'Alex');
  assert.equal(result.added[0].jersey, '9');
  assert.equal(result.added[0].manualId, 'M-12');
  assert.equal(result.added[0].source, 'bulk-import');
  assert.equal(result.added[1].playerId, 'A2');
});
