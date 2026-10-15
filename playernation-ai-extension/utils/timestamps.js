/**
 * Timestamps Utility for PlayerNation AI Logger
 * Handles match timestamp precision, conversions, seeking detection, and duplicate checks.
 */

/**
 * Format internal seconds timestamp to MM:SS or HH:MM:SS string.
 * @param {number} seconds - Timestamp in seconds.
 * @param {boolean} [includeHours=false] - Whether to enforce HH:MM:SS.
 * @returns {string} Formatted timestamp string.
 */
export function formatMatchTime(seconds, includeHours = false) {
  if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) {
    return '00:00';
  }

  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hrs > 0 || includeHours) {
    const hh = String(hrs).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  return `${mm}:${ss}`;
}

/**
 * Parse string timestamp (HH:MM:SS or MM:SS) to total seconds.
 * @param {string} timeStr - Formatted time string.
 * @returns {number} Seconds value.
 */
export function parseMatchTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;

  const parts = timeStr.trim().split(':').map(Number);
  if (parts.some(p => isNaN(p))) return 0;

  if (parts.length === 3) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  } else if (parts.length === 2) {
    const [m, s] = parts;
    return m * 60 + s;
  } else if (parts.length === 1) {
    return parts[0];
  }

  return 0;
}

/**
 * Determine if a timestamp jump represents a user seek or buffer gap rather than natural playback.
 * @param {number} prevTime - Previous frame time in seconds.
 * @param {number} currTime - Current frame time in seconds.
 * @param {number} elapsedRealMs - Real wall-clock elapsed time in milliseconds.
 * @param {number} [playbackRate=1.0] - Playback rate multiplier.
 * @param {number} [seekThresholdSec=1.5] - Delta threshold to classify as seek.
 * @returns {boolean} True if a seek occurred.
 */
export function isSeekDetected(prevTime, currTime, elapsedRealMs, playbackRate = 1.0, seekThresholdSec = 1.5) {
  if (prevTime == null || currTime == null) return false;

  const expectedDelta = (elapsedRealMs / 1000) * playbackRate;
  const actualDelta = currTime - prevTime;

  // If time went backwards or jumped forward by more than seek threshold above expected delta
  if (actualDelta < -0.2) return true;
  if (Math.abs(actualDelta - expectedDelta) > seekThresholdSec) return true;

  return false;
}

/**
 * Check if a candidate event is a duplicate of a recently logged event.
 * @param {object} candidate - { eventType, team, matchTimestamp }
 * @param {Array<object>} existingEvents - List of already registered events.
 * @param {number} [windowSeconds=2.5] - Time proximity window for deduplication.
 * @returns {boolean} True if duplicate.
 */
export function isDuplicateEvent(candidate, existingEvents, windowSeconds = 2.5) {
  if (!candidate || !existingEvents || !existingEvents.length) return false;

  return existingEvents.some(event => {
    if (event.eventType !== candidate.eventType) return false;
    if (candidate.team && event.team && candidate.team !== event.team) return false;

    const timeDiff = Math.abs(event.matchTimestamp - candidate.matchTimestamp);
    return timeDiff <= windowSeconds;
  });
}
