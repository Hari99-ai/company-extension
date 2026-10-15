/**
 * FootballMemoryManager
 * =====================
 * Two-minute (120-second) rolling temporal memory for football tracking.
 *
 * Provides:
 *  - Multi-timescale memory (short / medium / long-term)
 *  - Kalman-filter position prediction
 *  - Explicit tracking state machine
 *  - Camera-motion compensation (background optical-flow estimate)
 *  - Adaptive search-region controller
 *  - Diagnostic export
 *
 * All coordinates are normalised [0..1] relative to the video frame.
 * All timestamps are video currentTime values in seconds — NOT wall clock.
 *
 * This module is purely in-memory and intentionally never writes to
 * chrome.storage during active tracking.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum rolling history window (seconds). */
const DEFAULT_MEMORY_WINDOW_SEC = 120;

/** Short-term horizon used for immediate prediction (seconds). */
const SHORT_TERM_SEC = 2;

/** Medium-term horizon used for occlusion recovery (seconds). */
const MEDIUM_TERM_SEC = 15;

/** Minimum confidence to count a detection as "confirmed". */
const CONFIRMED_CONFIDENCE_THRESHOLD = 0.45;

/** After this many missed frames the state degrades to UNCERTAIN. */
const MAX_PREDICTED_FRAMES = 8;

/** After this many missed frames the state degrades to LOST. */
const MAX_UNCERTAIN_FRAMES = 20;

/** Kalman process-noise variance (position). */
const KF_Q_POS = 0.0001;

/** Kalman measurement-noise variance. */
const KF_R = 0.0004;

/** Minimum prediction uncertainty below which search region is tightened. */
const MIN_SEARCH_RADIUS = 0.06;

/** Maximum search radius before a full-frame search is triggered. */
const MAX_SEARCH_RADIUS = 0.45;

// ─── Tracking States ─────────────────────────────────────────────────────────

export const TrackingState = Object.freeze({
  DETECTED:    'DETECTED',     // YOLO confirmed this frame
  TRACKED:     'TRACKED',      // Consistent recent detections
  PREDICTED:   'PREDICTED',    // Extrapolating; no current detection
  UNCERTAIN:   'UNCERTAIN',    // Evidence insufficient
  LOST:        'LOST',         // Cannot locate ball
  REACQUIRING: 'REACQUIRING'  // Searching after loss
});

// ─── Minimal Kalman Filter (2-D position + velocity) ─────────────────────────

/**
 * 4-state Kalman filter: [x, y, vx, vy].
 * Uses constant-velocity motion model with diagonal covariance matrices
 * for browser-safe performance.
 */
class KalmanFilter2D {
  constructor() {
    // State vector: [x, y, vx, vy]
    this.x  = 0.5;
    this.y  = 0.5;
    this.vx = 0;
    this.vy = 0;

    // Diagonal covariance (uncertainty)
    this.Px  = 1.0;  // x variance
    this.Py  = 1.0;  // y variance
    this.Pvx = 0.1;  // vx variance
    this.Pvy = 0.1;  // vy variance
  }

  /**
   * Predict state forward by dt seconds.
   * @param {number} dt - Elapsed video time since last update (seconds)
   */
  predict(dt) {
    // State prediction: x += vx*dt
    this.x  += this.vx * dt;
    this.y  += this.vy * dt;

    // Clamp to frame boundaries
    this.x = Math.max(0.01, Math.min(0.99, this.x));
    this.y = Math.max(0.01, Math.min(0.99, this.y));

    // Covariance prediction: P += Q
    this.Px  += KF_Q_POS + Math.abs(this.vx) * 0.001;
    this.Py  += KF_Q_POS + Math.abs(this.vy) * 0.001;
    this.Pvx += KF_Q_POS * 0.5;
    this.Pvy += KF_Q_POS * 0.5;
  }

  /**
   * Update state with an observation.
   * @param {number} mx - Measured x (normalised)
   * @param {number} my - Measured y (normalised)
   * @param {number} confidence - Detection confidence [0..1]
   */
  update(mx, my, confidence = 1.0) {
    // Scale measurement noise inversely with confidence
    const R = KF_R / Math.max(0.1, confidence);

    // Kalman gain (per axis, diagonal)
    const Kx  = this.Px  / (this.Px  + R);
    const Ky  = this.Py  / (this.Py  + R);
    const Kvx = this.Pvx / (this.Pvx + R * 4);
    const Kvy = this.Pvy / (this.Pvy + R * 4);

    // Innovation
    const innX = mx - this.x;
    const innY = my - this.y;

    // State update
    this.x  += Kx  * innX;
    this.y  += Ky  * innY;
    this.vx += Kvx * innX;
    this.vy += Kvy * innY;

    // Velocity damping — prevents runaway on single-frame spikes
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > 0.1) {
      this.vx = (this.vx / speed) * 0.1;
      this.vy = (this.vy / speed) * 0.1;
    }

    // Covariance update
    this.Px  = (1 - Kx)  * this.Px;
    this.Py  = (1 - Ky)  * this.Py;
    this.Pvx = (1 - Kvx) * this.Pvx;
    this.Pvy = (1 - Kvy) * this.Pvy;
  }

  /** Initialise filter from a known position. */
  init(x, y, vx = 0, vy = 0) {
    this.x  = x;
    this.y  = y;
    this.vx = vx;
    this.vy = vy;
    this.Px  = 0.01;
    this.Py  = 0.01;
    this.Pvx = 0.005;
    this.Pvy = 0.005;
  }

  /** Combined positional uncertainty (sqrt of trace approximation). */
  get uncertainty() {
    return Math.sqrt(this.Px + this.Py);
  }
}

// ─── Camera Motion Estimator ──────────────────────────────────────────────────

/**
 * Lightweight camera-motion estimator.
 * Compares background region brightness shifts across two ImageData snapshots
 * to produce a (dx, dy) global frame shift in normalised units.
 *
 * This is intentionally simple: not full optical flow, but sufficient to
 * compensate gross camera pans in football broadcasts.
 */
class CameraMotionEstimator {
  constructor() {
    this._prevSample = null;
    this.dx = 0;
    this.dy = 0;
    this.isReliable = false;
    this._canvas = null;
    this._ctx    = null;
  }

  /**
   * Estimate camera motion between last frame and current frame.
   * Uses a coarse 8×8 block-matching approach on a downsampled copy.
   *
   * @param {HTMLVideoElement} video
   * @param {object|null} ballRegion - { cx, cy, r } exclusion zone for ball
   * @returns {{ dx: number, dy: number, isReliable: boolean }}
   */
  estimate(video, ballRegion = null) {
    if (!video || video.readyState < 2 || typeof document === 'undefined') {
      this.isReliable = false;
      return { dx: 0, dy: 0, isReliable: false };
    }

    try {
      const W = 64, H = 36; // very small — just enough to detect gross pans
      if (!this._canvas) {
        this._canvas = document.createElement('canvas');
        this._canvas.width  = W;
        this._canvas.height = H;
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
      }

      this._ctx.drawImage(video, 0, 0, W, H);
      const curr = this._ctx.getImageData(0, 0, W, H).data;

      if (!this._prevSample || this._prevSample.length !== curr.length) {
        this._prevSample = new Uint8ClampedArray(curr);
        this.isReliable  = false;
        return { dx: 0, dy: 0, isReliable: false };
      }

      // Block matching: try offsets [-2, -1, 0, +1, +2] in each axis
      const prev = this._prevSample;
      let bestSAD = Infinity;
      let bestDx  = 0;
      let bestDy  = 0;

      for (let offY = -2; offY <= 2; offY++) {
        for (let offX = -2; offX <= 2; offX++) {
          let sad = 0;
          let count = 0;
          for (let y = 4; y < H - 4; y++) {
            for (let x = 4; x < W - 4; x++) {
              const srcIdx  = (y * W + x) * 4;
              const ny = y + offY;
              const nx = x + offX;
              if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
              const destIdx = (ny * W + nx) * 4;

              // Skip ball exclusion zone
              if (ballRegion) {
                const bx = ballRegion.cx * W;
                const by = ballRegion.cy * H;
                const br = ballRegion.r  * Math.min(W, H);
                if (Math.hypot(x - bx, y - by) < br + 4) continue;
              }

              // Skip grass (bright green) — focus on lines / stands
              const g = prev[srcIdx + 1];
              const r = prev[srcIdx];
              const b = prev[srcIdx + 2];
              if (g > r + 20 && g > b + 20) continue;

              sad += Math.abs(curr[srcIdx] - prev[destIdx])
                   + Math.abs(curr[srcIdx + 1] - prev[destIdx + 1])
                   + Math.abs(curr[srcIdx + 2] - prev[destIdx + 2]);
              count++;
            }
          }
          if (count > 50 && sad / count < bestSAD / Math.max(1, count)) {
            bestSAD = sad;
            bestDx  = offX;
            bestDy  = offY;
          }
        }
      }

      // Convert pixel shift to normalised [0..1] coordinates
      this.dx = bestDx / W;
      this.dy = bestDy / H;

      // Reliability heuristic: if SAD is very high the scene changed drastically
      this.isReliable = bestSAD < 200000;

      this._prevSample = new Uint8ClampedArray(curr);
      return { dx: this.dx, dy: this.dy, isReliable: this.isReliable };
    } catch (e) {
      this.isReliable = false;
      return { dx: 0, dy: 0, isReliable: false };
    }
  }

  reset() {
    this._prevSample = null;
    this.dx = 0;
    this.dy = 0;
    this.isReliable = false;
  }
}

// ─── FootballMemoryManager ────────────────────────────────────────────────────

export class FootballMemoryManager {
  /**
   * @param {object} [options]
   * @param {number} [options.memoryWindowSec=120] - Rolling history window (seconds)
   * @param {boolean} [options.enableCameraMotion=true] - Enable camera-motion compensation
   */
  constructor(options = {}) {
    this.memoryWindowSec    = options.memoryWindowSec    ?? DEFAULT_MEMORY_WINDOW_SEC;
    this.enableCameraMotion = options.enableCameraMotion ?? true;

    // ── Rolling detection history ───────────────────────────────────────────
    /** @type {Array<DetectionRecord>} Bounded rolling history. */
    this.detectionHistory = [];

    // ── Tracking state ──────────────────────────────────────────────────────
    this.trackingState = TrackingState.LOST;

    /** Last video timestamp with a CONFIRMED detection (confidence >= threshold). */
    this.lastConfirmedTimestamp = null;

    /** The most recent confirmed position { cx, cy, width, height, confidence }. */
    this.lastConfirmedPosition  = null;

    /** Consecutive frames without any detection (including predicted frames). */
    this.missedDetectionFrames  = 0;

    /** Consecutive frames in PREDICTED state. */
    this.predictedFrames = 0;

    /** Number of reacquisition attempts since last TRACKED state. */
    this.reacquisitionAttempts = 0;

    // ── Kalman filter ───────────────────────────────────────────────────────
    this.kalman = new KalmanFilter2D();
    this._kalmanInitialised = false;
    this._lastKalmanTimestamp = null;

    // ── Camera motion ───────────────────────────────────────────────────────
    this.cameraMotion = new CameraMotionEstimator();
    this.cameraStatus = 'UNKNOWN'; // 'STABLE' | 'MOVING' | 'UNKNOWN'

    // ── State-transition history (diagnostic) ──────────────────────────────
    /** @type {Array<{from: string, to: string, videoTimestamp: number}>} */
    this.stateTransitions = [];

    // ── Adaptive search region ─────────────────────────────────────────────
    this.searchRadius = MIN_SEARCH_RADIUS;
    this.searchMode   = 'LOCAL'; // 'LOCAL' | 'EXPANDED' | 'FULL_FRAME'

    // ── Frame processing counter ────────────────────────────────────────────
    this._frameCount = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Record a confirmed or candidate detection for the current frame.
   * Call this when YOLO or saliency produces a result.
   *
   * @param {object} detectedBall - { cx, cy, width, height, confidence, source? }
   * @param {number} videoTimestamp - video.currentTime in seconds
   * @param {object|null} [cameraMotionResult] - Optional pre-computed camera motion
   */
  recordDetection(detectedBall, videoTimestamp, cameraMotionResult = null) {
    if (!detectedBall) return;

    const cx  = detectedBall.cx  ?? (detectedBall.x + detectedBall.width  / 2);
    const cy  = detectedBall.cy  ?? (detectedBall.y + detectedBall.height / 2);
    const conf = detectedBall.confidence ?? 0;

    const record = {
      videoTimestamp,
      centerX:    cx,
      centerY:    cy,
      width:      detectedBall.width  || 0.016,
      height:     detectedBall.height || 0.016,
      confidence: conf,
      state:      this.trackingState,
      velocityX:  this.kalman.vx,
      velocityY:  this.kalman.vy,
      source:     detectedBall.isSaliency ? 'saliency'
                : (detectedBall.isManual   ? 'manual'   : 'yolo'),
      cameraMotionCompensated: !!(cameraMotionResult?.isReliable)
    };

    this.detectionHistory.push(record);
    this._pruneOldRecords(videoTimestamp);

    // Update Kalman filter
    const dt = (this._lastKalmanTimestamp != null)
      ? Math.max(0, videoTimestamp - this._lastKalmanTimestamp)
      : 0;

    if (this._kalmanInitialised && dt > 0 && dt < 5) {
      this.kalman.predict(dt);
    }
    this.kalman.update(cx, cy, conf);

    if (!this._kalmanInitialised) {
      this.kalman.init(cx, cy);
      this._kalmanInitialised = true;
    }

    this._lastKalmanTimestamp = videoTimestamp;

    // Track confirmed detections separately
    if (conf >= CONFIRMED_CONFIDENCE_THRESHOLD) {
      this.lastConfirmedTimestamp = videoTimestamp;
      this.lastConfirmedPosition  = { cx, cy, width: record.width, height: record.height, confidence: conf };
    }
  }

  /**
   * Called every frame — updates the tracking state machine.
   *
   * @param {object|null}        detectedBall     - Raw detection this frame (may be null)
   * @param {number}             videoTimestamp   - video.currentTime
   * @param {boolean}            isSeek           - True when user seeked
   * @param {HTMLVideoElement}   [videoElement]   - Used for camera motion estimation
   * @returns {MemoryQueryResult}
   */
  update(detectedBall, videoTimestamp, isSeek = false, videoElement = null) {
    this._frameCount++;

    // ── 1. Handle seek / discontinuity ─────────────────────────────────────
    if (isSeek) {
      this._handleSeek(videoTimestamp);
    }

    // ── 2. Camera motion estimation (every 3rd frame) ───────────────────────
    let camResult = { dx: 0, dy: 0, isReliable: false };
    if (this.enableCameraMotion && videoElement && this._frameCount % 3 === 0) {
      const ballRegion = this.lastConfirmedPosition
        ? { cx: this.lastConfirmedPosition.cx, cy: this.lastConfirmedPosition.cy, r: 0.06 }
        : null;
      camResult = this.cameraMotion.estimate(videoElement, ballRegion);
      this.cameraStatus = !camResult.isReliable   ? 'UNKNOWN'
        : (Math.hypot(camResult.dx, camResult.dy) > 0.005 ? 'MOVING' : 'STABLE');
    }

    // ── 3. Kalman prediction for this frame ─────────────────────────────────
    const dt = (this._lastKalmanTimestamp != null)
      ? Math.max(0, videoTimestamp - this._lastKalmanTimestamp)
      : 0;

    if (this._kalmanInitialised && dt > 0 && dt < 10) {
      this.kalman.predict(dt);

      // Compensate Kalman position for camera motion
      if (camResult.isReliable) {
        this.kalman.x = Math.max(0.01, Math.min(0.99, this.kalman.x + camResult.dx));
        this.kalman.y = Math.max(0.01, Math.min(0.99, this.kalman.y + camResult.dy));
      }
    }

    // ── 4. State machine transition ─────────────────────────────────────────
    const hasDetection = !!detectedBall;
    const prevState    = this.trackingState;

    if (hasDetection) {
      this.recordDetection(detectedBall, videoTimestamp, camResult);
      this._lastKalmanTimestamp = videoTimestamp;

      this.missedDetectionFrames = 0;
      this.predictedFrames       = 0;

      const conf = detectedBall.confidence ?? 0;
      if (conf >= CONFIRMED_CONFIDENCE_THRESHOLD) {
        this.reacquisitionAttempts = 0;
        this._transitionTo(
          this.trackingState === TrackingState.REACQUIRING ||
          this.trackingState === TrackingState.LOST
            ? TrackingState.DETECTED
            : TrackingState.TRACKED,
          videoTimestamp
        );
      } else {
        this._transitionTo(TrackingState.DETECTED, videoTimestamp);
      }

      this.searchRadius = MIN_SEARCH_RADIUS;
      this.searchMode   = 'LOCAL';
    } else {
      this.missedDetectionFrames++;
      this._lastKalmanTimestamp = videoTimestamp;

      if (this.trackingState === TrackingState.DETECTED ||
          this.trackingState === TrackingState.TRACKED) {
        this._transitionTo(TrackingState.PREDICTED, videoTimestamp);
        this.predictedFrames = 1;
      } else if (this.trackingState === TrackingState.PREDICTED) {
        this.predictedFrames++;
        if (this.predictedFrames > MAX_PREDICTED_FRAMES) {
          this._transitionTo(TrackingState.UNCERTAIN, videoTimestamp);
        }
      } else if (this.trackingState === TrackingState.UNCERTAIN) {
        if (this.missedDetectionFrames > MAX_UNCERTAIN_FRAMES) {
          this._transitionTo(TrackingState.LOST, videoTimestamp);
        }
      } else if (this.trackingState === TrackingState.LOST) {
        this.reacquisitionAttempts++;
        this._transitionTo(TrackingState.REACQUIRING, videoTimestamp);
      }

      // Grow search region as confidence falls
      const growthFactor = 1.0 + (this.missedDetectionFrames * 0.06);
      this.searchRadius = Math.min(MAX_SEARCH_RADIUS, MIN_SEARCH_RADIUS * growthFactor);
      this.searchMode   = this.searchRadius >= MAX_SEARCH_RADIUS ? 'FULL_FRAME'
                        : this.searchRadius >  0.18              ? 'EXPANDED'
                        : 'LOCAL';
    }

    // ── 5. Return query result ──────────────────────────────────────────────
    return this._buildQueryResult(videoTimestamp);
  }

  /**
   * Query the memory for the best predicted position and search hint.
   * Can be called independently of update() e.g. to seed the detector hint.
   *
   * @param {number} videoTimestamp
   * @returns {MemoryQueryResult}
   */
  query(videoTimestamp) {
    return this._buildQueryResult(videoTimestamp);
  }

  /**
   * Export a compact JSON diagnostic snapshot.
   * Does not include pixel data or full history arrays.
   */
  exportDiagnostic() {
    return {
      exportedAt:              new Date().toISOString(),
      trackingState:           this.trackingState,
      cameraStatus:            this.cameraStatus,
      searchMode:              this.searchMode,
      searchRadius:            +this.searchRadius.toFixed(4),
      missedDetectionFrames:   this.missedDetectionFrames,
      predictedFrames:         this.predictedFrames,
      reacquisitionAttempts:   this.reacquisitionAttempts,
      totalMemorySamples:      this.detectionHistory.length,
      memoryWindowSec:         this.memoryWindowSec,
      lastConfirmedTimestamp:  this.lastConfirmedTimestamp,
      lastConfirmedPosition:   this.lastConfirmedPosition,
      kalman: {
        x:           +this.kalman.x.toFixed(4),
        y:           +this.kalman.y.toFixed(4),
        vx:          +this.kalman.vx.toFixed(4),
        vy:          +this.kalman.vy.toFixed(4),
        uncertainty: +this.kalman.uncertainty.toFixed(4)
      },
      recentStateTransitions: this.stateTransitions.slice(-10),
      shortTermSamples:       this._getShortTermSamples(
        this.lastConfirmedTimestamp ?? 0
      ).length,
      mediumTermSamples:      this._getMediumTermSamples(
        this.lastConfirmedTimestamp ?? 0
      ).length,
      longTermSamples:        this.detectionHistory.length
    };
  }

  /**
   * Reset all memory. Called on stop, switch-video, or hard seek.
   */
  reset() {
    this.detectionHistory          = [];
    this.trackingState             = TrackingState.LOST;
    this.lastConfirmedTimestamp    = null;
    this.lastConfirmedPosition     = null;
    this.missedDetectionFrames     = 0;
    this.predictedFrames           = 0;
    this.reacquisitionAttempts     = 0;
    this._kalmanInitialised        = false;
    this._lastKalmanTimestamp      = null;
    this.kalman                    = new KalmanFilter2D();
    this.cameraMotion.reset();
    this.cameraStatus              = 'UNKNOWN';
    this.stateTransitions          = [];
    this.searchRadius              = MIN_SEARCH_RADIUS;
    this.searchMode                = 'LOCAL';
    this._frameCount               = 0;
  }

  // ── Timescale Accessors ────────────────────────────────────────────────────

  /**
   * Records from the last 0–2 seconds.
   * @param {number} currentTimestamp
   */
  getShortTermHistory(currentTimestamp) {
    return this._getShortTermSamples(currentTimestamp);
  }

  /**
   * Records from the last 2–15 seconds.
   * @param {number} currentTimestamp
   */
  getMediumTermHistory(currentTimestamp) {
    return this._getMediumTermSamples(currentTimestamp);
  }

  /**
   * Records from the last 15–120 seconds.
   * @param {number} currentTimestamp
   */
  getLongTermHistory(currentTimestamp) {
    const floor = currentTimestamp - this.memoryWindowSec;
    const start = currentTimestamp - MEDIUM_TERM_SEC;
    return this.detectionHistory.filter(r =>
      r.videoTimestamp >= floor && r.videoTimestamp < start
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _getShortTermSamples(currentTimestamp) {
    const floor = currentTimestamp - SHORT_TERM_SEC;
    return this.detectionHistory.filter(r => r.videoTimestamp >= floor);
  }

  _getMediumTermSamples(currentTimestamp) {
    const floor = currentTimestamp - MEDIUM_TERM_SEC;
    const start = currentTimestamp - SHORT_TERM_SEC;
    return this.detectionHistory.filter(r =>
      r.videoTimestamp >= floor && r.videoTimestamp < start
    );
  }

  /**
   * Remove records older than memoryWindowSec from the given timestamp.
   * @param {number} currentTimestamp
   */
  _pruneOldRecords(currentTimestamp) {
    const cutoff = currentTimestamp - this.memoryWindowSec;
    // Records are appended in time order; trim from the front
    let removeCount = 0;
    for (const r of this.detectionHistory) {
      if (r.videoTimestamp < cutoff) removeCount++;
      else break;
    }
    if (removeCount > 0) this.detectionHistory.splice(0, removeCount);
  }

  /**
   * Transition the state machine, recording the change.
   * No-op if state hasn't changed.
   */
  _transitionTo(newState, videoTimestamp) {
    if (newState === this.trackingState) return;
    this.stateTransitions.push({
      from:           this.trackingState,
      to:             newState,
      videoTimestamp
    });
    // Keep only the last 50 transitions in memory
    if (this.stateTransitions.length > 50) this.stateTransitions.shift();
    this.trackingState = newState;
  }

  /**
   * Called when a seek is detected.
   * Resets short-term prediction but retains long-term history.
   */
  _handleSeek(newTimestamp) {
    // Invalidate the Kalman filter — position is no longer meaningful
    this._kalmanInitialised   = false;
    this._lastKalmanTimestamp = null;
    this.missedDetectionFrames = 0;
    this.predictedFrames       = 0;
    this.cameraMotion.reset();
    this.cameraStatus          = 'UNKNOWN';
    this.searchRadius          = MIN_SEARCH_RADIUS;
    this.searchMode            = 'LOCAL';

    // If we have confirmed history near the new timestamp, restore state
    const nearbyRecord = this._findNearbyRecord(newTimestamp, 2.0);
    if (nearbyRecord) {
      this.kalman.init(nearbyRecord.centerX, nearbyRecord.centerY);
      this._kalmanInitialised   = true;
      this._lastKalmanTimestamp = newTimestamp;
      this._transitionTo(TrackingState.PREDICTED, newTimestamp);
    } else {
      this._transitionTo(TrackingState.LOST, newTimestamp);
    }
  }

  /**
   * Find the most recent confirmed record within `windowSec` of `timestamp`.
   */
  _findNearbyRecord(timestamp, windowSec = 2.0) {
    const floor = timestamp - windowSec;
    const ceil  = timestamp + windowSec;
    let best = null;
    for (const r of this.detectionHistory) {
      if (r.videoTimestamp >= floor && r.videoTimestamp <= ceil) {
        if (r.confidence >= CONFIRMED_CONFIDENCE_THRESHOLD) {
          if (!best || r.confidence > best.confidence) best = r;
        }
      }
    }
    return best;
  }

  /**
   * Build the MemoryQueryResult returned by update() and query().
   * @param {number} videoTimestamp
   * @returns {MemoryQueryResult}
   */
  _buildQueryResult(videoTimestamp) {
    const ageSec = (this.lastConfirmedTimestamp != null)
      ? Math.max(0, videoTimestamp - this.lastConfirmedTimestamp)
      : null;

    // Confidence in the Kalman prediction decays with age and missed frames
    let predictionConfidence = 0;
    if (this._kalmanInitialised) {
      const ageDecay    = ageSec != null ? Math.max(0, 1 - ageSec / 10) : 0;
      const missedDecay = Math.max(0, 1 - this.missedDetectionFrames / MAX_UNCERTAIN_FRAMES);
      predictionConfidence = ageDecay * missedDecay * (1 - this.kalman.uncertainty * 2);
      predictionConfidence = Math.max(0, Math.min(1, predictionConfidence));
    }

    return {
      // ── State ─────────────────────────────────────────────────
      trackingState:          this.trackingState,
      searchMode:             this.searchMode,
      searchRadius:           this.searchRadius,
      cameraStatus:           this.cameraStatus,

      // ── Predicted position (from Kalman) ──────────────────────
      predictedCx:            this._kalmanInitialised ? this.kalman.x  : null,
      predictedCy:            this._kalmanInitialised ? this.kalman.y  : null,
      predictedVx:            this._kalmanInitialised ? this.kalman.vx : null,
      predictedVy:            this._kalmanInitialised ? this.kalman.vy : null,
      positionUncertainty:    this._kalmanInitialised ? this.kalman.uncertainty : 1.0,
      predictionConfidence,

      // ── Last confirmed ─────────────────────────────────────────
      lastConfirmedPosition:  this.lastConfirmedPosition,
      lastConfirmedTimestamp: this.lastConfirmedTimestamp,
      ageSinceLastConfirmed:  ageSec,

      // ── Counters ───────────────────────────────────────────────
      missedDetectionFrames:  this.missedDetectionFrames,
      reacquisitionAttempts:  this.reacquisitionAttempts,
      totalMemorySamples:     this.detectionHistory.length,

      // ── Search hint ─────────────────────────────────────────── 
      searchHint: (this._kalmanInitialised && this.trackingState !== TrackingState.LOST)
        ? {
            cx:     this.kalman.x,
            cy:     this.kalman.y,
            radius: this.searchRadius
          }
        : null
    };
  }
}

/**
 * @typedef {object} DetectionRecord
 * @property {number} videoTimestamp
 * @property {number} centerX
 * @property {number} centerY
 * @property {number} width
 * @property {number} height
 * @property {number} confidence
 * @property {string} state
 * @property {number} velocityX
 * @property {number} velocityY
 * @property {string} source
 * @property {boolean} cameraMotionCompensated
 */

/**
 * @typedef {object} MemoryQueryResult
 * @property {string}      trackingState
 * @property {string}      searchMode
 * @property {number}      searchRadius
 * @property {string}      cameraStatus
 * @property {number|null} predictedCx
 * @property {number|null} predictedCy
 * @property {number|null} predictedVx
 * @property {number|null} predictedVy
 * @property {number}      positionUncertainty
 * @property {number}      predictionConfidence
 * @property {object|null} lastConfirmedPosition
 * @property {number|null} lastConfirmedTimestamp
 * @property {number|null} ageSinceLastConfirmed
 * @property {number}      missedDetectionFrames
 * @property {number}      reacquisitionAttempts
 * @property {number}      totalMemorySamples
 * @property {object|null} searchHint
 */
