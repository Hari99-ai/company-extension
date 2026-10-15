/**
 * Football Trajectory and Velocity Tracker
 * Maintains trajectory history, estimates speed & heading vectors,
 * and detects player possession proximity.
 */

export class BallTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.maxTrailLength=20] - Number of points in trajectory trail
   * @param {number} [options.maxLostFrames=8] - Frames to predict ball when undetected
   */
  constructor(options = {}) {
    this.maxTrailLength = options.maxTrailLength || 20;
    this.maxLostFrames = options.maxLostFrames || 8;

    this.currentBall = null; // { x, y, width, height, confidence, cx, cy }
    this.trail = []; // Array of { cx, cy, time, speed }
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;
    this.lostFrames = 0;
    this.currentPossessionPlayerId = null;
  }

  /**
   * Update ball position with current frame detection.
   * @param {object|null} detectedBall - { x, y, width, height, confidence }
   * @param {number} matchTimestamp - Current video time in seconds
   * @param {Array<object>} trackedPlayers - Array of active player tracks
   * @returns {object} { ball, speed, headingAngle, inPossessionOf, trail, lostFrames }
   */
  update(detectedBall, matchTimestamp, trackedPlayers = []) {
    if (detectedBall) {
      const cx = detectedBall.x + detectedBall.width / 2;
      const cy = detectedBall.y + detectedBall.height / 2;

      if (this.currentBall) {
        // Calculate velocity
        this.vx = cx - (this.currentBall.cx || cx);
        this.vy = cy - (this.currentBall.cy || cy);
        this.speed = Math.hypot(this.vx, this.vy);
      } else {
        this.vx = 0;
        this.vy = 0;
        this.speed = 0;
      }

      this.currentBall = {
        ...detectedBall,
        cx,
        cy
      };
      this.lostFrames = 0;

      // Add to trail
      this.trail.push({ cx, cy, time: matchTimestamp, speed: this.speed });
      if (this.trail.length > this.maxTrailLength) {
        this.trail.shift();
      }
    } else {
      this.lostFrames++;
      if (this.lostFrames <= this.maxLostFrames && this.currentBall) {
        // Ballistic extrapolation using last known velocity
        const predictedCx = this.currentBall.cx + this.vx;
        const predictedCy = this.currentBall.cy + this.vy;
        this.currentBall.cx = predictedCx;
        this.currentBall.cy = predictedCy;
        this.currentBall.x = predictedCx - this.currentBall.width / 2;
        this.currentBall.y = predictedCy - this.currentBall.height / 2;
        this.currentBall.confidence = Math.max(0.05, this.currentBall.confidence * 0.85);

        this.trail.push({ cx: predictedCx, cy: predictedCy, time: matchTimestamp, speed: this.speed });
        if (this.trail.length > this.maxTrailLength) {
          this.trail.shift();
        }
      } else {
        this.currentBall = null;
        this.vx = 0;
        this.vy = 0;
        this.speed = 0;
      }
    }

    // Determine possession: player closest to ball within proximity threshold
    let nearestPlayer = null;
    let minDistance = Infinity;

    if (this.currentBall && trackedPlayers.length > 0) {
      const bcx = this.currentBall.cx;
      const bcy = this.currentBall.cy;

      for (const player of trackedPlayers) {
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height * 0.85; // Foot / lower body region
        const dist = Math.hypot(bcx - pcx, bcy - pcy);

        if (dist < minDistance) {
          minDistance = dist;
          nearestPlayer = player;
        }
      }
    }

    // Possession threshold: within 6% of screen dimension
    const inPossession = (minDistance < 0.06 && nearestPlayer) ? nearestPlayer : null;
    this.currentPossessionPlayerId = inPossession ? inPossession.id : null;

    return {
      ball: this.currentBall,
      vx: this.vx,
      vy: this.vy,
      speed: this.speed,
      trail: this.trail,
      lostFrames: this.lostFrames,
      inPossessionPlayer: inPossession
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
  }
}
