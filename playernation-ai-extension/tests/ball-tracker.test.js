import test from 'node:test';
import assert from 'node:assert/strict';
import { BallTracker } from '../tracking/ball-tracker.js';

test('BallTracker setManualBall creates a manual lock and registers position', () => {
  const tracker = new BallTracker();
  assert.equal(tracker.currentBall, null);
  assert.equal(tracker.manualLock, false);

  const res = tracker.setManualBall(0.5, 0.45, 12.0);
  assert.ok(res.ball, 'Ball should be initialized');
  assert.equal(res.ball.isManual, true);
  assert.equal(res.ball.cx, 0.5);
  assert.equal(res.ball.cy, 0.45);
  assert.equal(res.ball.confidence, 1.0);
  assert.equal(res.manualLock, true);
  assert.equal(tracker.manualLock, true);
  assert.equal(tracker.lostFrames, 0);
  assert.equal(res.trail.length, 1);
});

test('BallTracker checks player possession when setManualBall is invoked near player feet', () => {
  const tracker = new BallTracker();
  const mockPlayers = [
    { id: 'p1', x: 0.45, y: 0.35, width: 0.08, height: 0.12, team: 'Team A' }, // feet at ~ (0.49, 0.452)
    { id: 'p2', x: 0.80, y: 0.70, width: 0.08, height: 0.12, team: 'Team B' }
  ];

  const res = tracker.setManualBall(0.49, 0.45, 15.0, mockPlayers);
  assert.ok(res.inPossessionPlayer, 'Player near tagged ball should be detected in possession');
  assert.equal(res.inPossessionPlayer.id, 'p1');
});

test('BallTracker snaps to candidate ball proposals when primary detection is null', () => {
  const tracker = new BallTracker();
  // Initialize ball at (0.3, 0.3)
  tracker.setManualBall(0.3, 0.3, 10.0);

  const candidateBalls = [
    { x: 0.85, y: 0.85, width: 0.02, height: 0.02, confidence: 0.15 }, // far away
    { x: 0.31, y: 0.31, width: 0.02, height: 0.02, confidence: 0.18 }  // close to ball
  ];

  // Primary detectedBall is null
  const updateRes = tracker.update(null, 10.1, [], candidateBalls);
  assert.ok(updateRes.ball, 'Ball should be updated using candidate proposals');
  assert.ok(Math.abs(updateRes.ball.cx - 0.32) < 0.02, 'Should snap to candidate ball near (0.32, 0.32)');
});

test('BallTracker clearManualLock releases the lock flag', () => {
  const tracker = new BallTracker();
  tracker.setManualBall(0.5, 0.5, 20.0);
  assert.equal(tracker.manualLock, true);

  tracker.clearManualLock();
  assert.equal(tracker.manualLock, false);
  assert.equal(tracker.currentBall.isManual, false);
});

test('BallTracker maintains manualLock status persistently across multiple update frames', () => {
  const tracker = new BallTracker();
  tracker.setManualBall(0.4, 0.4, 1.0);
  assert.equal(tracker.manualLock, true);

  // Update across 30 frames with no detections (e.g. fast flight or occlusion)
  for (let i = 0; i < 30; i++) {
    const res = tracker.update(null, 1.0 + (i + 1) * 0.1, []);
    assert.equal(res.manualLock, true, `manualLock should remain true on frame ${i}`);
    assert.equal(tracker.manualLock, true);
    assert.ok(res.ball, `ball should still be tracked via extrapolation on frame ${i}`);
    assert.equal(res.ball.isManual, true);
  }
});

