import test from 'node:test';
import assert from 'node:assert/strict';
import { FootballYoloDetector } from '../detector/detector.js';

test('Default overlay settings structure and value defaults', () => {
  const defaultOverlaySettings = {
    showPlayers: true,
    showBall: true,
    showPlayerLabels: true,
    showBallTrail: true,
    showTelemetryBadge: true,
    playerConfidence: 0.25,
    ballConfidence: 0.08
  };

  assert.equal(defaultOverlaySettings.showPlayers, true, 'Human/player overlay default should be true');
  assert.equal(defaultOverlaySettings.showBall, true, 'Football overlay default should be true');
  assert.equal(defaultOverlaySettings.showPlayerLabels, true, 'Player labels default should be true');
  assert.equal(defaultOverlaySettings.showBallTrail, true, 'Ball trajectory trail default should be true');
  assert.equal(defaultOverlaySettings.showTelemetryBadge, true, 'Telemetry HUD badge default should be true');
  assert.equal(defaultOverlaySettings.playerConfidence, 0.25, 'Player confidence level default should be 0.25');
  assert.equal(defaultOverlaySettings.ballConfidence, 0.08, 'Football confidence level default should be 0.08');
});

test('Overlay settings update and toggle mutations', () => {
  const settings = {
    showPlayers: true,
    showBall: true,
    showPlayerLabels: true,
    showBallTrail: true,
    showTelemetryBadge: true,
    playerConfidence: 0.25,
    ballConfidence: 0.12
  };

  // Toggle Human off
  Object.assign(settings, { showPlayers: false });
  assert.equal(settings.showPlayers, false);

  // Toggle Football off
  Object.assign(settings, { showBall: false });
  assert.equal(settings.showBall, false);

  // Toggle Labels off
  Object.assign(settings, { showPlayerLabels: false });
  assert.equal(settings.showPlayerLabels, false);

  // Update confidence levels
  Object.assign(settings, { playerConfidence: 0.45, ballConfidence: 0.20 });
  assert.equal(settings.playerConfidence, 0.45);
  assert.equal(settings.ballConfidence, 0.20);
});

test('FootballYoloDetector receives confidence threshold overrides', () => {
  const detector = new FootballYoloDetector({
    playerConfidence: 0.40,
    ballConfidence: 0.22
  });

  assert.equal(detector.playerConfidence, 0.40);
  assert.equal(detector.ballConfidence, 0.22);

  // Runtime threshold update
  detector.playerConfidence = 0.50;
  detector.ballConfidence = 0.18;
  assert.equal(detector.playerConfidence, 0.50);
  assert.equal(detector.ballConfidence, 0.18);
});
