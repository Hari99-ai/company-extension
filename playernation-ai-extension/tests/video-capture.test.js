import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoCaptureManager } from '../utils/video-capture.js';

test('VideoCaptureManager computes correct letterbox scale and padding', () => {
  // Test 16:9 input 1920x1080 into 640x640 model frame
  const srcW = 1920;
  const srcH = 1080;
  const dstW = 640;
  const dstH = 640;

  const scale = Math.min(dstW / srcW, dstH / srcH);
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);
  const padX = Math.round((dstW - scaledW) / 2);
  const padY = Math.round((dstH - scaledH) / 2);

  assert.equal(scaledW, 640);
  assert.equal(scaledH, 360);
  assert.equal(padX, 0);
  assert.equal(padY, 140);
  assert.equal(padY * 2 + scaledH, 640);
});

test('VideoCaptureManager enforces target FPS boundaries', () => {
  const managerLow = new VideoCaptureManager({ targetFps: 0 });
  assert.equal(managerLow.targetFps, 1);

  const managerHigh = new VideoCaptureManager({ targetFps: 60 });
  assert.equal(managerHigh.targetFps, 30);

  const managerNormal = new VideoCaptureManager({ targetFps: 8 });
  assert.equal(managerNormal.targetFps, 8);
  assert.equal(managerNormal.frameIntervalMs, 125);
});

test('VideoCaptureManager handles state machine transitions properly', () => {
  const statusEvents = [];
  const manager = new VideoCaptureManager({
    targetFps: 8,
    onStatusChange: (status) => statusEvents.push(status.state)
  });

  // Mock minimal video element
  const mockVideo = {
    readyState: 4,
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 10.5,
    paused: false,
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const attached = manager.attach(mockVideo);
  assert.equal(attached, true);
  assert.equal(statusEvents.includes('attached'), true);

  manager.start();
  assert.equal(manager.isRunning, true);
  assert.equal(manager.isPaused, false);
  assert.equal(statusEvents.includes('capturing'), true);

  manager.pause();
  assert.equal(manager.isPaused, true);
  assert.equal(statusEvents.includes('paused'), true);

  manager.resume();
  assert.equal(manager.isPaused, false);

  manager.stop();
  assert.equal(manager.isRunning, false);
  assert.equal(statusEvents.includes('stopped'), true);
});
