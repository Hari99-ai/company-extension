import { parseMatchTime } from '../utils/timestamps.js';

const LINE_PATTERN = /^(.+?)\s+at\s+(\d{2}:\d{2}:\d{2})\s+by\s+\((.*)\)\s*$/i;
const FIELDS_PATTERN = /^\s*Name:\s*([^,]*),\s*PID:\s*([^,]*),\s*Jersey:\s*([^,]*),\s*Manual ID:\s*([^,)]*)\s*$/i;

export function parseBulkEventLogs(text) {
  const events = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    const match = LINE_PATTERN.exec(line);
    const fields = match && FIELDS_PATTERN.exec(match[3]);
    if (!match || !fields) {
      errors.push({ line: index + 1, message: 'Expected: Event at HH:MM:SS by (Name: ..., PID: ..., Jersey: ..., Manual ID: ...).' });
      return;
    }

    const [, eventLabel, time] = match;
    const [, minutes, seconds] = time.split(':').map(Number);
    if (minutes > 59 || seconds > 59) {
      errors.push({ line: index + 1, message: 'Minutes and seconds must be between 00 and 59.' });
      return;
    }

    const normalizedEventType = eventLabel.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!normalizedEventType) {
      errors.push({ line: index + 1, message: 'Event name is required.' });
      return;
    }

    const [, playerName, pid, jersey, manualId] = fields;
    const matchTimestamp = parseMatchTime(time);
    events.push({
      eventType: normalizedEventType,
      eventLabel: eventLabel.trim(),
      matchTimestamp,
      team: 'Unknown',
      playerId: pid.trim() || playerName.trim() || null,
      playerName: playerName.trim(),
      pid: pid.trim(),
      jersey: jersey.trim(),
      manualId: manualId.trim(),
      confidence: 1,
      status: 'confirmed',
      evidence: [],
      source: 'bulk-import'
    });
  });

  if (events.length === 0 && errors.length === 0) {
    errors.push({ line: 0, message: 'Paste one or more event lines to add.' });
  }

  return { events, errors };
}
