/**
 * Preprocessing Utility for YOLO Models
 * Converts browser ImageData into normalized NCHW Float32Array tensors
 * suitable for ONNX Runtime Web.
 */

/**
 * Preprocess RGBA ImageData (640x640) into normalized Float32Array [1, 3, 640, 640] in NCHW layout.
 * @param {ImageData} imageData - 640x640 RGBA pixel buffer.
 * @returns {Float32Array} NCHW normalized float tensor buffer.
 */
export function preprocessImageData(imageData) {
  const { data, width, height } = imageData;
  const numPixels = width * height;
  const float32Data = new Float32Array(3 * numPixels);

  const channelR = 0;
  const channelG = numPixels;
  const channelB = 2 * numPixels;

  for (let i = 0; i < numPixels; i++) {
    const srcIdx = i * 4;
    // Normalize 0-255 to 0.0-1.0
    float32Data[channelR + i] = data[srcIdx] / 255.0;
    float32Data[channelG + i] = data[srcIdx + 1] / 255.0;
    float32Data[channelB + i] = data[srcIdx + 2] / 255.0;
  }

  return float32Data;
}

/**
 * Scale normalized model coordinates back to original video pixel space.
 * @param {object} box - { x, y, width, height } in 0..1 model space
 * @param {object} letterbox - { scale, padX, padY, scaledW, scaledH }
 * @param {number} originalVideoWidth
 * @param {number} originalVideoHeight
 * @returns {object} Coordinates mapped to original video pixels.
 */
export function unletterboxCoords(box, letterbox, originalVideoWidth, originalVideoHeight) {
  const modelW = 640;
  const modelH = 640;

  // Box in 640x640 pixel coordinates
  const bx = box.x * modelW;
  const by = box.y * modelH;
  const bw = box.width * modelW;
  const bh = box.height * modelH;

  // Subtract padding and divide by scale
  const origX = Math.max(0, (bx - letterbox.padX) / letterbox.scale);
  const origY = Math.max(0, (by - letterbox.padY) / letterbox.scale);
  const origW = Math.min(originalVideoWidth - origX, bw / letterbox.scale);
  const origH = Math.min(originalVideoHeight - origY, bh / letterbox.scale);

  return {
    x: origX,
    y: origY,
    width: origW,
    height: origH,
    // Also provide normalized 0..1 coordinates relative to original video
    normalizedX: origX / originalVideoWidth,
    normalizedY: origY / originalVideoHeight,
    normalizedWidth: origW / originalVideoWidth,
    normalizedHeight: origH / originalVideoHeight
  };
}
