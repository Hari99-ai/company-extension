/**
 * Event Log Export Utility
 * Serializes match events into JSON and CSV data formats.
 */

import { formatMatchTime } from '../utils/timestamps.js';

export function eventsToJson(events) {
  return JSON.stringify(events, null, 2);
}

export function eventsToCsv(events) {
  const headers = [
    'Match Time',
    'Event Type',
    'Team',
    'Player',
    'Confidence',
    'Status',
    'Timestamp (s)',
    'Evidence'
  ];

  const rows = events.map(e => [
    `"${formatMatchTime(e.matchTimestamp)}"`,
    `"${e.eventType}"`,
    `"${e.team || 'Unknown'}"`,
    `"${e.playerId || 'Unknown'}"`,
    `"${Math.round((e.confidence || 0) * 100)}%"`,
    `"${e.status}"`,
    e.matchTimestamp,
    `"${(e.evidence || []).join('; ')}"`
  ]);

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}
