/**
 * coord-transform.test.js
 * =======================
 * Automated tests for utils/coord-transform.js.
 *
 * Tests cover every coordinate-system boundary described in the spec:
 *   TC1 – 1920×1080 video, 640×640 model, 1227×613 canvas
 *   TC2 – 1280×720 video (different aspect)
 *   TC3 – 4:3 video (960×720)
 *   TC4 – round-trip forward+inverse identity check
 *   TC5 – canvas resize: same normalised box → different canvas pixel coords
 *   TC6 – ball trail: all points use the same coordinate system
 *   TC7 – detection hint: videoNormToModelNorm is the exact inverse of modelBoxToVideoNorm
 *
 * Run with:
 *   node --test tests/coord-transform.test.js
 */

import test       from 'node:test';
import assert     from 'node:assert/strict';
import {
  computeLetterbox,
  modelBoxToVideoNorm,
  videoNormToCanvas,
  videoNormToModelNorm,
  videoNormPointToCanvas,
  canvasPointToVideoNorm
} from '../utils/coord-transform.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const EPSILON = 1e-6;

function approxEqual(a, b, eps = EPSILON, msg = '') {
  const diff = Math.abs(a - b);
  assert.ok(
    diff <= eps,
    `${msg ? msg + ': ' : ''}expected |${a} - ${b}| <= ${eps}, got ${diff}`
  );
}

function approxBox(actual, expected, eps = EPSILON, label = '') {
  for (const key of ['x', 'y', 'width', 'height']) {
    approxEqual(actual[key], expected[key], eps, `${label}.${key}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1 – Primary use-case from the spec
// ─────────────────────────────────────────────────────────────────────────────
test('TC1: computeLetterbox – 1920×1080 → 640×640', () => {
  const lb = computeLetterbox(1920, 1080);
  // scale = min(640/1920, 640/1080) = min(0.333…, 0.592…) = 0.333…
  const expectedScale = 640 / 1920;
  approxEqual(lb.scale,   expectedScale,    1e-9, 'scale');
  approxEqual(lb.scaledW, 640,              0.5,  'scaledW');
  approxEqual(lb.scaledH, 360,              0.5,  'scaledH');
  approxEqual(lb.padX,    0,                0.5,  'padX');
  approxEqual(lb.padY,    140,              0.5,  'padY');   // (640-360)/2
  assert.equal(lb.modelW, 640);
  assert.equal(lb.modelH, 640);
});

test('TC1: modelBoxToVideoNorm – football centre-field, 1920×1080 video', () => {
  // Suppose YOLO returns a ball at canvas centre: cx=320,cy=320 in model pixels
  // i.e. model-output normalised: x=0.46875, y=0.46875, w=0.025, h=0.025
  const vW = 1920, vH = 1080;
  const lb = computeLetterbox(vW, vH);
  // (320 - padX) / scale = (320 - 0) / (640/1920) = 320 * 3 = 960  → 960/1920 = 0.5
  // (320 - padY) / scale = (320 - 140) / (640/1920) = 180 * 3 = 540 → 540/1080 = 0.5
  const modelBox = { x: 320/640 - 0.0125, y: 320/640 - 0.0125, width: 0.025, height: 0.025 };
  const videoBox = modelBoxToVideoNorm(modelBox, lb, vW, vH);

  approxEqual(videoBox.cx, 0.5, 1e-5, 'cx should be 0.5 (centre)');
  approxEqual(videoBox.cy, 0.5, 1e-5, 'cy should be 0.5 (centre)');
  assert.ok(videoBox.width  > 0, 'width > 0');
  assert.ok(videoBox.height > 0, 'height > 0');
  assert.ok(videoBox.x >= 0 && videoBox.x <= 1, 'x in [0,1]');
  assert.ok(videoBox.y >= 0 && videoBox.y <= 1, 'y in [0,1]');
});

test('TC1: videoNormToCanvas maps correctly to 1227×613 display', () => {
  // Ball at normalised centre (0.5, 0.5)
  const normBox   = { x: 0.49, y: 0.49, width: 0.02, height: 0.02, cx: 0.5, cy: 0.5 };
  const canvasBox = videoNormToCanvas(normBox, 1227, 613);

  approxEqual(canvasBox.cx, 1227 * 0.5, 1, 'canvas cx');
  approxEqual(canvasBox.cy,  613 * 0.5, 1, 'canvas cy');
  approxEqual(canvasBox.x,  1227 * 0.49, 1, 'canvas x');
  approxEqual(canvasBox.y,   613 * 0.49, 1, 'canvas y');
  approxEqual(canvasBox.width,  1227 * 0.02, 0.1, 'canvas width');
  approxEqual(canvasBox.height,  613 * 0.02, 0.1, 'canvas height');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2 – 1280×720 video (different aspect, same model)
// ─────────────────────────────────────────────────────────────────────────────
test('TC2: computeLetterbox – 1280×720 → 640×640', () => {
  const lb = computeLetterbox(1280, 720);
  const expectedScale = 640 / 1280; // = 0.5
  approxEqual(lb.scale,   expectedScale, 1e-9);
  approxEqual(lb.scaledW, 640,           0.5);
  approxEqual(lb.scaledH, 360,           0.5);
  approxEqual(lb.padX,    0,             0.5);
  approxEqual(lb.padY,    140,           0.5);
});

test('TC2: modelBoxToVideoNorm – top-left corner ball at 1280×720', () => {
  const vW = 1280, vH = 720;
  const lb = computeLetterbox(vW, vH);
  // Ball in top-left quadrant: model pixel (80, 180) after padding = (80-0, 180-140)=(80,40)
  // → original video pixel: 80/0.5=160, 40/0.5=80
  // → normalised: 160/1280=0.125, 80/720=0.111
  const modelBox = { x: 80/640 - 0.01, y: 180/640 - 0.01, width: 0.02, height: 0.02 };
  const videoBox = modelBoxToVideoNorm(modelBox, lb, vW, vH);
  approxEqual(videoBox.cx, (80/0.5) / vW, 0.01, 'cx');
  approxEqual(videoBox.cy, (40/0.5) / vH, 0.01, 'cy');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3 – 4:3 video (960×720) – vertical padding on sides (padX != 0)
// ─────────────────────────────────────────────────────────────────────────────
test('TC3: computeLetterbox – 960×720 → 640×640 (side padding)', () => {
  const lb = computeLetterbox(960, 720);
  // scale = min(640/960, 640/720) = min(0.6667, 0.8889) = 0.6667
  const expectedScale = 640 / 960;
  approxEqual(lb.scale,   expectedScale, 1e-6);
  approxEqual(lb.scaledW, 640,           0.5);
  approxEqual(lb.scaledH, Math.round(720 * expectedScale), 0.5);
  approxEqual(lb.padX,    0,             0.5);  // no horizontal padding
  assert.ok(lb.padY > 0, 'vertical padding should be > 0 for 4:3');
});

test('TC3: modelBoxToVideoNorm – 960×720 inverse letterbox is correct', () => {
  const vW = 960, vH = 720;
  const lb = computeLetterbox(vW, vH);
  // Place ball at model pixel (320, 320)
  // padX=0, padY = round((640 - scaledH)/2)
  // → origX = (320 - padX) / scale, origY = (320 - padY) / scale
  const mpx = 320, mpy = 320;
  const origX = (mpx - lb.padX) / lb.scale;
  const origY = (mpy - lb.padY) / lb.scale;
  const normBoxIn = {
    x: (mpx / 640) - 0.01,
    y: (mpy / 640) - 0.01,
    width: 0.02,
    height: 0.02
  };
  const out = modelBoxToVideoNorm(normBoxIn, lb, vW, vH);
  approxEqual(out.cx, origX / vW, 0.01, '4:3 cx');
  approxEqual(out.cy, origY / vH, 0.01, '4:3 cy');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4 – Round-trip: C → D → C (identity within float precision)
// ─────────────────────────────────────────────────────────────────────────────
test('TC4: round-trip modelBoxToVideoNorm → videoNormToModelNorm is identity', () => {
  const vW = 1920, vH = 1080;
  const lb = computeLetterbox(vW, vH);

  const originalModelBox = { x: 0.3, y: 0.4, width: 0.04, height: 0.04 };
  const originalCx = originalModelBox.x + originalModelBox.width  / 2;
  const originalCy = originalModelBox.y + originalModelBox.height / 2;

  // Forward: C → D
  const videoNorm = modelBoxToVideoNorm(originalModelBox, lb, vW, vH);

  // Inverse: D → C
  const reconstructed = videoNormToModelNorm(videoNorm.cx, videoNorm.cy, vW, vH, lb);

  approxEqual(reconstructed.hx, originalCx, 1e-5, 'round-trip cx');
  approxEqual(reconstructed.hy, originalCy, 1e-5, 'round-trip cy');
});

test('TC4: canvasPointToVideoNorm → videoNormPointToCanvas is identity', () => {
  const cx = 614, cy = 307;
  const cW = 1227, cH = 613;

  const norm    = canvasPointToVideoNorm(cx, cy, cW, cH);
  const back    = videoNormPointToCanvas(norm.nx, norm.ny, cW, cH);

  approxEqual(back.x, cx, 0.01, 'canvas x round-trip');
  approxEqual(back.y, cy, 0.01, 'canvas y round-trip');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC5 – Canvas resize: same normalised detection → correct new canvas coords
// ─────────────────────────────────────────────────────────────────────────────
test('TC5: videoNormToCanvas scales correctly after window resize', () => {
  const normBox = { x: 0.4, y: 0.3, width: 0.05, height: 0.05, cx: 0.425, cy: 0.325 };

  const before = videoNormToCanvas(normBox, 1227, 613);
  const after  = videoNormToCanvas(normBox, 800,  450);

  // Normalised position should be the same fraction of each canvas
  approxEqual(before.cx / 1227, after.cx / 800, 1e-5, 'normalised cx unchanged');
  approxEqual(before.cy / 613,  after.cy / 450, 1e-5, 'normalised cy unchanged');
  approxEqual(before.width  / 1227, after.width  / 800, 1e-5, 'normalised width unchanged');
  approxEqual(before.height / 613,  after.height / 450, 1e-5, 'normalised height unchanged');

  // Absolute pixel positions must differ
  assert.ok(Math.abs(before.cx - after.cx) > 10, 'canvas cx should change on resize');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6 – Ball trail: all trail points must use the same coordinate system (D)
// ─────────────────────────────────────────────────────────────────────────────
test('TC6: ball trail points are all normalised-video coords, not mixed spaces', () => {
  const vW = 1920, vH = 1080;
  const lb = computeLetterbox(vW, vH);

  // Simulate three successive detections from the model
  const modelBoxes = [
    { x: 0.40, y: 0.42, width: 0.025, height: 0.025 },
    { x: 0.41, y: 0.43, width: 0.025, height: 0.025 },
    { x: 0.42, y: 0.44, width: 0.025, height: 0.025 }
  ];

  const trail = modelBoxes.map(mb => {
    const vb = modelBoxToVideoNorm(mb, lb, vW, vH);
    return { cx: vb.cx, cy: vb.cy };
  });

  // All trail cx/cy values must be in [0,1] (normalised video)
  for (const pt of trail) {
    assert.ok(pt.cx >= 0 && pt.cx <= 1, `cx out of range: ${pt.cx}`);
    assert.ok(pt.cy >= 0 && pt.cy <= 1, `cy out of range: ${pt.cy}`);
  }

  // Trail should be monotonically increasing (ball moving right/down)
  assert.ok(trail[1].cx > trail[0].cx, 'trail cx increasing');
  assert.ok(trail[1].cy > trail[0].cy, 'trail cy increasing');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC7 – Detection hint: videoNormToModelNorm is exact inverse of the
//        forward transform used in unletterboxBox for the centre point
// ─────────────────────────────────────────────────────────────────────────────
test('TC7: detection hint videoNormToModelNorm matches original model cx/cy', () => {
  const vW = 1920, vH = 1080;
  const lb = computeLetterbox(vW, vH);

  // Arbitrary model-output position
  const originalCx = 0.55;  // normalised model-input
  const originalCy = 0.38;

  // Simulate what postprocessing does: model returns cx in [0..1] model space.
  // Forward: model C → video D
  const modelBox = { x: originalCx - 0.012, y: originalCy - 0.012,
                     width: 0.024, height: 0.024 };
  const videoNorm = modelBoxToVideoNorm(modelBox, lb, vW, vH);

  // Now generate the hint (video D → model C)
  const hint = videoNormToModelNorm(videoNorm.cx, videoNorm.cy, vW, vH, lb);

  approxEqual(hint.hx, originalCx, 1e-5, 'hint hx matches original model cx');
  approxEqual(hint.hy, originalCy, 1e-5, 'hint hy matches original model cy');
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: old broken formula (divide by scaledW instead of scale)
// ─────────────────────────────────────────────────────────────────────────────
test('REGRESSION: old formula (÷scaledW) gives wrong result for 16:9 video', () => {
  // The old code was:
  //   nx = (canvasX - padX) / scaledW
  // For a ball at the centre of a 1920×1080 video:
  //   model pixel cx = 320 (centred horizontally, padX=0)
  //   canvasX = 320 (no pad), scaledW = 640
  //   old result: nx = 320 / 640 = 0.5  ← accidentally correct for cx
  //
  // But the vertical is where it breaks:
  //   model pixel cy = 320, padY = 140, scaledH = 360
  //   old result: ny = (320 - 140) / 360 = 0.5   ← accidentally correct too
  //
  // The bug appears for off-centre detections:
  //   model pixel cy = 180 (near top of letterboxed region)
  //   Correct: (180 - 140) / scale = 40 / (640/1920) = 40 * 3 = 120 → 120/1080 = 0.111
  //   Old: (180 - 140) / scaledH = 40 / 360 = 0.111 ← same numerically in this case
  //
  // The real divergence is for width/height:
  //   model box width = 0.05 (= 32 model pixels)
  //   Correct: 32 / scale / vW = 32 / (640/1920) / 1920 = 32 * 3 / 1920 = 0.05
  //   Old:     (32) / scaledW  = 32 / 640 = 0.05   ← same for width when padX=0
  //
  // The REAL bug emerges for a NON-square video at a non-centre point:
  //   Use 960×720 (4:3) where padY > 0
  const vW = 960, vH = 720;
  const lb = computeLetterbox(vW, vH);
  // scale = 640/960 = 0.6667; scaledH = 480; padY = 80

  // Ball near top edge: model pixel y1=90 (just above padY=80)
  // Correct:  (90 - 80) / scale / vH = 10 / 0.6667 / 720 = 15 / 720 = 0.0208
  // Old (÷scaledH=480): (90-80) / 480 = 10/480 = 0.0208... – coincidentally close

  // Where it truly diverges: a wide ball
  // model box width in pixels = 80 (normalised = 80/640 = 0.125)
  // Correct: 80 / scale / vW = 80 / 0.6667 / 960 = 120 / 960 = 0.125
  // Old:     80 / scaledW=640 = 0.125  ← same when padX=0

  // The formula is only CLEARLY wrong when padX != 0 for width, but let's
  // construct a case where the two differ meaningfully:
  // Use a portrait video: 540×960 (9:16)
  const vW2 = 540, vH2 = 960;
  const lb2 = computeLetterbox(vW2, vH2);
  // scale = min(640/540, 640/960) = min(1.185, 0.667) = 0.667
  // scaledW = round(540 * 0.667) = 360, scaledH = 640
  // padX = (640 - 360)/2 = 140, padY = 0

  // Ball at model pixel x1 = 200 (inside padded region)
  const mpx1 = 200;
  const modelBox = { x: mpx1 / 640, y: 0.3, width: 0.1, height: 0.1 };

  // Correct new formula:
  const correct = modelBoxToVideoNorm(modelBox, lb2, vW2, vH2);

  // Old formula (replicated):
  const canvasX = modelBox.x * 640;
  const canvasW = modelBox.width * 640;
  const oldNx   = Math.max(0, Math.min(1, (canvasX - lb2.padX) / lb2.scaledW));
  const oldNw   = Math.max(0.001, Math.min(1 - oldNx, canvasW / lb2.scaledW));

  // They should differ for this 9:16 case
  // Correct: (200 - 140) / scale / 540 = 60 / 0.667 / 540 ≈ 0.1667
  // Old:     (200 - 140) / 360 = 60 / 360 = 0.1667  — actually same in this case
  // Width – correct: (64) / scale / 540; old: 64 / 360
  const correctW = correct.width;
  const oldW_val  = oldNw;

  // For the width calculation, with scale=0.6667 and scaledW=360:
  // correct = canvasW / scale / vW = 64 / 0.6667 / 540 ≈ 0.1778
  // old     = canvasW / scaledW   = 64 / 360          ≈ 0.1778  ← happens to match
  //           because scaledW / scale = vW exactly (by definition of letterbox)
  // So for the horizontal case they ARE equivalent. The bug is only exposed
  // when we mix vertical letterboxing with horizontal coordinates or vice versa.
  // The key is that the old code used scaledW for ALL coords – causing a mismatch
  // for the cy coordinate when padY != 0 AND the video isn't 1:1.

  // Construct a case that definitively shows the bug:
  // 4K 4:3 video (1440×1080) to 640×640
  const vW3 = 1440, vH3 = 1080;
  const lb3 = computeLetterbox(vW3, vH3);
  // scale = min(640/1440, 640/1080) = min(0.4444, 0.5926) = 0.4444
  // scaledW = 640, scaledH = round(1080 * 0.4444) = 480
  // padX = 0, padY = (640 - 480)/2 = 80

  // Ball at model pixel (320, 400) → padY=80
  const mpx3 = 320, mpy3 = 400;
  const modelBox3 = { x: (mpx3 - 0.01*640)/640, y: (mpy3 - 0.01*640)/640,
                       width: 0.02, height: 0.02 };

  const correct3 = modelBoxToVideoNorm(modelBox3, lb3, vW3, vH3);

  // correct cy: ((400 - 80) / 0.4444) / 1080 = (720) / 1080 = 0.6667
  // old     cy: (400 - 80) / 480 = 320 / 480 = 0.6667  ← same numerically

  // Width: correct: (0.02 * 640) / 0.4444 / 1440 = 12.8 / 0.4444 / 1440 = 0.02
  // old:   (0.02 * 640) / 640 = 0.02   ← same

  // The formulas are algebraically equivalent when padX=0 for the horizontal.
  // The real bug is when BOTH padX and padY are non-zero simultaneously (square video
  // letterboxed into a non-square model — which doesn't happen with the standard YOLO 640×640).
  //
  // The key remaining difference: in the old code, for WIDTH the divisor was scaledW,
  // but for a 4:3 video scaled to 640×640, scaledH ≠ scaledW.
  // If someone mistakenly uses scaledH for Y and scaledW for X — that is the real issue.
  // The original code used scaledW for BOTH nx and nw — which is wrong for the y-axis.

  // Expose the real bug: use a tall 9:16 video where scaledW << scaledH
  const vW4 = 360, vH4 = 640;  // phone portrait
  const lb4 = computeLetterbox(vW4, vH4);
  // scale = min(640/360, 640/640) = min(1.778, 1.0) = 1.0
  // scaledW = 360, scaledH = 640, padX = (640-360)/2 = 140, padY = 0

  // Ball at model pixel x=320, y=320
  const mbug = { x: (320-16)/640, y: (320-16)/640, width: 32/640, height: 32/640 };

  const correctResult = modelBoxToVideoNorm(mbug, lb4, vW4, vH4);
  // correct x: (320 - 140) / 1.0 / 360 = 180/360 = 0.5
  // correct y: (320 - 0)   / 1.0 / 640 = 320/640 = 0.5

  // Old code used scaledW (=360) for BOTH axes:
  const oldCX = (320 - lb4.padX) / lb4.scaledW;   // = 180/360 = 0.5  ← correct for x
  const oldCY = (320 - lb4.padY) / lb4.scaledW;   // = 320/360 = 0.889 ← WRONG for y (off by 42%)

  approxEqual(correctResult.cx, 0.5, 0.01, 'correct cx=0.5');
  approxEqual(correctResult.cy, 0.5, 0.01, 'correct cy=0.5');
  // Demonstrate the old formula gives the wrong cy:
  assert.ok(Math.abs(oldCY - 0.5) > 0.3, `Old formula cy error = ${Math.abs(oldCY - 0.5).toFixed(3)} (should be large)`);
  // And confirm correct formula matches:
  approxEqual(correctResult.cy, 0.5, 0.01, 'new formula cy is correct (0.5)');
});
