/**
 * Football Event Analyzer
 * Evaluates multi-frame temporal sequences, possession transfers,
 * and goalmouth trajectories to generate verified event candidates.
 */

import { isTrajectoryTowardGoal, isGoalLineCrossed, GOAL_GEOMETRY } from './event-rules.js';
import { isDuplicateEvent } from '../utils/timestamps.js';

export class FootballEventAnalyzer {
  /**
   * @param {object} [options]
   * @param {function} [options.onEventCandidate] - Callback for new candidate event
   * @param {number} [options.dedupWindow=2.5]
   */
  constructor(options = {}) {
    this.onEventCandidate = options.onEventCandidate || (() => {});
    this.dedupWindow = options.dedupWindow || 2.5;

    this.confirmedLogs = [];
    this.pendingSuggestions = [];

    // Temporal state tracking
    this.lastPossessionPlayer = null; // { id, team, time, x, y }
    this.lastPassRelease = null;     // { fromPlayer, time, releaseSpeed }
    this.activeShot = null;          // { player, time, targetGoal }
  }

  /**
   * Process a single video frame with tracked objects.
   * @param {object} ballState - From BallTracker: { ball, vx, vy, speed, trail, inPossessionPlayer }
   * @param {Array<object>} trackedPlayers - Active player tracks
   * @param {number} matchTimestamp - Current match time in seconds
   */
  processFrame(ballState, trackedPlayers, matchTimestamp) {
    const { ball, vx, vy, speed, trail, inPossessionPlayer } = ballState;
    if (!ball) return;

    // 1. Check GOAL crossing
    const goalCrossing = isGoalLineCrossed(ball, trail);
    if (goalCrossing) {
      this._emitCandidate({
        eventType: 'goal',
        matchTimestamp,
        team: this.lastPossessionPlayer ? this.lastPossessionPlayer.team : 'Unknown',
        playerId: this.lastPossessionPlayer ? `P${this.lastPossessionPlayer.id}` : null,
        confidence: goalCrossing.confidence,
        status: 'needs_review',
        evidence: [
          `Ball crossed ${goalCrossing.goalSide} goal line`,
          `Ball speed at crossing: ${(speed * 100).toFixed(1)}`
        ]
      });
      this.activeShot = null;
    }

    // 2. Check SHOT toward goal
    const shotTrajectory = isTrajectoryTowardGoal(ball, vx, vy);
    if (shotTrajectory && speed > 0.02) {
      if (!this.activeShot || (matchTimestamp - this.activeShot.time) > 3.0) {
        this.activeShot = {
          player: inPossessionPlayer || this.lastPossessionPlayer,
          time: matchTimestamp,
          targetGoal: shotTrajectory.targetGoal
        };

        const shootingTeam = this.activeShot.player ? this.activeShot.player.team : 'Unknown';
        const shooterId = this.activeShot.player ? `P${this.activeShot.player.id}` : null;

        this._emitCandidate({
          eventType: 'shot',
          matchTimestamp,
          team: shootingTeam,
          playerId: shooterId,
          confidence: shotTrajectory.confidence,
          status: 'needs_review',
          evidence: [
            `Ball trajectory directed toward ${shotTrajectory.targetGoal} goal mouth`,
            `High exit velocity: ${(speed * 100).toFixed(1)}`
          ]
        });
      }
    }

    // 3. Check SAVE / DEFENSIVE ACTION if a shot was active
    if (this.activeShot && inPossessionPlayer && (matchTimestamp - this.activeShot.time) < 2.5) {
      const isDefendingTeam = this.activeShot.player && inPossessionPlayer.team !== this.activeShot.player.team;
      const nearGoal = inPossessionPlayer.x < 0.20 || inPossessionPlayer.x > 0.80;

      if (isDefendingTeam && nearGoal) {
        this._emitCandidate({
          eventType: 'save',
          matchTimestamp,
          team: inPossessionPlayer.team,
          playerId: `P${inPossessionPlayer.id}`,
          confidence: 0.81,
          status: 'needs_review',
          evidence: [
            'Interception of active shot near goalmouth',
            `Defending player ID ${inPossessionPlayer.id} contested ball`
          ]
        });
        this.activeShot = null;
      }
    }

    // 4. Check PASS (Transfer between players)
    if (inPossessionPlayer) {
      if (this.lastPossessionPlayer && this.lastPossessionPlayer.id !== inPossessionPlayer.id) {
        const timeDelta = matchTimestamp - this.lastPossessionPlayer.time;

        if (timeDelta > 0.3 && timeDelta < 4.5) {
          const sameTeam = this.lastPossessionPlayer.team === inPossessionPlayer.team;
          const dist = Math.hypot(
            inPossessionPlayer.x - this.lastPossessionPlayer.x,
            inPossessionPlayer.y - this.lastPossessionPlayer.y
          );

          if (sameTeam && dist > 0.1) {
            this._emitCandidate({
              eventType: dist > 0.35 ? 'long-pass' : 'short-pass',
              matchTimestamp: this.lastPossessionPlayer.time,
              team: inPossessionPlayer.team,
              playerId: `P${this.lastPossessionPlayer.id}`,
              confidence: 0.79,
              status: 'needs_review',
              evidence: [
                `Ball transfer from P${this.lastPossessionPlayer.id} to P${inPossessionPlayer.id}`,
                `Travel distance: ${Math.round(dist * 100)}% of pitch width`,
                `Duration: ${timeDelta.toFixed(1)}s`
              ]
            });
          } else if (!sameTeam && dist > 0.08) {
            // Turnover / Defensive action
            this._emitCandidate({
              eventType: 'defensive-action',
              matchTimestamp,
              team: inPossessionPlayer.team,
              playerId: `P${inPossessionPlayer.id}`,
              confidence: 0.74,
              status: 'needs_review',
              evidence: [
                `Possession gained from opposing team player P${this.lastPossessionPlayer.id}`
              ]
            });
          }
        }
      }

      // Update current possession holder
      this.lastPossessionPlayer = {
        id: inPossessionPlayer.id,
        team: inPossessionPlayer.team,
        time: matchTimestamp,
        x: inPossessionPlayer.x,
        y: inPossessionPlayer.y
      };
    }
  }

  _emitCandidate(candidate) {
    // Generate unique ID
    candidate.id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    // Suppress duplicates within time window
    const allRecent = [...this.confirmedLogs, ...this.pendingSuggestions];
    if (isDuplicateEvent(candidate, allRecent, this.dedupWindow)) {
      return;
    }

    this.pendingSuggestions.unshift(candidate);
    this.onEventCandidate(candidate);
  }

  setConfirmedLogs(logs) {
    this.confirmedLogs = logs;
  }
}
