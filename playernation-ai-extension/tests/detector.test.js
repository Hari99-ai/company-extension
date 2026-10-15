import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateIoU, nonMaximumSuppression, parseYoloOutput } from '../detector/postprocessing.js';
import { unletterboxCoords } from '../detector/preprocessing.js';

test('calculateIoU computes accurate overlap ratio', () => {
  const boxA = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
  const boxB = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
  assert.ok(Math.abs(calculateIoU(boxA, boxB) - 1.0) < 1e-6);

  // Disjoint boxes
  const boxC = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 };
  assert.equal(calculateIoU(boxA, boxC), 0.0);

  // Partial overlap
  const boxD = { x: 0.2, y: 0.1, width: 0.2, height: 0.2 };
  const iou = calculateIoU(boxA, boxD);
  assert.ok(iou > 0.3 && iou < 0.4);
});

test('nonMaximumSuppression suppresses lower-confidence overlapping boxes', () => {
  const proposals = [
    { x: 0.1, y: 0.1, width: 0.2, height: 0.2, confidence: 0.9, classId: 0, className: 'player' },
    { x: 0.11, y: 0.11, width: 0.2, height: 0.2, confidence: 0.7, classId: 0, className: 'player' },
    { x: 0.6, y: 0.6, width: 0.2, height: 0.2, confidence: 0.85, classId: 0, className: 'player' }
  ];

  const filtered = nonMaximumSuppression(proposals, 0.45);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].confidence, 0.9);
  assert.equal(filtered[1].confidence, 0.85);
});

test('unletterboxCoords correctly maps 640x640 letterbox coordinates back to 1920x1080', () => {
  const letterbox = {
    scale: 640 / 1920, // 0.3333
    padX: 0,
    padY: 140,
    scaledW: 640,
    scaledH: 360
  };

  // Center of letterboxed area
  const boxIn640 = {
    x: 320 / 640, // 0.5
    y: (140 + 180) / 640, // 0.5
    width: 64 / 640, // 0.1
    height: 36 / 640
  };

  const unscaled = unletterboxCoords(boxIn640, letterbox, 1920, 1080);
  assert.equal(Math.round(unscaled.x), 960);
  assert.equal(Math.round(unscaled.y), 540);
});

test('parseYoloOutput extracts sports ball (class 32), filters oversized noise, and respects hint location', () => {
  // Mock YOLO raw tensor output: 1 proposal, 84 channels
  const numProposals = 2;
  const numChannels = 84;
  const rawData = new Float32Array(numChannels * numProposals);

  // Proposal 0: Sports ball at (cx=300, cy=300, w=15, h=15), conf=0.10
  rawData[0 * numProposals + 0] = 300; // cx
  rawData[1 * numProposals + 0] = 300; // cy
  rawData[2 * numProposals + 0] = 15;  // w
  rawData[3 * numProposals + 0] = 15;  // h
  rawData[(4 + 32) * numProposals + 0] = 0.10; // sports ball score

  // Proposal 1: Giant false positive (w=200, h=200), conf=0.30
  rawData[0 * numProposals + 1] = 400; // cx
  rawData[1 * numProposals + 1] = 400; // cy
  rawData[2 * numProposals + 1] = 200; // w (oversized)
  rawData[3 * numProposals + 1] = 200; // h
  rawData[(4 + 32) * numProposals + 1] = 0.30;

  const parsed = parseYoloOutput(rawData, numChannels, numProposals, {
    ballConfThreshold: 0.08,
    isCoco: true
  });

  // Giant proposal should be filtered out by reasonable ball size filter (w <= 0.09)
  assert.equal(parsed.allBalls.length, 1, 'Should filter out giant non-ball proposals');
  assert.ok(parsed.ball, 'Should detect valid sports ball');
  assert.equal(parsed.ball.className, 'ball');
  assert.ok(Math.abs(parsed.ball.confidence - 0.10) < 1e-4);
});
