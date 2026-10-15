import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFootballTrainingAnnotation,
  getFootballTrainingReminderMinute
} from '../utils/football-training.js';

test('football training reminders occur once when match time crosses each minute', () => {
  assert.equal(getFootballTrainingReminderMinute(59.9, 0), null);
  assert.equal(getFootballTrainingReminderMinute(60, 0), 1);
  assert.equal(getFootballTrainingReminderMinute(119.9, 1), null);
  assert.equal(getFootballTrainingReminderMinute(120, 1), 2);
  assert.equal(getFootballTrainingReminderMinute(180, 1), 3);
});

test('football training annotations map video coordinates through letterboxing', () => {
  const annotation = createFootballTrainingAnnotation(0.5, 0.5, {
    padX: 0,
    padY: 140,
    scaledW: 640,
    scaledH: 360
  });

  assert.equal(annotation.category, 'football');
  assert.equal(annotation.classId, 32);
  assert.equal(annotation.bbox.x, 0.5);
  assert.equal(annotation.bbox.y, 0.5);
  assert.equal(annotation.bbox.width, 0.024);
  assert.ok(Math.abs(annotation.bbox.height - 0.0135) < 1e-12);
});

test('football training annotations keep boxes inside the captured frame', () => {
  const annotation = createFootballTrainingAnnotation(0, 0);

  assert.equal(annotation.bbox.x, annotation.bbox.width / 2);
  assert.equal(annotation.bbox.y, annotation.bbox.height / 2);
  assert.ok(annotation.bbox.x + annotation.bbox.width / 2 <= 1);
  assert.ok(annotation.bbox.y + annotation.bbox.height / 2 <= 1);
});
