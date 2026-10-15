/**
 * Multi-Object Player Tracker and Jersey Color Classifier
 * Tracks players across consecutive video frames using IoU & centroid distance association,
 * and samples torso pixel regions to classify team assignment.
 */

import { calculateIoU } from '../detector/postprocessing.js';

export class PlayerTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.maxLostFrames=12] - Frames to keep tracking ID when undetected
   * @param {number} [options.iouThreshold=0.3] - Minimum IoU for association
   */
  constructor(options = {}) {
    this.maxLostFrames = options.maxLostFrames || 12;
    this.iouThreshold = options.iouThreshold || 0.3;

    this.nextTrackId = 1;
    this.tracks = []; // Array of { id, x, y, width, height, vx, vy, team, lostFrames, lastSeenTime }
  }

  /**
   * Update tracks with newly detected players and sample jersey colors.
   * @param {Array<object>} detectedPlayers - Array of { x, y, width, height, confidence }
   * @param {ImageData} [imageData] - 640x640 frame for jersey sampling
   * @param {string} [teamAColorHex='#ffffff']
   * @param {string} [teamBColorHex='#dc2626']
   * @returns {Array<object>} Tracked players with persistent IDs and team assignments.
   */
  update(detectedPlayers, imageData = null, teamAColorHex = '#ffffff', teamBColorHex = '#dc2626') {
    const updatedTracks = [];
    const unmatchedDetections = [...detectedPlayers];

    // 1. Predict track positions based on velocity
    for (const track of this.tracks) {
      track.x += track.vx || 0;
      track.y += track.vy || 0;
      track.lostFrames++;
    }

    // 2. Associate detections with existing tracks using IoU & center distance
    for (const track of this.tracks) {
      let bestMatchIdx = -1;
      let highestScore = -Infinity;

      for (let i = 0; i < unmatchedDetections.length; i++) {
        const det = unmatchedDetections[i];
        const iou = calculateIoU(track, det);

        const trackCx = track.x + track.width / 2;
        const trackCy = track.y + track.height / 2;
        const detCx = det.x + det.width / 2;
        const detCy = det.y + det.height / 2;
        const dist = Math.hypot(trackCx - detCx, trackCy - detCy);

        // Combined score: IoU heavily favored, proximity as fallback
        const score = iou * 2.0 - dist;

        if (score > highestScore && (iou >= this.iouThreshold || dist < 0.08)) {
          highestScore = score;
          bestMatchIdx = i;
        }
      }

      if (bestMatchIdx >= 0) {
        const matched = unmatchedDetections.splice(bestMatchIdx, 1)[0];
        // Calculate velocity smoothing
        track.vx = (matched.x - track.x) * 0.4;
        track.vy = (matched.y - track.y) * 0.4;
        track.x = matched.x;
        track.y = matched.y;
        track.width = matched.width;
        track.height = matched.height;
        track.confidence = matched.confidence;
        track.lostFrames = 0;

        // Sample jersey color
        if (imageData) {
          track.team = this.classifyJerseyColor(track, imageData, teamAColorHex, teamBColorHex);
        }

        updatedTracks.push(track);
      } else if (track.lostFrames <= this.maxLostFrames) {
        // Keep track briefly even if occluded
        updatedTracks.push(track);
      }
    }

    // 3. Create new tracks for unmatched detections
    for (const det of unmatchedDetections) {
      const newTrack = {
        id: this.nextTrackId++,
        x: det.x,
        y: det.y,
        width: det.width,
        height: det.height,
        vx: 0,
        vy: 0,
        confidence: det.confidence,
        lostFrames: 0,
        team: imageData ? this.classifyJerseyColor(det, imageData, teamAColorHex, teamBColorHex) : 'Unknown'
      };
      updatedTracks.push(newTrack);
    }

    this.tracks = updatedTracks;

    // Return only active visible tracks
    return this.tracks.filter(t => t.lostFrames === 0);
  }

  /**
   * Sample the torso / chest region of the player's bounding box
   * and classify as Team A, Team B, or Unknown.
   */
  classifyJerseyColor(box, imageData, teamAColorHex, teamBColorHex) {
    const { data, width: imgW, height: imgH } = imageData;

    // Torso region: vertically 20% to 50% from top of player, horizontally middle 60%
    const torsoX1 = Math.floor((box.x + box.width * 0.2) * imgW);
    const torsoX2 = Math.floor((box.x + box.width * 0.8) * imgW);
    const torsoY1 = Math.floor((box.y + box.height * 0.2) * imgH);
    const torsoY2 = Math.floor((box.y + box.height * 0.5) * imgH);

    let sumR = 0, sumG = 0, sumB = 0, count = 0;

    for (let py = torsoY1; py < torsoY2; py++) {
      if (py < 0 || py >= imgH) continue;
      for (let px = torsoX1; px < torsoX2; px++) {
        if (px < 0 || px >= imgW) continue;
        const idx = (py * imgW + px) * 4;

        // Skip green pitch pixels
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Green grass detector: g > r + 20 and g > b + 20
        if (g > r + 25 && g > b + 25) continue;

        sumR += r;
        sumG += g;
        sumB += b;
        count++;
      }
    }

    if (count < 10) return 'Unknown';

    const avgR = sumR / count;
    const avgG = sumG / count;
    const avgB = sumB / count;

    const rgbA = hexToRgb(teamAColorHex);
    const rgbB = hexToRgb(teamBColorHex);

    const distA = colorDistance(avgR, avgG, avgB, rgbA.r, rgbA.g, rgbA.b);
    const distB = colorDistance(avgR, avgG, avgB, rgbB.r, rgbB.g, rgbB.b);

    // If difference is decisive
    if (distA < distB && (distB - distA) > 18) {
      return 'Team A';
    } else if (distB < distA && (distA - distB) > 18) {
      return 'Team B';
    }

    return 'Unknown';
  }
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  if (clean.length === 3) {
    const r = ((bigint >> 8) & 0xf) * 17;
    const g = ((bigint >> 4) & 0xf) * 17;
    const b = (bigint & 0xf) * 17;
    return { r, g, b };
  }
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255
  };
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt(
    Math.pow(r1 - r2, 2) +
    Math.pow(g1 - g2, 2) +
    Math.pow(b1 - b2, 2)
  );
}
