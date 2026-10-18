export function getFootballTrainingReminderMinute(matchTimestamp, lastReminderMinute, enabled = true) {
  if (!enabled) return null;
  if (!Number.isFinite(matchTimestamp) || matchTimestamp < 60) return null;

  const currentMinute = Math.floor(matchTimestamp / 60);
  return currentMinute > lastReminderMinute ? currentMinute : null;
}

export function createFootballTrainingAnnotation(
  x,
  y,
  letterbox = { padX: 0, padY: 0, scaledW: 640, scaledH: 640 },
  radius = 0.012
) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error('Football label coordinates must be normalized between 0 and 1.');
  }
  if (!letterbox.scaledW || !letterbox.scaledH || radius <= 0) {
    throw new Error('Football training annotation requires valid frame dimensions and radius.');
  }

  const centerX = (x * letterbox.scaledW + letterbox.padX) / 640;
  const centerY = (y * letterbox.scaledH + letterbox.padY) / 640;
  const width = Math.min(1, (radius * 2 * letterbox.scaledW) / 640);
  const height = Math.min(1, (radius * 2 * letterbox.scaledH) / 640);
  const left = Math.max(0, Math.min(1 - width, centerX - width / 2));
  const top = Math.max(0, Math.min(1 - height, centerY - height / 2));

  return {
    category: 'football',
    classId: 32,
    bbox: {
      x: left + width / 2,
      y: top + height / 2,
      width,
      height,
      format: 'normalized-center'
    }
  };
}
