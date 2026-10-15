/**
 * Football YOLO Detector using ONNX Runtime Web
 * Supports WebGPU acceleration with WASM fallback.
 */

import { preprocessImageData } from './preprocessing.js';
import { parseYoloOutput } from './postprocessing.js';

export class FootballYoloDetector {
  /**
   * @param {object} [options]
   * @param {string} [options.modelPath] - Relative URL or path to ONNX model
   * @param {number} [options.playerConfidence=0.30]
   * @param {number} [options.ballConfidence=0.15]
   * @param {number} [options.iouThreshold=0.45]
   */
  constructor(options = {}) {
    this.modelPath = options.modelPath || 'models/yolov8n.onnx';
    this.playerConfidence = options.playerConfidence || 0.25;
    this.ballConfidence = options.ballConfidence || 0.08;
    this.iouThreshold = options.iouThreshold || 0.45;

    this.session = null;
    this.isLoaded = false;
    this.backendUsed = 'none';
    this.inputName = null;
    this.outputName = null;
  }

  /**
   * Load the ONNX model session using ONNX Runtime Web (ort).
   * @param {object} [ortInstance] - Optional global 'ort' instance
   * @returns {Promise<boolean>}
   */
  async load(ortInstance) {
    const ort = ortInstance || (typeof window !== 'undefined' ? window.ort : null);
    if (!ort) {
      throw new Error('ONNX Runtime Web (ort) library is not loaded. Include ort.min.js in extension.');
    }

    const fullModelUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL(this.modelPath)
      : this.modelPath;

    console.log(`[Detector] Loading model from: ${fullModelUrl}`);

    try {
      // Attempt WebGPU first for hardware acceleration, falling back to WASM
      const sessionOptions = {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all'
      };

      this.session = await ort.InferenceSession.create(fullModelUrl, sessionOptions);
      this.isLoaded = true;
      this.backendUsed = 'webgpu/wasm';

      // Inspect input/output tensor names
      this.inputName = this.session.inputNames[0] || 'images';
      this.outputName = this.session.outputNames[0] || 'output0';

      console.log(`[Detector] Model loaded successfully. Input: ${this.inputName}, Output: ${this.outputName}`);
      return true;
    } catch (gpuErr) {
      console.warn('[Detector] WebGPU initialization failed, falling back strictly to WASM CPU:', gpuErr);

      try {
        const wasmOptions = {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        };
        this.session = await ort.InferenceSession.create(fullModelUrl, wasmOptions);
        this.isLoaded = true;
        this.backendUsed = 'wasm';
        this.inputName = this.session.inputNames[0] || 'images';
        this.outputName = this.session.outputNames[0] || 'output0';
        return true;
      } catch (wasmErr) {
        this.isLoaded = false;
        throw new Error(`Failed to load ONNX model: ${wasmErr.message}`);
      }
    }
  }

  /**
   * Execute object detection on 640x640 frame ImageData.
   * @param {ImageData} imageData - 640x640 letterboxed frame
   * @param {object} [ortInstance] - Optional global 'ort'
   * @returns {Promise<object>} { ball, players, latencyMs, detectionsCount }
   */
  async detect(imageData, ortInstance, options = {}) {
    if (!this.isLoaded || !this.session) {
      throw new Error('Detector model has not been loaded. Call detector.load() first.');
    }

    const ort = ortInstance || (typeof window !== 'undefined' ? window.ort : null);
    if (!ort) throw new Error('ONNX Runtime Web instance missing.');

    const t0 = performance.now();

    // 1. Preprocess
    const tensorData = preprocessImageData(imageData);
    const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, 640, 640]);

    // 2. Inference
    const feeds = {};
    feeds[this.inputName] = inputTensor;
    const results = await this.session.run(feeds);

    const outputTensor = results[this.outputName];
    if (!outputTensor) {
      throw new Error(`Expected output tensor '${this.outputName}' not found in model output.`);
    }

    // 3. Postprocess
    const rawDims = outputTensor.dims; // e.g. [1, 84, 8400]
    const numChannels = rawDims[1];
    const numProposals = rawDims[2];

    const parsed = parseYoloOutput(outputTensor.data, numChannels, numProposals, {
      playerConfThreshold: this.playerConfidence,
      ballConfThreshold: this.ballConfidence,
      iouThreshold: this.iouThreshold,
      isCoco: numChannels === 84,
      hintX: options.hintX,
      hintY: options.hintY
    });

    const latencyMs = performance.now() - t0;

    return {
      ball: parsed.ball,
      allBalls: parsed.allBalls || [],
      players: parsed.players,
      allDetections: parsed.allDetections,
      latencyMs,
      backend: this.backendUsed
    };
  }
}
