import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoCaptureManager } from '../utils/video-capture.js';

test('VideoCaptureManager.isLiveStream correctly identifies live video conditions', () => {
  // 1. Infinity duration (standard live HLS/DASH/Canvas stream)
  const liveInfinity = { duration: Infinity, readyState: 4 };
  assert.equal(VideoCaptureManager.isLiveStream(liveInfinity), true);

  // 2. NaN duration (live broadcast before header metadata)
  const liveNaN = { duration: NaN, readyState: 2 };
  assert.equal(VideoCaptureManager.isLiveStream(liveNaN), true);

  // 3. Normal pre-recorded video (e.g. 90-minute match)
  const recorded = { duration: 5400, readyState: 4 };
  assert.equal(VideoCaptureManager.isLiveStream(recorded), false);

  // 4. Null video
  assert.equal(VideoCaptureManager.isLiveStream(null), false);
});

test('VideoCaptureManager.findVideoElement ranks active playing video above paused or hidden videos', () => {
  const pausedSmallVideo = {
    paused: true,
    readyState: 2,
    videoWidth: 320,
    videoHeight: 240,
    clientWidth: 320,
    clientHeight: 240,
    getBoundingClientRect: () => ({ width: 320, height: 240 })
  };

  const activePlayingVideo = {
    paused: false,
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    clientWidth: 1280,
    clientHeight: 720,
    getBoundingClientRect: () => ({ width: 1280, height: 720 })
  };

  const mockRoot = {
    querySelectorAll: (sel) => {
      if (sel === 'video') return [pausedSmallVideo, activePlayingVideo];
      return [];
    }
  };

  const chosen = VideoCaptureManager.findVideoElement(mockRoot);
  assert.equal(chosen, activePlayingVideo);
});

test('VideoCaptureManager handles live session timestamps gracefully', () => {
  const manager = new VideoCaptureManager({ targetFps: 8 });

  const mockLiveVideo = {
    readyState: 4,
    duration: Infinity,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 0,
    paused: false,
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  manager.attach(mockLiveVideo);
  assert.equal(manager.isLive, true);
  assert.ok(manager.liveSessionStart > 0);

  manager.stop();
});
