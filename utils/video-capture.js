/**
 * Video Capture Manager for PlayerNation AI Logger
 * Handles HTMLVideoElement detection, precise frame extraction, throttled sampling,
 * letterboxed preprocessing canvas, seek/buffer tracking, and resource lifecycle.
 */

import { isSeekDetected } from './timestamps.js';

export class VideoCaptureManager {
  /**
   * @param {object} options
   * @param {number} [options.targetFps=8] - Target frame extraction rate (5-10 fps recommended)
   * @param {number} [options.targetWidth=640] - Model input width
   * @param {number} [options.targetHeight=640] - Model input height
   * @param {function} [options.onFrame] - Callback when a frame is ready
   * @param {function} [options.onStatusChange] - Callback for status updates
   * @param {function} [options.onError] - Callback on error
   */
  constructor(options = {}) {
    const rawFps = options.targetFps !== undefined ? options.targetFps : 8;
    this.targetFps = Math.max(1, Math.min(30, rawFps));
    this.targetWidth = options.targetWidth || 640;
    this.targetHeight = options.targetHeight || 640;

    this.onFrame = options.onFrame || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onError = options.onError || (() => {});

    this.videoElement = null;
    this.canvas = null;
    this.ctx = null;

    this.isRunning = false;
    this.isPaused = false;
    this.frameIntervalMs = 1000 / this.targetFps;

    this.loopTimerId = null;
    this.rvfcCallbackId = null;

    this.frameIndex = 0;
    this.lastProcessedVideoTime = null;
    this.lastRealFrameTimestamp = null;
    this.extractedFramesCount = 0;
    this.droppedFramesCount = 0;

    // Live stream & CORS tracking
    this.isLive = false;
    this.liveSessionStart = 0;
    this._corsWarned = false;

    // Bound listeners for cleanup
    this._boundOnPlay = this._handlePlay.bind(this);
    this._boundOnPause = this._handlePause.bind(this);
    this._boundOnSeeking = this._handleSeeking.bind(this);
    this._boundOnSeeked = this._handleSeeked.bind(this);
    this._boundOnEnded = this._handleEnded.bind(this);
    this._boundOnWaiting = this._handleWaiting.bind(this);
  }

  /**
   * Search all elements and open shadow roots recursively for <video> tags.
   * @param {Document|HTMLElement} [root=document]
   * @returns {Array<HTMLVideoElement>}
   */
  static findAllVideoElements(root = document) {
    const results = [];
    if (!root) return results;

    const traverse = (node) => {
      if (!node) return;
      if (node.querySelectorAll) {
        node.querySelectorAll('video').forEach(v => {
          if (!results.includes(v)) results.push(v);
        });
        node.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) traverse(el.shadowRoot);
        });
      }
    };

    try {
      traverse(root);
    } catch (e) {
      const basic = Array.from(root.querySelectorAll ? root.querySelectorAll('video') : []);
      return basic;
    }

    return results;
  }

  /**
   * Check whether a video element is currently playing a live broadcast stream.
   * @param {HTMLVideoElement} video
   * @returns {boolean}
   */
  static isLiveStream(video) {
    if (!video) return false;
    const dur = video.duration;
    // Live streams report Infinity, NaN, or 0 (with active stream)
    if (dur === Infinity || isNaN(dur)) return true;
    if (dur === 0 && video.readyState >= 2) return true;
    if (video.srcObject && (typeof MediaStream !== 'undefined' && video.srcObject instanceof MediaStream)) return true;
    if (video.seekable && video.seekable.length > 0) {
      const range = video.seekable.end(video.seekable.length - 1) - video.seekable.start(0);
      if (range > 86400) return true; // Seekable range exceeding 24 hours typical of live HLS
    }
    return false;
  }

  /**
   * Detect and return the best candidate video element on the page.
   * Priority: active playing video, primary player selectors (YouTube, Twitch, etc.), largest rendered area.
   * @param {Document|HTMLElement} [root=document]
   * @returns {HTMLVideoElement|null}
   */
  static findVideoElement(root = document) {
    const videos = VideoCaptureManager.findAllVideoElements(root);
    if (videos.length === 0) return null;

    // Check prominent video platform selectors
    const platformSelectors = [
      'video.html5-main-video',
      'video.video-stream',
      'video[data-a-target="player-video"]',
      'video#matchVideo',
      '.vjs-tech'
    ];
    for (const sel of platformSelectors) {
      try {
        const found = root.querySelector ? root.querySelector(sel) : null;
        if (found && videos.includes(found)) return found;
      } catch (e) {}
    }

    // Rank candidate videos
    const scored = videos.map(v => {
      let score = 0;
      let width = v.clientWidth || v.videoWidth || 0;
      let height = v.clientHeight || v.videoHeight || 0;

      if (v.getBoundingClientRect) {
        const rect = v.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          width = rect.width;
          height = rect.height;
        }
      }

      const area = width * height;

      // Currently playing video gets highest priority
      if (!v.paused && v.readyState >= 2) score += 10000;
      if (v.src || v.srcObject || v.currentSrc) score += 2000;
      if (area > 80000) score += 1000;
      score += Math.min(2000, Math.round(area / 1000));
      if (width > 240 && height > 160) score += 500;

      return { video: v, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.video || videos[0];
  }

  /**
   * Initialize capture canvas and attach to video element.
   * @param {HTMLVideoElement} [video]
   * @returns {boolean} Success status
   */
  attach(video) {
    const targetVideo = video || VideoCaptureManager.findVideoElement();
    if (!targetVideo) {
      const err = new Error('No usable football match <video> element found on current page.');
      this.onError(err);
      return false;
    }

    this.videoElement = targetVideo;
    this.isLive = VideoCaptureManager.isLiveStream(this.videoElement);
    this.liveSessionStart = performance.now();
    this._corsWarned = false;

    // Initialize in-memory canvas for resizing & letterboxing
    if (!this.canvas) {
      if (typeof OffscreenCanvas !== 'undefined') {
        this.canvas = new OffscreenCanvas(this.targetWidth, this.targetHeight);
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      } else if (typeof document !== 'undefined') {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.targetWidth;
        this.canvas.height = this.targetHeight;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      } else {
        // Mock canvas for Node test runner
        this.canvas = { width: this.targetWidth, height: this.targetHeight };
        this.ctx = {
          fillStyle: '',
          fillRect: () => {},
          drawImage: () => {},
          getImageData: () => ({ data: new Uint8ClampedArray(this.targetWidth * this.targetHeight * 4), width: this.targetWidth, height: this.targetHeight })
        };
      }
    }

    // Attach lifecycle listeners
    this.videoElement.addEventListener('play', this._boundOnPlay);
    this.videoElement.addEventListener('pause', this._boundOnPause);
    this.videoElement.addEventListener('seeking', this._boundOnSeeking);
    this.videoElement.addEventListener('seeked', this._boundOnSeeked);
    this.videoElement.addEventListener('ended', this._boundOnEnded);
    this.videoElement.addEventListener('waiting', this._boundOnWaiting);

    this.onStatusChange({
      state: 'attached',
      isLive: this.isLive,
      videoReadyState: this.videoElement.readyState,
      videoWidth: this.videoElement.videoWidth,
      videoHeight: this.videoElement.videoHeight,
      currentTime: this.videoElement.currentTime
    });

    return true;
  }

  /**
   * Start video frame extraction loop.
   */
  start() {
    if (this.isRunning) return;

    if (!this.videoElement && !this.attach()) {
      return;
    }

    this.isRunning = true;
    this.isPaused = false;
    this.lastRealFrameTimestamp = performance.now();
    this.lastProcessedVideoTime = this.videoElement.currentTime;

    this.onStatusChange({
      state: 'capturing',
      fps: this.targetFps,
      currentTime: this.videoElement.currentTime
    });

    this._scheduleNextFrame();
  }

  /**
   * Pause frame extraction without detaching listeners.
   */
  pause() {
    this.isPaused = true;
    this._cancelScheduledFrame();
    this.onStatusChange({
      state: 'paused',
      currentTime: this.videoElement ? this.videoElement.currentTime : 0
    });
  }

  /**
   * Resume frame extraction.
   */
  resume() {
    if (!this.isRunning) {
      this.start();
      return;
    }
    this.isPaused = false;
    this.lastRealFrameTimestamp = performance.now();
    this.onStatusChange({
      state: 'capturing',
      fps: this.targetFps,
      currentTime: this.videoElement ? this.videoElement.currentTime : 0
    });
    this._scheduleNextFrame();
  }

  /**
   * Stop frame extraction and release resources.
   */
  stop() {
    this.isRunning = false;
    this.isPaused = false;
    this._cancelScheduledFrame();

    if (this.videoElement) {
      this.videoElement.removeEventListener('play', this._boundOnPlay);
      this.videoElement.removeEventListener('pause', this._boundOnPause);
      this.videoElement.removeEventListener('seeking', this._boundOnSeeking);
      this.videoElement.removeEventListener('seeked', this._boundOnSeeked);
      this.videoElement.removeEventListener('ended', this._boundOnEnded);
      this.videoElement.removeEventListener('waiting', this._boundOnWaiting);
      this.videoElement = null;
    }

    this.onStatusChange({
      state: 'stopped',
      extractedFrames: this.extractedFramesCount,
      droppedFrames: this.droppedFramesCount
    });
  }

  _scheduleNextFrame() {
    if (!this.isRunning || this.isPaused) return;

    // Use requestVideoFrameCallback if supported by the browser on HTMLVideoElement
    if (this.videoElement && typeof this.videoElement.requestVideoFrameCallback === 'function') {
      this.rvfcCallbackId = this.videoElement.requestVideoFrameCallback((now, metadata) => {
        this._onVideoFrameAvailable(now, metadata);
      });
    } else {
      // High-precision timeout loop throttled to targetFps
      this.loopTimerId = setTimeout(() => {
        this._extractCurrentFrame(performance.now());
      }, this.frameIntervalMs);
    }
  }

  _cancelScheduledFrame() {
    if (this.loopTimerId) {
      clearTimeout(this.loopTimerId);
      this.loopTimerId = null;
    }
    if (this.videoElement && this.rvfcCallbackId != null && typeof this.videoElement.cancelVideoFrameCallback === 'function') {
      this.videoElement.cancelVideoFrameCallback(this.rvfcCallbackId);
      this.rvfcCallbackId = null;
    }
  }

  _onVideoFrameAvailable(now, metadata) {
    if (!this.isRunning || this.isPaused) return;

    const timeSinceLast = now - (this.lastRealFrameTimestamp || 0);
    // Throttle to target FPS
    if (timeSinceLast < this.frameIntervalMs * 0.85) {
      this._scheduleNextFrame();
      return;
    }

    this._extractCurrentFrame(now, metadata.mediaTime);
    this._scheduleNextFrame();
  }

  /**
   * Perform actual canvas draw and frame package generation.
   * @param {number} wallClockNow
   * @param {number} [mediaTimeSec]
   */
  _extractCurrentFrame(wallClockNow, mediaTimeSec) {
    if (!this.isRunning || this.isPaused || !this.videoElement) return;

    const video = this.videoElement;

    // Verify video is in a ready state with non-zero dimensions
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      this.droppedFramesCount++;
      if (!video.requestVideoFrameCallback) this._scheduleNextFrame();
      return;
    }

    const currentVideoTime = mediaTimeSec != null ? mediaTimeSec : video.currentTime;
    const realElapsedMs = this.lastRealFrameTimestamp ? (wallClockNow - this.lastRealFrameTimestamp) : this.frameIntervalMs;
    const liveElapsedSec = (wallClockNow - (this.liveSessionStart || wallClockNow)) / 1000;
    const effectiveTimestamp = this.isLive
      ? (currentVideoTime > 0 && currentVideoTime < 86400 ? currentVideoTime : liveElapsedSec)
      : currentVideoTime;

    // Check for user seeking
    const isSeek = isSeekDetected(
      this.lastProcessedVideoTime,
      effectiveTimestamp,
      realElapsedMs,
      video.playbackRate || 1.0
    );

    // If video is paused or buffering, and time hasn't changed, avoid redundant processing
    if (video.paused && !isSeek && this.lastProcessedVideoTime === effectiveTimestamp) {
      if (!video.requestVideoFrameCallback) this._scheduleNextFrame();
      return;
    }

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const dstW = this.targetWidth;
    const dstH = this.targetHeight;

    // Letterbox calculation preserving aspect ratio
    const scale = Math.min(dstW / srcW, dstH / srcH);
    const scaledW = Math.round(srcW * scale);
    const scaledH = Math.round(srcH * scale);
    const padX = Math.round((dstW - scaledW) / 2);
    const padY = Math.round((dstH - scaledH) / 2);

    try {
      // Clear letterbox background to black (standard YOLO preprocessing)
      this.ctx.fillStyle = '#000000';
      this.ctx.fillRect(0, 0, dstW, dstH);

      // Draw video frame centered
      this.ctx.drawImage(video, 0, 0, srcW, srcH, padX, padY, scaledW, scaledH);

      // Extract pixel data
      const imageData = this.ctx.getImageData(0, 0, dstW, dstH);

      this.frameIndex++;
      this.extractedFramesCount++;
      this.lastProcessedVideoTime = effectiveTimestamp;
      this.lastRealFrameTimestamp = wallClockNow;

      const framePackage = {
        frameIndex: this.frameIndex,
        isLive: this.isLive,
        liveElapsedSec,
        videoTimestamp: effectiveTimestamp, // Exact match or live session time in seconds
        videoWidth: srcW,
        videoHeight: srcH,
        processedWidth: dstW,
        processedHeight: dstH,
        letterbox: {
          scale,
          padX,
          padY,
          scaledW,
          scaledH
        },
        imageData,
        isSeek,
        playbackRate: video.playbackRate || 1.0,
        isPaused: video.paused
      };

      this.onFrame(framePackage);
    } catch (err) {
      // Handle cross-origin security restriction gracefully
      if (err.name === 'SecurityError') {
        if (!this._corsWarned) {
          this._corsWarned = true;
          const corsErr = new Error('Live stream video element is cross-origin protected (CORS). HUD active; enable Chrome Tab Capture for full pixel inference.');
          corsErr.code = 'CORS_TAINTED';
          this.onError(corsErr);
          this.onStatusChange({
            state: 'cors_protected',
            isLive: this.isLive,
            currentTime: effectiveTimestamp
          });
        }

        this.frameIndex++;
        this.lastProcessedVideoTime = effectiveTimestamp;
        this.lastRealFrameTimestamp = wallClockNow;

        // Provide dummy buffer to allow tracking & HUD overlay to continue without hard crashing
        const dummyData = this.ctx.createImageData ? this.ctx.createImageData(dstW, dstH) : { data: new Uint8ClampedArray(dstW * dstH * 4), width: dstW, height: dstH };
        this.onFrame({
          frameIndex: this.frameIndex,
          isLive: this.isLive,
          isCorsTainted: true,
          liveElapsedSec,
          videoTimestamp: effectiveTimestamp,
          videoWidth: srcW,
          videoHeight: srcH,
          processedWidth: dstW,
          processedHeight: dstH,
          letterbox: { scale, padX, padY, scaledW, scaledH },
          imageData: dummyData,
          isSeek,
          playbackRate: video.playbackRate || 1.0,
          isPaused: video.paused
        });
      } else {
        this.onError(err);
      }
    }

    if (!video.requestVideoFrameCallback) {
      this._scheduleNextFrame();
    }
  }

  _handlePlay() {
    this.onStatusChange({ state: 'playing', currentTime: this.videoElement ? this.videoElement.currentTime : 0 });
    if (this.isRunning && this.isPaused) {
      this.resume();
    }
  }

  _handlePause() {
    this.onStatusChange({ state: 'video_paused', currentTime: this.videoElement ? this.videoElement.currentTime : 0 });
  }

  _handleSeeking() {
    this.onStatusChange({ state: 'seeking', currentTime: this.videoElement ? this.videoElement.currentTime : 0 });
  }

  _handleSeeked() {
    this.onStatusChange({ state: 'seeked', currentTime: this.videoElement ? this.videoElement.currentTime : 0 });
    // Immediately sample frame on seek completion
    if (this.isRunning && !this.isPaused) {
      this._extractCurrentFrame(performance.now());
    }
  }

  _handleEnded() {
    this.onStatusChange({ state: 'ended', currentTime: this.videoElement ? this.videoElement.currentTime : 0 });
  }

  _handleWaiting() {
    this.onStatusChange({ state: 'buffering', currentTime: this.videoElement ? this.videoElement.currentTime : 0 });
  }
}
