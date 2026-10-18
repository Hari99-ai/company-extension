import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkEventLogs } from '../logs/bulk-log-parser.js';

test('parses bulk event lines and retains player details', () => {
  const result = parseBulkEventLogs([
    'End at 00:10:04 by (Name: , PID: A1, Jersey: , Manual ID: )',
    'Shot at 00:10:15 by (Name: Alex, PID: A1, Jersey: 9, Manual ID: M-12)'
  ].join('\n'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].eventType, 'end');
  assert.equal(result.events[0].matchTimestamp, 604);
  assert.equal(result.events[0].pid, 'A1');
  assert.equal(result.events[1].eventLabel, 'Shot');
  assert.equal(result.events[1].playerName, 'Alex');
  assert.equal(result.events[1].jersey, '9');
  assert.equal(result.events[1].manualId, 'M-12');
  assert.equal(result.events[1].status, 'confirmed');
});

test('parses numbered pipe-delimited bulk event lines', () => {
  const result = parseBulkEventLogs([
    '1. Kickoff at 00:00:06 by | | | A1',
    '2. Pass at 00:00:11 by Alex | A1 | 9 | M-12'
  ].join('\n'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].eventType, 'kickoff');
  assert.equal(result.events[0].matchTimestamp, 6);
  assert.equal(result.events[0].playerName, '');
  assert.equal(result.events[0].pid, '');
  assert.equal(result.events[0].jersey, '');
  assert.equal(result.events[0].manualId, 'A1');
  assert.equal(result.events[1].eventLabel, 'Pass');
  assert.equal(result.events[1].playerName, 'Alex');
  assert.equal(result.events[1].pid, 'A1');
  assert.equal(result.events[1].jersey, '9');
  assert.equal(result.events[1].manualId, 'M-12');
});

test('reports invalid rows while keeping valid rows in the bulk result', () => {
  const result = parseBulkEventLogs([
    'Shot at 00:10:15 by (Name: , PID: A1, Jersey: , Manual ID: )',
    'Bad row',
    'End at 00:61:04 by (Name: , PID: A1, Jersey: , Manual ID: )'
  ].join('\n'));

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.errors.map(error => error.line), [2, 3]);
});

test('requires input and rejects invalid detail field formats', () => {
  assert.equal(parseBulkEventLogs(' \n ').errors[0].line, 0);
  const result = parseBulkEventLogs('Shot at 00:10:15 by (PID: A1, Name: , Jersey: , Manual ID: )');
  assert.equal(result.events.length, 0);
  assert.equal(result.errors[0].line, 1);
});
