/**
 * coord-transform.js
 * ==================
 * Canonical coordinate-transformation utilities for PlayerNation AI Extension.
 *
 * Five coordinate systems, all kept strictly separate:
 *
 *  A) ORIGINAL VIDEO  – pixel coords relative to video.videoWidth/videoHeight
 *  B) MODEL INPUT     – pixel coords in the letterboxed 640×640 tensor
 *  C) MODEL OUTPUT    – normalised [0..1] coords relative to the 640×640 model
 *                       input (what YOLO actually returns: cx/cy/w/h ÷ 640)
 *  D) NORMALISED VIDEO – [0..1] coords relative to video.videoWidth/videoHeight
 *                        (the canonical internal tracking coordinate system)
 *  E) OVERLAY CANVAS  – pixel coords in the overlay <canvas> element which
 *                        exactly covers the displayed video element
 *
 * Conversion boundaries:
 *   C → B  (denormalise)
 *   B → A  (inverse letterbox / un-pad)
 *   A → D  (normalise by intrinsic video size)
 *   D → E  (scale to canvas dimensions)
 *
 * The compound C→D pipeline is what postprocessing.js + content.js need.
 * The D→E step happens exclusively in renderVideoOverlay().
 *
 * All functions are pure — no side effects, no DOM reads.
 * All bounding-box objects follow { x, y, width, height } in their space.
 *
 * @module coord-transform
 */

/**
 * Compute letterbox parameters from intrinsic video size to model input size.
 *
 * @param {number} videoWidth   – video.videoWidth  (intrinsic)
 * @param {number} videoHeight  – video.videoHeight (intrinsic)
 * @param {number} [modelW=640]
 * @param {number} [modelH=640]
 * @returns {{ scale: number, padX: number, padY: number, scaledW: number, scaledH: number }}
 */
export function computeLetterbox(videoWidth, videoHeight, modelW = 640, modelH = 640) {
  const scale  = Math.min(modelW / videoWidth, modelH / videoHeight);
  const scaledW = Math.round(videoWidth  * scale);
  const scaledH = Math.round(videoHeight * scale);
  const padX    = Math.round((modelW - scaledW) / 2);
  const padY    = Math.round((modelH - scaledH) / 2);
  return { scale, padX, padY, scaledW, scaledH, modelW, modelH };
}

/**
 * Convert a single point from MODEL OUTPUT normalised coords (C) to
 * NORMALISED VIDEO coords (D).
 *
 * Model output: cx and cy are in [0..1] relative to the 640×640 model input.
 * We first convert to model-pixel space (B), strip letterbox padding, divide
 * by scale, then normalise by intrinsic video dimensions.
 *
 * @param {number} normModelX   – x in model-output [0..1] space
 * @param {number} normModelY   – y in model-output [0..1] space
 * @param {{ scale, padX, padY }} letterbox
 * @param {number} [modelW=640]
 * @param {number} [modelH=640]
 * @returns {{ nx: number, ny: number }}  – [0..1] relative to intrinsic video
 */
export function modelNormToVideoNorm(normModelX, normModelY, letterbox, modelW = 640, modelH = 640) {
  // Step 1: model-output norm → model-pixel (B)
  const mpx = normModelX * modelW;
  const mpy = normModelY * modelH;

  // Step 2: model-pixel → original-video pixel (A) – inverse letterbox
  const vpx = (mpx - letterbox.padX) / letterbox.scale;
  const vpy = (mpy - letterbox.padY) / letterbox.scale;

  // Step 3: original-video pixel → normalised [0..1] by callee using
  //         video.videoWidth / video.videoHeight — returned as-is here
  // NOTE: The caller must supply videoWidth/videoHeight; this function
  //       only removes the letterbox. Use modelNormToVideoPixel for pixel output.
  return { vpx, vpy };
}

/**
 * Convert a bounding box from MODEL OUTPUT normalised coords (C)
 * to NORMALISED VIDEO coords (D).
 *
 * The model returns normalised values where 1.0 = 640 px (the model-input size).
 * postprocessing.js already divides cx/cy/w/h by 640, so box.x, box.y, box.width,
 * box.height are all in [0..1] relative to the 640×640 model input space.
 *
 * @param {{ x, y, width, height }} modelBox  – coords in model-output [0..1]
 * @param {{ scale, padX, padY }}   letterbox  – from computeLetterbox()
 * @param {number} videoWidth                  – video.videoWidth
 * @param {number} videoHeight                 – video.videoHeight
 * @param {number} [modelW=640]
 * @param {number} [modelH=640]
 * @returns {{ x, y, width, height, cx, cy, normalised: true }}  – in [0..1] video space (D)
 */
export function modelBoxToVideoNorm(modelBox, letterbox, videoWidth, videoHeight, modelW = 640, modelH = 640) {
  // Convert top-left and bottom-right from model-output [0..1] → model-pixel (B)
  const mpX1 = modelBox.x * modelW;
  const mpY1 = modelBox.y * modelH;
  const mpX2 = (modelBox.x + modelBox.width)  * modelW;
  const mpY2 = (modelBox.y + modelBox.height) * modelH;

  // Inverse letterbox: model-pixel (B) → original-video pixel (A)
  const vpX1 = (mpX1 - letterbox.padX) / letterbox.scale;
  const vpY1 = (mpY1 - letterbox.padY) / letterbox.scale;
  const vpX2 = (mpX2 - letterbox.padX) / letterbox.scale;
  const vpY2 = (mpY2 - letterbox.padY) / letterbox.scale;

  // Clamp to intrinsic video bounds (in pixels)
  const cX1 = Math.max(0, vpX1);
  const cY1 = Math.max(0, vpY1);
  const cX2 = Math.min(videoWidth,  vpX2);
  const cY2 = Math.min(videoHeight, vpY2);

  // Normalise: original-video pixel (A) → [0..1] (D)
  const nx = cX1 / videoWidth;
  const ny = cY1 / videoHeight;
  const nw = Math.max(0, (cX2 - cX1) / videoWidth);
  const nh = Math.max(0, (cY2 - cY1) / videoHeight);

  return {
    ...modelBox,
    x:      nx,
    y:      ny,
    width:  nw,
    height: nh,
    cx:     nx + nw / 2,
    cy:     ny + nh / 2,
    normalised: true
  };
}

/**
 * Convert a bounding box from NORMALISED VIDEO coords (D) to
 * OVERLAY CANVAS pixel coords (E).
 *
 * @param {{ x, y, width, height }} normBox  – [0..1] video-normalised (D)
 * @param {number} canvasWidth               – overlay canvas pixel width
 * @param {number} canvasHeight              – overlay canvas pixel height
 * @returns {{ x, y, width, height, cx, cy }}  – pixel coords on the canvas (E)
 */
export function videoNormToCanvas(normBox, canvasWidth, canvasHeight) {
  const x  = normBox.x      * canvasWidth;
  const y  = normBox.y      * canvasHeight;
  const w  = normBox.width  * canvasWidth;
  const h  = normBox.height * canvasHeight;
  return { x, y, width: w, height: h, cx: x + w / 2, cy: y + h / 2 };
}

/**
 * Convert a single normalised video point (D) to canvas pixels (E).
 *
 * @param {number} nx  – [0..1] horizontal
 * @param {number} ny  – [0..1] vertical
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {{ x: number, y: number }}
 */
export function videoNormPointToCanvas(nx, ny, canvasWidth, canvasHeight) {
  return { x: nx * canvasWidth, y: ny * canvasHeight };
}

/**
 * Convert a canvas pixel point (E) to normalised video coords (D).
 * Used for click-to-lock ball events.
 *
 * @param {number} cx  – canvas pixel X
 * @param {number} cy  – canvas pixel Y
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {{ nx: number, ny: number }}
 */
export function canvasPointToVideoNorm(cx, cy, canvasWidth, canvasHeight) {
  return {
    nx: Math.max(0, Math.min(1, cx / canvasWidth)),
    ny: Math.max(0, Math.min(1, cy / canvasHeight))
  };
}

/**
 * Convert a normalised video coord (D) back to model-output [0..1] (C).
 * Used to generate detection hints in model space.
 *
 * @param {number} nx  – [0..1] video-normalised
 * @param {number} ny  – [0..1] video-normalised
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {{ scale, padX, padY }} letterbox
 * @param {number} [modelW=640]
 * @param {number} [modelH=640]
 * @returns {{ hx: number, hy: number }}  – [0..1] in model output space (C)
 */
export function videoNormToModelNorm(nx, ny, videoWidth, videoHeight, letterbox, modelW = 640, modelH = 640) {
  // D → A (pixel)
  const vpx = nx * videoWidth;
  const vpy = ny * videoHeight;

  // A → B (model pixel via letterbox)
  const mpx = vpx * letterbox.scale + letterbox.padX;
  const mpy = vpy * letterbox.scale + letterbox.padY;

  // B → C (model-output norm)
  return {
    hx: Math.max(0, Math.min(1, mpx / modelW)),
    hy: Math.max(0, Math.min(1, mpy / modelH))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a human-readable debug info object that the canvas renderer can
 * optionally display as an on-screen overlay. All values are read at call time.
 *
 * @param {object} params
 * @param {HTMLVideoElement} params.video
 * @param {number} params.canvasWidth
 * @param {number} params.canvasHeight
 * @param {{ scale, padX, padY, scaledW, scaledH }} params.letterbox
 * @param {object|null} params.rawModelBox    – box straight from model output (C)
 * @param {object|null} params.videoNormBox   – after coord transform (D)
 * @param {object|null} params.canvasBox      – after D→E conversion (E)
 * @returns {object}
 */
export function buildDebugInfo({ video, canvasWidth, canvasHeight, letterbox, rawModelBox, videoNormBox, canvasBox }) {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return {
    videoIntrinsicW:  video?.videoWidth  ?? 0,
    videoIntrinsicH:  video?.videoHeight ?? 0,
    videoDisplayedW:  video ? Math.round(video.getBoundingClientRect().width)  : 0,
    videoDisplayedH:  video ? Math.round(video.getBoundingClientRect().height) : 0,
    modelInputW:      letterbox?.modelW ?? 640,
    modelInputH:      letterbox?.modelH ?? 640,
    canvasW:          canvasWidth,
    canvasH:          canvasHeight,
    devicePixelRatio: dpr,
    letterboxScale:   letterbox?.scale  ?? null,
    letterboxPadX:    letterbox?.padX   ?? null,
    letterboxPadY:    letterbox?.padY   ?? null,
    rawModelBox:      rawModelBox  ? { ...rawModelBox  } : null,
    videoNormBox:     videoNormBox ? { ...videoNormBox } : null,
    canvasBox:        canvasBox    ? { ...canvasBox    } : null
  };
}

/**
 * Draw a debug information panel on the overlay canvas.
 * Call this AFTER drawing detection boxes.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} info  – output of buildDebugInfo()
 */
export function drawDebugPanel(ctx, info) {
  if (!ctx || !info) return;

  const lines = [
    `VIDEO INTRINSIC : ${info.videoIntrinsicW} × ${info.videoIntrinsicH}`,
    `VIDEO DISPLAYED : ${info.videoDisplayedW} × ${info.videoDisplayedH}`,
    `MODEL INPUT     : ${info.modelInputW} × ${info.modelInputH}`,
    `CANVAS          : ${info.canvasW} × ${info.canvasH}`,
    `DPR             : ${info.devicePixelRatio}`,
    `LB scale        : ${info.letterboxScale?.toFixed(5) ?? '—'}`,
    `LB padX / padY  : ${info.letterboxPadX ?? '—'} / ${info.letterboxPadY ?? '—'}`,
  ];

  if (info.rawModelBox) {
    const b = info.rawModelBox;
    lines.push(`RAW MODEL BOX   : x=${b.x?.toFixed(3)} y=${b.y?.toFixed(3)} w=${b.width?.toFixed(3)} h=${b.height?.toFixed(3)}`);
  }
  if (info.videoNormBox) {
    const b = info.videoNormBox;
    lines.push(`VIDEO NORM BOX  : x=${b.x?.toFixed(3)} y=${b.y?.toFixed(3)} w=${b.width?.toFixed(3)} h=${b.height?.toFixed(3)}`);
  }
  if (info.canvasBox) {
    const b = info.canvasBox;
    lines.push(`CANVAS BOX (px) : x=${b.x?.toFixed(1)} y=${b.y?.toFixed(1)} w=${b.width?.toFixed(1)} h=${b.height?.toFixed(1)}`);
  }

  const pad  = 8;
  const lineH = 14;
  const panelW = 330;
  const panelH = lines.length * lineH + pad * 2;
  const px = 10;
  const py = 56; // below the telemetry badge

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.80)';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 1;
  ctx.strokeRect(px, py, panelW, panelH);

  ctx.fillStyle = '#fbbf24';
  ctx.font = '10px monospace';
  lines.forEach((line, i) => {
    ctx.fillText(line, px + pad, py + pad + (i + 1) * lineH - 2);
  });

  // Draw three marker dots: raw model (magenta), video-norm (yellow), canvas-final (cyan)
  const markers = [
    { box: info.rawModelBox,   color: '#e879f9', label: 'RAW',   scaleX: info.canvasW, scaleY: info.canvasH },
    { box: info.videoNormBox,  color: '#facc15', label: 'VNORM', scaleX: info.canvasW, scaleY: info.canvasH },
    { box: info.canvasBox,     color: '#22d3ee', label: 'FINAL', scaleX: 1,            scaleY: 1            }
  ];

  for (const { box, color, label, scaleX, scaleY } of markers) {
    if (!box) continue;
    const mx = (box.cx !== undefined ? box.cx : box.x + box.width / 2) * scaleX;
    const my = (box.cy !== undefined ? box.cy : box.y + box.height / 2) * scaleY;
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(label, mx + 8, my + 3);

    // Draw bounding rect marker
    const bx = box.x * scaleX;
    const by = box.y * scaleY;
    const bw = box.width  * scaleX;
    const bh = box.height * scaleY;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.restore();
  }

  ctx.restore();
}
