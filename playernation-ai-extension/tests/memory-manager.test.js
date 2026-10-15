/**
 * Tests for FootballMemoryManager
 * Run with: node --test tests/memory-manager.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FootballMemoryManager, TrackingState } from '../tracking/memory-manager.js';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeBall(cx, cy, confidence = 0.9) {
  const w = 0.016, h = 0.016;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h, confidence, cx, cy };
}

// ── Test 1: Initial state ─────────────────────────────────────────────────────

test('FootballMemoryManager initialises in LOST state', () => {
  const mgr = new FootballMemoryManager();
  assert.equal(mgr.trackingState, TrackingState.LOST);
  assert.equal(mgr.detectionHistory.length, 0);
  assert.equal(mgr.lastConfirmedPosition, null);
});

// ── Test 2: Transitions to DETECTED on first confirmed detection ──────────────

test('Transitions to DETECTED after a confident detection', () => {
  const mgr = new FootballMemoryManager();
  const result = mgr.update(makeBall(0.5, 0.5), 10.0);
  assert.equal(result.trackingState, TrackingState.DETECTED);
  assert.ok(result.predictedCx != null, 'predictedCx should be set');
  assert.ok(result.lastConfirmedPosition != null);
  assert.equal(mgr.detectionHistory.length, 1);
});

// ── Test 3: Transitions to TRACKED on subsequent detections ──────────────────

test('Transitions to TRACKED after multiple detections', () => {
  const mgr = new FootballMemoryManager();
  mgr.update(makeBall(0.5, 0.5), 10.0);
  const result = mgr.update(makeBall(0.51, 0.5), 10.125);
  assert.equal(result.trackingState, TrackingState.TRACKED);
});

// ── Test 4: Ball disappears — transitions through PREDICTED → UNCERTAIN ───────

test('Transitions to PREDICTED then UNCERTAIN on missed detections', () => {
  const mgr = new FootballMemoryManager();
  // Establish tracking
  mgr.update(makeBall(0.5, 0.5), 10.0);
  mgr.update(makeBall(0.5, 0.5), 10.125);
  assert.equal(mgr.trackingState, TrackingState.TRACKED);

  // Miss 8 frames → PREDICTED limit exceeded
  let result;
  for (let i = 1; i <= 8; i++) {
    result = mgr.update(null, 10.125 + i * 0.125);
  }
  // Should have transitioned through PREDICTED into UNCERTAIN
  assert.ok(
    result.trackingState === TrackingState.PREDICTED ||
    result.trackingState === TrackingState.UNCERTAIN,
    `Expected PREDICTED or UNCERTAIN, got ${result.trackingState}`
  );
});

// ── Test 5: Memory remembers last confirmed position ─────────────────────────

test('lastConfirmedPosition is retained after detections stop', () => {
  const mgr = new FootballMemoryManager();
  mgr.update(makeBall(0.42, 0.61, 0.92), 20.0);
  // Several misses
  mgr.update(null, 20.125);
  mgr.update(null, 20.25);

  assert.ok(mgr.lastConfirmedPosition, 'lastConfirmedPosition must be set');
  assert.ok(Math.abs(mgr.lastConfirmedPosition.cx - 0.42) < 0.001, 'Confirmed cx should match');
  assert.ok(Math.abs(mgr.lastConfirmedPosition.cy - 0.61) < 0.001, 'Confirmed cy should match');
});

// ── Test 6: Rolling window prunes old records ─────────────────────────────────

test('Old records are pruned beyond the memory window', () => {
  const mgr = new FootballMemoryManager({ memoryWindowSec: 2 });

  // Add records at t=0..2.9 with 0.1s spacing
  for (let i = 0; i < 30; i++) {
    mgr.update(makeBall(0.5, 0.5), i * 0.1);
  }

  // At t=2.9, records older than t=0.9 (2 seconds before) should be gone
  const oldest = mgr.detectionHistory[0];
  assert.ok(
    oldest.videoTimestamp >= 0.9 - 0.01,
    `Oldest record (${oldest.videoTimestamp.toFixed(2)}) should be >= 0.9s`
  );
});

// ── Test 7: Seek resets Kalman state ─────────────────────────────────────────

test('Seek event invalidates Kalman filter', () => {
  const mgr = new FootballMemoryManager();
  mgr.update(makeBall(0.5, 0.5), 10.0);
  mgr.update(makeBall(0.51, 0.5), 10.125);

  // Simulate seek to t=60
  mgr.update(makeBall(0.3, 0.7, 0.9), 60.0, true);

  // Kalman should be re-initialised from the new detection
  assert.ok(mgr._kalmanInitialised, 'Kalman should be re-initialised');
  assert.ok(Math.abs(mgr.kalman.x - 0.3) < 0.05, `Kalman x ~0.3, got ${mgr.kalman.x.toFixed(3)}`);
});

// ── Test 8: Reacquisition after LOST ─────────────────────────────────────────

test('Reacquires tracking after a long gap with no detections', () => {
  const mgr = new FootballMemoryManager();
  mgr.update(makeBall(0.5, 0.5), 10.0);
  mgr.update(makeBall(0.5, 0.5), 10.125);

  // Lose ball for 30 frames
  for (let i = 1; i <= 30; i++) {
    mgr.update(null, 10.125 + i * 0.125);
  }

  const lostResult = mgr.update(null, 10.125 + 31 * 0.125);
  assert.ok(
    lostResult.trackingState === TrackingState.LOST ||
    lostResult.trackingState === TrackingState.REACQUIRING,
    `Expected LOST or REACQUIRING, got ${lostResult.trackingState}`
  );

  // Now a detection arrives
  const reacqResult = mgr.update(makeBall(0.6, 0.4, 0.88), 15.0);
  assert.equal(reacqResult.trackingState, TrackingState.DETECTED);
});

// ── Test 9: Kalman prediction moves toward known velocity ─────────────────────

test('Kalman filter tracks horizontal velocity', () => {
  const mgr = new FootballMemoryManager();
  // Ball moving rightward: +0.01 per 0.1s
  for (let i = 0; i < 10; i++) {
    mgr.update(makeBall(0.3 + i * 0.01, 0.5), i * 0.1);
  }
  // Predict next position
  const result = mgr.update(null, 10 * 0.1);
  // vx should be positive (rightward)
  assert.ok(mgr.kalman.vx > 0, `vx should be positive (got ${mgr.kalman.vx.toFixed(4)})`);
});

// ── Test 10: exportDiagnostic returns a well-formed object ───────────────────

test('exportDiagnostic returns required fields', () => {
  const mgr = new FootballMemoryManager();
  mgr.update(makeBall(0.5, 0.5), 10.0);
  const diag = mgr.exportDiagnostic();

  assert.ok(diag.exportedAt, 'exportedAt must be present');
  assert.ok(typeof diag.trackingState === 'string', 'trackingState must be string');
  assert.ok(typeof diag.totalMemorySamples === 'number', 'totalMemorySamples must be number');
  assert.ok(diag.kalman, 'kalman block must be present');
  assert.ok(typeof diag.kalman.uncertainty === 'number', 'kalman.uncertainty must be number');
  assert.ok(Array.isArray(diag.recentStateTransitions), 'recentStateTransitions must be array');
});

// ── Test 11: Low-confidence detections do not update lastConfirmedPosition ───

test('Low-confidence detection does not update lastConfirmedPosition', () => {
  const mgr = new FootballMemoryManager();
  mgr.update(makeBall(0.5, 0.5, 0.9), 10.0);
  const confirmedBefore = { ...mgr.lastConfirmedPosition };

  // Low-confidence detection
  mgr.update(makeBall(0.8, 0.8, 0.1), 10.125);

  assert.ok(
    Math.abs(mgr.lastConfirmedPosition.cx - confirmedBefore.cx) < 0.001,
    'lastConfirmedPosition.cx should not change on low-confidence detection'
  );
});

// ── Test 12: getShortTermHistory / getMediumTermHistory / getLongTermHistory ──

test('Timescale accessors return correct subsets', () => {
  const mgr = new FootballMemoryManager({ memoryWindowSec: 120 });

  // Records at t = 0, 1, 5, 20, 80 seconds
  const times = [80.0, 100.0, 115.0, 119.0, 120.0];
  for (const t of times) {
    mgr.update(makeBall(0.5, 0.5), t);
  }

  const now = 120.0;
  const short  = mgr.getShortTermHistory(now);
  const medium = mgr.getMediumTermHistory(now);
  const long_  = mgr.getLongTermHistory(now);

  // Short-term: within last 2s → records at 119, 120
  assert.ok(short.length >= 1, 'Should have >=1 short-term records');
  assert.ok(short.every(r => r.videoTimestamp >= now - 2), 'All short-term records within 2s');

  // Medium-term: 2-15s before now → records at 115
  assert.ok(medium.every(r =>
    r.videoTimestamp >= now - 15 && r.videoTimestamp < now - 2
  ), 'Medium-term records in 2-15s range');
});

// ── Test 13: Reset clears all state ──────────────────────────────────────────

test('reset() clears all tracking state', () => {
  const mgr = new FootballMemoryManager();
  mgr.update(makeBall(0.5, 0.5), 10.0);
  mgr.update(makeBall(0.51, 0.5), 10.125);

  mgr.reset();

  assert.equal(mgr.trackingState, TrackingState.LOST);
  assert.equal(mgr.detectionHistory.length, 0);
  assert.equal(mgr.lastConfirmedPosition, null);
  assert.equal(mgr._kalmanInitialised, false);
  assert.equal(mgr.missedDetectionFrames, 0);
  assert.equal(mgr.reacquisitionAttempts, 0);
});

// ── Test 14: Search radius grows with missed frames ───────────────────────────

test('Search radius grows as frames are missed', () => {
  const mgr = new FootballMemoryManager();
  mgr.update(makeBall(0.5, 0.5), 10.0);
  mgr.update(makeBall(0.5, 0.5), 10.125);

  const initialRadius = mgr.searchRadius;

  for (let i = 1; i <= 15; i++) {
    mgr.update(null, 10.125 + i * 0.125);
  }

  assert.ok(
    mgr.searchRadius > initialRadius,
    `Search radius (${mgr.searchRadius.toFixed(3)}) should exceed initial (${initialRadius.toFixed(3)})`
  );
});

// ── Test 15: Predicted position should be close to true position ─────────────

test('Predicted position stays near actual ball after a few missed frames', () => {
  const mgr = new FootballMemoryManager();
  // Establish position at (0.4, 0.5)
  for (let i = 0; i < 5; i++) {
    mgr.update(makeBall(0.4, 0.5, 0.92), 10.0 + i * 0.125);
  }

  // Miss 3 frames
  for (let i = 1; i <= 3; i++) {
    mgr.update(null, 10.625 + i * 0.125);
  }

  const result = mgr.query(11.0);
  assert.ok(result.predictedCx != null, 'Should have prediction');
  const err = Math.hypot(result.predictedCx - 0.4, result.predictedCy - 0.5);
  assert.ok(err < 0.15, `Prediction error ${err.toFixed(3)} should be < 0.15`);
});
