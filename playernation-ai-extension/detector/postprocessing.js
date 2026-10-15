/**
 * Post-Processing and Non-Maximum Suppression (NMS) for YOLOv8 ONNX Tensors
 */

/**
 * Compute Intersection-over-Union (IoU) of two bounding boxes in [x, y, w, h] format.
 */
export function calculateIoU(boxA, boxB) {
  const xA1 = boxA.x;
  const yA1 = boxA.y;
  const xA2 = boxA.x + boxA.width;
  const yA2 = boxA.y + boxA.height;

  const xB1 = boxB.x;
  const yB1 = boxB.y;
  const xB2 = boxB.x + boxB.width;
  const yB2 = boxB.y + boxB.height;

  const interX1 = Math.max(xA1, xB1);
  const interY1 = Math.max(yA1, yB1);
  const interX2 = Math.min(xA2, xB2);
  const interY2 = Math.min(yA2, yB2);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;

  const areaA = boxA.width * boxA.height;
  const areaB = boxB.width * boxB.height;
  const unionArea = areaA + areaB - interArea;

  return unionArea > 0 ? Math.min(1.0, interArea / unionArea) : 0;
}

/**
 * Apply Non-Maximum Suppression to filter overlapping proposals.
 * @param {Array<object>} boxes - Array of { x, y, width, height, confidence, classId, className }
 * @param {number} [iouThreshold=0.45]
 * @returns {Array<object>} Filtered bounding boxes.
 */
export function nonMaximumSuppression(boxes, iouThreshold = 0.45) {
  // Sort descending by confidence
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const selected = [];

  while (sorted.length > 0) {
    const current = sorted.shift();
    selected.push(current);

    // Filter out boxes with IoU >= threshold of the same class
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].classId === current.classId) {
        const iou = calculateIoU(current, sorted[i]);
        if (iou >= iouThreshold) {
          sorted.splice(i, 1);
        }
      }
    }
  }

  return selected;
}

/**
 * Parse raw YOLOv8 output tensor [1, num_channels, 8400]
 * @param {Float32Array} rawOutput - Output tensor data
 * @param {number} numChannels - Typically 84 (COCO: 4 coords + 80 classes) or 8 (Custom)
 * @param {number} numProposals - Typically 8400
 * @param {object} [options]
 * @param {number} [options.playerConfThreshold=0.30]
 * @param {number} [options.ballConfThreshold=0.15]
 * @param {number} [options.iouThreshold=0.45]
 * @param {boolean} [options.isCoco=true]
 * @returns {object} { ball: object|null, players: Array<object>, allDetections: Array<object> }
 */
export function parseYoloOutput(rawOutput, numChannels = 84, numProposals = 8400, options = {}) {
  const playerConfThreshold = options.playerConfThreshold || 0.25;
  const ballConfThreshold = options.ballConfThreshold || 0.08;
  const iouThreshold = options.iouThreshold || 0.45;
  const isCoco = options.isCoco !== false;

  // COCO class indices
  const PERSON_CLASS_ID = isCoco ? 0 : 1;
  const BALL_CLASS_ID = isCoco ? 32 : 0;

  const candidateBoxes = [];

  for (let i = 0; i < numProposals; i++) {
    // Coordinate offsets (channels 0..3)
    const cx = rawOutput[0 * numProposals + i];
    const cy = rawOutput[1 * numProposals + i];
    const w = rawOutput[2 * numProposals + i];
    const h = rawOutput[3 * numProposals + i];

    // Check Person class
    const personScore = rawOutput[(4 + PERSON_CLASS_ID) * numProposals + i];
    if (personScore >= playerConfThreshold) {
      candidateBoxes.push({
        x: Math.max(0, (cx - w / 2) / 640),
        y: Math.max(0, (cy - h / 2) / 640),
        width: w / 640,
        height: h / 640,
        confidence: personScore,
        classId: PERSON_CLASS_ID,
        className: 'player'
      });
    }

    // Check Sports Ball class
    const ballScore = rawOutput[(4 + BALL_CLASS_ID) * numProposals + i];
    if (ballScore >= ballConfThreshold) {
      const bw = w / 640;
      const bh = h / 640;
      const aspect = w / (h || 1e-5);
      // Valid football in match broadcast: compact spherical shape, not oversized banners or pitch lines
      if (bw <= 0.09 && bh <= 0.09 && aspect >= 0.35 && aspect <= 2.8) {
        candidateBoxes.push({
          x: Math.max(0, (cx - w / 2) / 640),
          y: Math.max(0, (cy - h / 2) / 640),
          width: bw,
          height: bh,
          confidence: ballScore,
          classId: BALL_CLASS_ID,
          className: 'ball'
        });
      }
    }
  }

  // Apply NMS
  const filtered = nonMaximumSuppression(candidateBoxes, iouThreshold);

  // Separate ball and players
  const players = filtered.filter(b => b.className === 'player');
  const balls = filtered.filter(b => b.className === 'ball');

  // Select best ball with hint proximity scoring if hint provided
  let bestBall = null;
  if (balls.length > 0) {
    if (options.hintX != null && options.hintY != null) {
      bestBall = balls.reduce((best, b) => {
        const bcx = b.x + b.width / 2;
        const bcy = b.y + b.height / 2;
        const dist = Math.hypot(bcx - options.hintX, bcy - options.hintY);
        const score = b.confidence - dist * 1.5;
        const bestDist = best ? Math.hypot(best.x + best.width / 2 - options.hintX, best.y + best.height / 2 - options.hintY) : 0;
        const bestScore = best ? best.confidence - bestDist * 1.5 : -Infinity;
        return score > bestScore ? b : best;
      }, null);
    } else {
      bestBall = balls.reduce((max, b) => (!max || b.confidence > max.confidence) ? b : max, null);
    }
  }

  return {
    ball: bestBall,
    allBalls: balls,
    players,
    allDetections: filtered
  };
}
