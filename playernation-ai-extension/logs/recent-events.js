export function getRecentEventsAroundTime(events, currentTime, limit = 5) {
  const now = Number.isFinite(currentTime) ? currentTime : 0;
  const count = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const validEvents = events.filter(event => Number.isFinite(event.matchTimestamp));
  const past = validEvents
    .filter(event => event.matchTimestamp <= now)
    .sort((a, b) => b.matchTimestamp - a.matchTimestamp)
    .slice(0, count);
  const upcoming = validEvents
    .filter(event => event.matchTimestamp > now)
    .sort((a, b) => a.matchTimestamp - b.matchTimestamp)
    .slice(0, count);

  return { past, upcoming };
}
