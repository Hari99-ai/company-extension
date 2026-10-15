/**
 * Local AI Backend Client for PlayerNation Extension
 * Communicates with the local Python YOLOv8 microservice (http://127.0.0.1:8000)
 * Bypasses in-browser WASM limits and CORS restrictions.
 */

export class LocalBackendClient {
  /**
   * @param {object} [options]
   * @param {string} [options.serverUrl='http://127.0.0.1:8000']
   * @param {number} [options.timeoutMs=3000]
   */
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || 'http://127.0.0.1:8000';
    this.timeoutMs = options.timeoutMs || 3000;
    this.isOnline = false;
    this.serverInfo = null;
    this.lastCheckTime = 0;
  }

  /**
   * Ping server health endpoint to verify connectivity.
   * @returns {Promise<boolean>}
   */
  async checkHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1800);

      const resp = await fetch(`${this.serverUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });

      clearTimeout(timeoutId);

      if (resp.ok) {
        const data = await resp.json();
        this.isOnline = true;
        this.serverInfo = data;
        this.lastCheckTime = Date.now();
        return true;
      } else {
        this.isOnline = false;
        return false;
      }
    } catch (err) {
      this.isOnline = false;
      this.serverInfo = null;
      return false;
    }
  }

  /**
   * Send frame image to local server for YOLOv8 object detection.
   * @param {string} imageBase64OrDataUrl
   * @param {object} [options]
   * @param {number} [options.playerConfidence=0.25]
   * @param {number} [options.ballConfidence=0.12]
   * @returns {Promise<object>}
   */
  async detect(imageBase64OrDataUrl, options = {}) {
    if (!imageBase64OrDataUrl) {
      throw new Error('Image data missing for local detection.');
    }

    const t0 = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(`${this.serverUrl}/detect`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          image: imageBase64OrDataUrl,
          player_conf: options.playerConfidence !== undefined ? options.playerConfidence : 0.25,
          ball_conf: options.ballConfidence !== undefined ? options.ballConfidence : 0.12,
          iou_threshold: options.iouThreshold || 0.45,
          hint_x: options.hint_x,
          hint_y: options.hint_y
        })
      });

      clearTimeout(timeoutId);

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Server returned HTTP ${resp.status}: ${errText}`);
      }

      const result = await resp.json();
      result.roundTripMs = Math.round(performance.now() - t0);
      return result;
    } catch (err) {
      clearTimeout(timeoutId);
      // Mark offline if network failure
      if (err.name === 'AbortError' || err.message.includes('Failed to fetch')) {
        this.isOnline = false;
      }
      throw err;
    }
  }

  async setTrainingConfig(minimumSamples) {
    if (!Number.isInteger(minimumSamples) || minimumSamples < 10 || minimumSamples > 10000) {
      throw new Error('Minimum training samples must be between 10 and 10000.');
    }

    return this.sendTrainingRequest('/training-config', { minimum_samples: minimumSamples });
  }

  async uploadTrainingSample(sample, minimumSamples) {
    if (!sample?.image || !sample.annotations?.[0]?.bbox) {
      throw new Error('Football training sample is missing its image or annotation.');
    }

    return this.sendTrainingRequest('/training-samples', {
      id: sample.id,
      image: sample.image,
      annotation: sample.annotations[0],
      minimum_samples: minimumSamples
    });
  }

  async sendTrainingRequest(endpoint, body) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const response = await chrome.runtime.sendMessage({
        type: 'LOCAL_TRAINING_REQUEST',
        payload: { endpoint, body }
      });
      if (!response?.success) {
        throw new Error(response?.error || 'Local training request failed.');
      }
      return response.data;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${this.serverUrl}${endpoint}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `Training request failed with HTTP ${response.status}.`);
      }
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
