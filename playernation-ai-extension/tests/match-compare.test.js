import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoCaptureManager } from '../utils/video-capture.js';
import { PlayerNationAdapter } from '../integration/playernation-adapter.js';

test('VideoCaptureManager.getCandidateVideos ranks compare videos and respects active attributes', () => {
  const videoA = {
    id: 'matchVideoA',
    paused: false,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 640,
    clientHeight: 360,
    hasAttribute: (attr) => attr === 'data-active-player',
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ width: 640, height: 360 })
  };

  const videoB = {
    id: 'matchVideoB',
    paused: false,
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 640,
    clientHeight: 360,
    hasAttribute: () => false,
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ width: 640, height: 360 })
  };

  const mockRoot = {
    querySelectorAll: (sel) => {
      if (sel === 'video') return [videoB, videoA];
      return [];
    }
  };

  const candidates = VideoCaptureManager.getCandidateVideos(mockRoot);
  assert.equal(candidates.length, 2);
  // videoA has data-active-player so it should be ranked first
  assert.equal(candidates[0], videoA);
  assert.equal(candidates[1], videoB);

  // Calling with index 1 returns the second video in candidate list
  const chosenIndex1 = VideoCaptureManager.findVideoElement(mockRoot, 1);
  assert.equal(chosenIndex1, videoB);
});

test('PlayerNationAdapter findButton locates buttons via ID, data attributes, and class names', () => {
  const adapter = new PlayerNationAdapter({ autoLoggingEnabled: true });

  // 1. Direct ID match
  const btnShot = { id: 'shotBtn', disabled: false, focus: () => {}, dispatchEvent: () => {} };
  globalThis.document = {
    getElementById: (id) => (id === 'shotBtn' ? btnShot : null),
    querySelector: () => null,
    querySelectorAll: () => [btnShot]
  };

  assert.equal(adapter.findButton('shot'), btnShot);

  // 2. Data attribute fallback (e.g. data-action="goal")
  const btnGoal = { id: 'custom-goal-id', disabled: false, focus: () => {}, dispatchEvent: () => {} };
  globalThis.document = {
    getElementById: () => null,
    querySelector: (sel) => (sel.includes('goal') ? btnGoal : null),
    querySelectorAll: () => [btnGoal]
  };

  assert.equal(adapter.findButton('goal'), btnGoal);

  // 3. submitEvent executes click via fallback
  let clicked = false;
  btnGoal.dispatchEvent = (evt) => {
    if (evt.type === 'click') clicked = true;
  };

  const submitRes = adapter.submitEvent({
    eventType: 'goal',
    matchTimestamp: 125.4,
    team: 'Team A',
    confidence: 0.95
  }, true);

  assert.equal(submitRes.success, true);
  assert.equal(clicked, true);
});
