/**
 * Football Event Recognition Rules and Heuristics
 * Analyzes object detections, ball trajectory vectors, and player possession.
 */

export const GOAL_GEOMETRY = {
  leftGoal: { x: 0.06, yMin: 0.35, yMax: 0.65 },
  rightGoal: { x: 0.94, yMin: 0.35, yMax: 0.65 }
};

/**
 * Check if ball trajectory vector is directed toward a goal mouth.
 * @param {object} ball - { cx, cy }
 * @param {number} vx - Ball horizontal velocity
 * @param {number} vy - Ball vertical velocity
 * @returns {object|null} { targetGoal: 'left'|'right', confidence: number }
 */
export function isTrajectoryTowardGoal(ball, vx, vy) {
  if (Math.abs(vx) < 0.008) return null; // Too slow

  // Shot toward left goal
  if (vx < -0.015 && ball.cx < 0.45) {
    const projectedY = ball.cy + (GOAL_GEOMETRY.leftGoal.x - ball.cx) * (vy / vx);
    if (projectedY >= GOAL_GEOMETRY.leftGoal.yMin - 0.1 && projectedY <= GOAL_GEOMETRY.leftGoal.yMax + 0.1) {
      return { targetGoal: 'left', projectedY, confidence: 0.82 };
    }
  }

  // Shot toward right goal
  if (vx > 0.015 && ball.cx > 0.55) {
    const projectedY = ball.cy + (GOAL_GEOMETRY.rightGoal.x - ball.cx) * (vy / vx);
    if (projectedY >= GOAL_GEOMETRY.rightGoal.yMin - 0.1 && projectedY <= GOAL_GEOMETRY.rightGoal.yMax + 0.1) {
      return { targetGoal: 'right', projectedY, confidence: 0.82 };
    }
  }

  return null;
}

/**
 * Check if the ball crossed the visible goal line.
 * @param {object} ball - { cx, cy }
 * @param {Array<object>} trail - Trajectory trail
 * @returns {object|null}
 */
export function isGoalLineCrossed(ball, trail) {
  if (!ball || !trail || trail.length < 2) return null;

  const prev = trail[trail.length - 2];

  // Left goal crossing
  if (prev.cx >= GOAL_GEOMETRY.leftGoal.x && ball.cx < GOAL_GEOMETRY.leftGoal.x) {
    if (ball.cy >= GOAL_GEOMETRY.leftGoal.yMin && ball.cy <= GOAL_GEOMETRY.leftGoal.yMax) {
      return { goalSide: 'left', confidence: 0.94 };
    }
  }

  // Right goal crossing
  if (prev.cx <= GOAL_GEOMETRY.rightGoal.x && ball.cx > GOAL_GEOMETRY.rightGoal.x) {
    if (ball.cy >= GOAL_GEOMETRY.rightGoal.yMin && ball.cy <= GOAL_GEOMETRY.rightGoal.yMax) {
      return { goalSide: 'right', confidence: 0.94 };
    }
  }

  return null;
}
