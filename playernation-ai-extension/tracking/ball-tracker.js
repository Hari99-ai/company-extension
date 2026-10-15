/**
 * Football Trajectory and Velocity Tracker
 * Maintains trajectory history, estimates speed & heading vectors,
 * and detects player possession proximity.
 *
 * Now integrates with FootballMemoryManager for two-minute rolling memory,
 * Kalman-filter prediction, and memory-assisted reacquisition.
 */

export class BallTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.maxTrailLength=25]  - Number of points in trajectory trail
   * @param {number} [options.maxLostFrames=30]   - Frames to predict ball when undetected (~3.5s)
   * @param {import('./memory-manager.js').FootballMemoryManager} [options.memoryManager]
   *   - Optional pre-constructed FootballMemoryManager instance
   */
  constructor(options = {}) {
    this.maxTrailLength = options.maxTrailLength || 25;
    this.maxLostFrames  = options.maxLostFrames  || 30;

    /** Optional two-minute memory manager injected from content.js */
    this.memoryManager = options.memoryManager || null;

    this.currentBall = null; // { x, y, width, height, confidence, cx, cy, isManual, inferredFromPossession }
    this.trail = []; // Array of { cx, cy, time, speed, isManual }
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;
    this.lostFrames = 0;
    this.currentPossessionPlayerId = null;
    this.manualLock = false;
    this.manualLockFrames = 0;
    this.lastUpdateTime = 0;

    /** Latest result from memory manager (exposed for overlay / HUD). */
    this.memoryState = null;
  }

  /**
   * Notify the memory manager of a video seek so it can reset short-term state.
   * Call this from content.js whenever a seek is detected.
   * @param {number} newTimestamp
   */
  notifySeek(newTimestamp) {
    if (this.memoryManager) {
      // The memory manager handles seek internally via isSeek flag in update(),
      // but an explicit reset of Kalman is triggered the next update() call.
      // We also reset short-term BallTracker state.
      this.vx = 0;
      this.vy = 0;
      this.speed = 0;
      // Don't null currentBall — the memory manager may restore it from history.
    }
  }

  /**
   * Set football location manually (user clicked or indicated object as football).
   * @param {number} cx - Normalized center X (0..1)
   * @param {number} cy - Normalized center Y (0..1)
   * @param {number} matchTimestamp - Current match time in seconds
   * @param {Array<object>} trackedPlayers - Active player tracks
   * @param {number} [radius=0.012]
   * @returns {object} Updated ball tracking package
   */
  setManualBall(cx, cy, matchTimestamp, trackedPlayers = [], radius = 0.012) {
    const w = radius * 2;
    const h = radius * 2;
    const x = Math.max(0, Math.min(1 - w, cx - radius));
    const y = Math.max(0, Math.min(1 - h, cy - radius));

    // Calculate instantaneous velocity if we had a prior ball position
    if (this.currentBall) {
      this.vx = cx - this.currentBall.cx;
      this.vy = cy - this.currentBall.cy;
      const spd = Math.hypot(this.vx, this.vy);
      if (spd > 0.08) {
        this.vx = (this.vx / spd) * 0.08;
        this.vy = (this.vy / spd) * 0.08;
      }
      this.speed = Math.hypot(this.vx, this.vy);
    } else {
      this.vx = 0;
      this.vy = 0;
      this.speed = 0;
    }

    const manualBall = {
      x,
      y,
      width: w,
      height: h,
      confidence: 1.0,
      cx,
      cy,
      isManual: true,
      manualTimestamp: matchTimestamp
    };

    this.currentBall = manualBall;
    this.lostFrames = 0;
    this.manualLock = true;
    this.manualLockFrames = 999999; // Stays locked until explicitly unlocked by user or session stops
    this.lastUpdateTime = matchTimestamp;

    this.trail.push({ cx, cy, time: matchTimestamp, speed: this.speed, isManual: true });
    if (this.trail.length > this.maxTrailLength) {
      this.trail.shift();
    }

    // Record manual placement into memory
    if (this.memoryManager) {
      this.memoryManager.recordDetection(manualBall, matchTimestamp);
    }

    // Check immediate player possession
    let nearestPlayer = null;
    let minDistance = Infinity;
    for (const player of trackedPlayers) {
      const pcx = player.x + player.width / 2;
      const pcy = player.y + player.height * 0.85;
      const dist = Math.hypot(cx - pcx, cy - pcy);
      if (dist < minDistance) {
        minDistance = dist;
        nearestPlayer = player;
      }
    }
    const inPossession = (minDistance < 0.07 && nearestPlayer) ? nearestPlayer : null;
    this.currentPossessionPlayerId = inPossession ? inPossession.id : null;

    return {
      ball: this.currentBall,
      vx: this.vx,
      vy: this.vy,
      speed: this.speed,
      trail: this.trail,
      lostFrames: this.lostFrames,
      inPossessionPlayer: inPossession,
      manualLock: true,
      memoryState: this.memoryState
    };
  }

  clearManualLock() {
    this.manualLock = false;
    this.manualLockFrames = 0;
    if (this.currentBall) {
      this.currentBall.isManual = false;
    }
  }

  /**
   * Fast Saliency & Circular Contrast Ball Detector on localized video crop.
   * The search centre is now optionally overridden by the memory manager's
   * Kalman-predicted position when the caller provides a memoryHint.
   *
   * @param {HTMLVideoElement} video
   * @param {number} targetCx - Expected ball center X (0..1)
   * @param {number} targetCy - Expected ball center Y (0..1)
   * @returns {object|null}
   */
  detectBallBySaliency(video, targetCx, targetCy) {
    if (!video || typeof document === 'undefined') return null;
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return null;

      if (!this._saliencyCanvas) {
        this._saliencyCanvas = document.createElement('canvas');
        this._saliencyCanvas.width = 96;
        this._saliencyCanvas.height = 96;
        this._saliencyCtx = this._saliencyCanvas.getContext('2d', { willReadFrequently: true });
      }

      const cropW = Math.round(vw * 0.12);
      const cropH = Math.round(vh * 0.12);
      const cropX = Math.max(0, Math.min(vw - cropW, Math.round(targetCx * vw - cropW / 2)));
      const cropY = Math.max(0, Math.min(vh - cropH, Math.round(targetCy * vh - cropH / 2)));

      this._saliencyCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, 96, 96);
      const imgData = this._saliencyCtx.getImageData(0, 0, 96, 96);
      const d = imgData.data;

      let sumX = 0;
      let sumY = 0;
      let count = 0;

      for (let y = 8; y < 88; y++) {
        for (let x = 8; x < 88; x++) {
          const idx = (y * 96 + x) * 4;
          const r = d[idx];
          const g = d[idx + 1];
          const b = d[idx + 2];

          const isGrass = (g > r + 12) && (g > b + 12);
          const brightness = (r + g + b) / 3;

          if (!isGrass && brightness > 135) {
            sumX += x;
            sumY += y;
            count++;
          }
        }
      }

      if (count >= 6 && count <= 240) {
        const localX = sumX / count;
        const localY = sumY / count;
        const foundCx = (cropX + (localX / 96) * cropW) / vw;
        const foundCy = (cropY + (localY / 96) * cropH) / vh;
        const wNorm = Math.max(0.012, (cropW * Math.sqrt(count / Math.PI) * 2 / 96) / vw);
        const hNorm = Math.max(0.012, (cropH * Math.sqrt(count / Math.PI) * 2 / 96) / vh);

        return {
          x: Math.max(0, foundCx - wNorm / 2),
          y: Math.max(0, foundCy - hNorm / 2),
          width: wNorm,
          height: hNorm,
          cx: foundCx,
          cy: foundCy,
          confidence: 0.75,
          isSaliency: true
        };
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /**
   * Update ball position with current frame detection.
   *
   * Memory integration:
   *  - If detectedBall is present: record to memory, advance memory state machine.
   *  - If detectedBall is missing: query memory for Kalman prediction and use it
   *    as the saliency search centre before falling back to velocity extrapolation.
   *  - isSeek flag resets memory short-term state on discontinuities.
   *
   * @param {object|null}  detectedBall     - { x, y, width, height, confidence }
   * @param {number}       matchTimestamp   - Current video time in seconds
   * @param {Array<object>} trackedPlayers  - Array of active player tracks
   * @param {Array<object>} candidateBalls  - Optional array of all detected ball proposals
   * @param {HTMLVideoElement} [videoElement=null]
   * @param {boolean}      [isSeek=false]   - True when video.seeking was detected
   * @returns {object} { ball, speed, headingAngle, inPossessionOf, trail, lostFrames, manualLock, memoryState }
   */
  update(
    detectedBall,
    matchTimestamp,
    trackedPlayers = [],
    candidateBalls = [],
    videoElement = null,
    isSeek = false
  ) {
    this.lastUpdateTime = matchTimestamp;
    let effectiveBall = detectedBall;

    // ── Memory manager update ───────────────────────────────────────────────
    // Pass the raw detected ball (may be null) — manager handles state machine.
    if (this.memoryManager) {
      this.memoryState = this.memoryManager.update(
        detectedBall,
        matchTimestamp,
        isSeek,
        videoElement
      );
    }

    // ── Derive search centre ────────────────────────────────────────────────
    // Prefer: (1) velocity-extrapolated current ball, (2) Kalman prediction, (3) centre
    let targetCx, targetCy;
    if (this.currentBall) {
      targetCx = this.currentBall.cx + this.vx;
      targetCy = this.currentBall.cy + this.vy;
    } else if (this.memoryState?.predictedCx != null) {
      targetCx = this.memoryState.predictedCx;
      targetCy = this.memoryState.predictedCy;
    } else {
      targetCx = 0.5;
      targetCy = 0.5;
    }

    // ── 1. Candidate ball proposals ─────────────────────────────────────────
    if (!effectiveBall && candidateBalls && candidateBalls.length > 0) {
      if (this.currentBall || this.memoryState?.predictedCx != null) {
        let bestCand = null;
        let bestDist = Infinity;

        for (const cand of candidateBalls) {
          const ccx = cand.x + cand.width / 2;
          const ccy = cand.y + cand.height / 2;
          const dist = Math.hypot(ccx - targetCx, ccy - targetCy);
          if (dist < 0.22 && dist < bestDist) {
            bestDist = dist;
            bestCand = cand;
          }
        }

        if (bestCand) {
          effectiveBall = bestCand;
        }
      } else {
        // Auto-initialize to strongest candidate ball
        effectiveBall = candidateBalls.reduce((max, b) => b.confidence > max.confidence ? b : max, candidateBalls[0]);
      }
    }

    // ── 2. Localized saliency detection ─────────────────────────────────────
    // Use Kalman-predicted position as saliency search centre when tracking is uncertain.
    if (!effectiveBall && videoElement) {
      const saliencyCx = targetCx;
      const saliencyCy = targetCy;
      if (this.currentBall || this.memoryState?.searchHint) {
        const saliencyBall = this.detectBallBySaliency(videoElement, saliencyCx, saliencyCy);
        if (saliencyBall) {
          effectiveBall = saliencyBall;
        }
      }
    }

    // ── 3. Memory-assisted recovery: try Kalman position if all else failed ─
    // If memory has high prediction confidence and ball has been briefly lost,
    // synthesise a low-confidence "predicted" ball at the Kalman position so
    // the overlay shows something rather than nothing.
    if (
      !effectiveBall &&
      this.memoryState?.predictedCx != null &&
      this.memoryState?.predictionConfidence > 0.3 &&
      this.memoryState?.missedDetectionFrames <= this.maxLostFrames
    ) {
      const kx = this.memoryState.predictedCx;
      const ky = this.memoryState.predictedCy;
      const w  = this.currentBall?.width  || 0.016;
      const h  = this.currentBall?.height || 0.016;
      // Mark as a predicted ball so the overlay can distinguish it
      effectiveBall = {
        x:          kx - w / 2,
        y:          ky - h / 2,
        width:      w,
        height:     h,
        cx:         kx,
        cy:         ky,
        confidence: Math.min(0.5, this.memoryState.predictionConfidence * 0.6),
        isPredictedByMemory: true
      };
    }

    // ── 4. Core position update (unchanged logic) ───────────────────────────
    if (effectiveBall) {
      const cx = effectiveBall.cx ?? (effectiveBall.x + effectiveBall.width / 2);
      const cy = effectiveBall.cy ?? (effectiveBall.y + effectiveBall.height / 2);

      if (this.currentBall) {
        this.vx = cx - (this.currentBall.cx || cx);
        this.vy = cy - (this.currentBall.cy || cy);
        const spd = Math.hypot(this.vx, this.vy);
        if (spd > 0.08) {
          this.vx = (this.vx / spd) * 0.08;
          this.vy = (this.vy / spd) * 0.08;
        }
        this.speed = Math.hypot(this.vx, this.vy);
      } else {
        // First detection — seed velocity from Kalman if available
        this.vx = this.memoryState?.predictedVx ?? 0;
        this.vy = this.memoryState?.predictedVy ?? 0;
        this.speed = Math.hypot(this.vx, this.vy);
      }

      const isManual = this.manualLock;
      this.currentBall = {
        ...effectiveBall,
        cx,
        cy,
        isManual
      };
      this.lostFrames = 0;

      // Add to trail
      this.trail.push({ cx, cy, time: matchTimestamp, speed: this.speed, isManual });
      if (this.trail.length > this.maxTrailLength) {
        this.trail.shift();
      }
    } else {
      this.lostFrames++;

      // Check possession retention: If a player recently had the ball, keep ball at their feet
      let possessor = null;
      if (this.currentPossessionPlayerId && trackedPlayers.length > 0) {
        possessor = trackedPlayers.find(p => p.id === this.currentPossessionPlayerId);
      }

      if (possessor && this.lostFrames <= 25) {
        // Softly anchor ball at player feet
        const footCx = possessor.x + possessor.width / 2;
        const footCy = possessor.y + possessor.height * 0.88;
        const w = (this.currentBall?.width) || 0.016;
        const h = (this.currentBall?.height) || 0.016;

        this.vx = footCx - (this.currentBall ? this.currentBall.cx : footCx);
        this.vy = footCy - (this.currentBall ? this.currentBall.cy : footCy);
        this.speed = Math.hypot(this.vx, this.vy);

        this.currentBall = {
          x: footCx - w / 2,
          y: footCy - h / 2,
          width: w,
          height: h,
          cx: footCx,
          cy: footCy,
          confidence: Math.max(0.25, (this.currentBall?.confidence || 0.7) * 0.96),
          inferredFromPossession: true,
          isManual: this.manualLock
        };

        this.trail.push({ cx: footCx, cy: footCy, time: matchTimestamp, speed: this.speed, isManual: this.manualLock });
        if (this.trail.length > this.maxTrailLength) {
          this.trail.shift();
        }
      } else if (this.lostFrames <= this.maxLostFrames && this.currentBall) {
        // Friction-damped extrapolation
        this.vx *= 0.94;
        this.vy *= 0.94;
        this.speed = Math.hypot(this.vx, this.vy);

        const predictedCx = Math.max(0.01, Math.min(0.99, this.currentBall.cx + this.vx));
        const predictedCy = Math.max(0.01, Math.min(0.99, this.currentBall.cy + this.vy));
        this.currentBall.cx = predictedCx;
        this.currentBall.cy = predictedCy;
        this.currentBall.x = predictedCx - this.currentBall.width / 2;
        this.currentBall.y = predictedCy - this.currentBall.height / 2;
        this.currentBall.confidence = Math.max(0.08, this.currentBall.confidence * 0.92);
        this.currentBall.isManual = this.manualLock;
        this.currentBall.inferredFromPossession = false;

        this.trail.push({ cx: predictedCx, cy: predictedCy, time: matchTimestamp, speed: this.speed, isManual: this.manualLock });
        if (this.trail.length > this.maxTrailLength) {
          this.trail.shift();
        }
      } else {
        this.currentBall = null;
        this.vx = 0;
        this.vy = 0;
        this.speed = 0;
        this.manualLock = false;
        this.manualLockFrames = 0;
      }
    }

    // ── 5. Determine possession ─────────────────────────────────────────────
    let nearestPlayer = null;
    let minDistance = Infinity;

    if (this.currentBall && trackedPlayers.length > 0) {
      const bcx = this.currentBall.cx;
      const bcy = this.currentBall.cy;

      for (const player of trackedPlayers) {
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height * 0.85;
        const dist = Math.hypot(bcx - pcx, bcy - pcy);

        if (dist < minDistance) {
          minDistance = dist;
          nearestPlayer = player;
        }
      }
    }

    const inPossession = (minDistance < 0.065 && nearestPlayer) ? nearestPlayer : null;
    this.currentPossessionPlayerId = inPossession ? inPossession.id : null;

    return {
      ball: this.currentBall,
      vx: this.vx,
      vy: this.vy,
      speed: this.speed,
      trail: this.trail,
      lostFrames: this.lostFrames,
      inPossessionPlayer: inPossession,
      manualLock: this.manualLock,
      memoryState: this.memoryState
    };
  }

  reset() {
    this.currentBall = null;
    this.trail = [];
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;
    this.lostFrames = 0;
    this.currentPossessionPlayerId = null;
    this.manualLock = false;
    this.manualLockFrames = 0;
    this.lastUpdateTime = 0;
    this.memoryState = null;
    if (this.memoryManager) this.memoryManager.reset();
  }
}
