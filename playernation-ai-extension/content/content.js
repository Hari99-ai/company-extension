/**
 * Content Script for PlayerNation AI Event Logger
 * Connects Video Capture, YOLO Detection, Multi-Object Tracking,
 * Football Event Analysis, and the PlayerNation Interface Bridge.
 */

(async function () {
  console.log('[PlayerNation AI Logger] Initializing vision pipeline on', window.location.href);

  // Dynamic ES Module Imports
  let VideoCaptureManager, formatMatchTime, isDuplicateEvent;
  let getFootballTrainingReminderMinute, createFootballTrainingAnnotation;
  let FootballYoloDetector, PlayerTracker, BallTracker;
  let FootballEventAnalyzer, PlayerNationAdapter, MatchEventStore;
  let getRecentEventsAroundTime;
  let LocalBackendClient;
  let FootballMemoryManager, TrackingState;
  // Coordinate-transform helpers (imported below)
  let modelBoxToVideoNorm, videoNormToModelNorm, computeLetterbox,
      videoNormToCanvas, videoNormPointToCanvas, buildDebugInfo, drawDebugPanel;

  try {
    const vcMod      = await import(chrome.runtime.getURL('utils/video-capture.js'));
    const tsMod      = await import(chrome.runtime.getURL('utils/timestamps.js'));
    const detMod     = await import(chrome.runtime.getURL('detector/detector.js'));
    const trkMod     = await import(chrome.runtime.getURL('tracking/tracker.js'));
    const ballMod    = await import(chrome.runtime.getURL('tracking/ball-tracker.js'));
    const memMod     = await import(chrome.runtime.getURL('tracking/memory-manager.js'));
    const evtMod     = await import(chrome.runtime.getURL('events/event-analyzer.js'));
    const adpMod     = await import(chrome.runtime.getURL('integration/playernation-adapter.js'));
    const storeMod   = await import(chrome.runtime.getURL('logs/event-store.js'));
    const recentEventsMod = await import(chrome.runtime.getURL('logs/recent-events.js'));
    const bkdMod     = await import(chrome.runtime.getURL('detector/backend-client.js'));
    const trainingMod= await import(chrome.runtime.getURL('utils/football-training.js'));
    const coordMod   = await import(chrome.runtime.getURL('utils/coord-transform.js'));

    VideoCaptureManager = vcMod.VideoCaptureManager;
    formatMatchTime = tsMod.formatMatchTime;
    isDuplicateEvent = tsMod.isDuplicateEvent;
    FootballYoloDetector = detMod.FootballYoloDetector;
    PlayerTracker = trkMod.PlayerTracker;
    BallTracker = ballMod.BallTracker;
    FootballMemoryManager = memMod.FootballMemoryManager;
    TrackingState = memMod.TrackingState;
    FootballEventAnalyzer = evtMod.FootballEventAnalyzer;
    PlayerNationAdapter = adpMod.PlayerNationAdapter;
    MatchEventStore = storeMod.MatchEventStore;
    getRecentEventsAroundTime = recentEventsMod.getRecentEventsAroundTime;
    LocalBackendClient = bkdMod.LocalBackendClient;
    getFootballTrainingReminderMinute = trainingMod.getFootballTrainingReminderMinute;
    createFootballTrainingAnnotation  = trainingMod.createFootballTrainingAnnotation;
    // Coordinate-transform functions
    modelBoxToVideoNorm    = coordMod.modelBoxToVideoNorm;
    videoNormToModelNorm   = coordMod.videoNormToModelNorm;
    computeLetterbox       = coordMod.computeLetterbox;
    videoNormToCanvas      = coordMod.videoNormToCanvas;
    videoNormPointToCanvas = coordMod.videoNormPointToCanvas;
    buildDebugInfo         = coordMod.buildDebugInfo;
    drawDebugPanel         = coordMod.drawDebugPanel;
  } catch (err) {
    console.error('[PlayerNation AI Logger] Module import failed:', err);
  }

  // State Management
  const state = {
    isRunning: false,
    isPaused: false,
    isModelLoaded: false,

    captureManager: null,
    detector: null,
    backendClient: null,
    playerTracker: null,
    ballTracker: null,
    memoryManager: null,
    eventAnalyzer: null,
    pnAdapter: null,
    eventStore: null,

    overlayCanvas: null,
    overlayCtx: null,
    floatingHud: null,
    hudVisible: true,

    teamAColor: '#ffffff',
    teamBColor: '#dc2626',
    autoLogging: false,

    overlaySettings: {
      showPlayers: true,
      showBall: true,
      showPlayerLabels: true,
      showBallTrail: true,
      showTelemetryBadge: true,
      playerConfidence: 0.25,
      ballConfidence: 0.08,
      debugCoords: false        // toggle with chrome.storage / popup
    },
    lastFramePackage: null,
    lastTrainingImageData: null,
    lastTrainingReminderMinute: 0,
    minimumTrainingSamples: 20,
    trainingSyncInProgress: false,
    trainingStorageQueue: Promise.resolve(),
    isPinpointBallMode: false,
    lastMousePos: null,
    pinpointRipple: null,

    telemetry: {
      status: 'idle',
      isLive: false,
      siteDomain: window.location.hostname || 'Local Webpage',
      isCorsProtected: false,
      videoFound: false,
      videoPaused: false,
      videoWidth: 0,
      videoHeight: 0,
      currentTime: 0,
      playbackRate: 1,
      fps: 0,
      latencyMs: 0,
      modelName: 'YOLOv8n ONNX',
      inferenceBackend: 'WASM / WebGPU',
      ballDetected: false,
      ballConfidence: 0,
      ballLostFrames: 0,
      manualBallLock: false,
      trainingSamplesCount: 0,
      trainingStatus: 'waiting for local backend',
      isPinpointBallMode: false,
      playersCount: 0,
      trackedObjectsCount: 0,
      pendingSuggestions: [],
      latestLogs: [],
      // ── Memory telemetry ─────────────────────────────────────────────────
      memoryTrackingState: 'LOST',
      memorySearchMode: 'LOCAL',
      memoryCameraStatus: 'UNKNOWN',
      memoryAgeSec: null,
      memoryTotalSamples: 0,
      memoryPredictedCx: null,
      memoryPredictedCy: null,
      memoryPredictionConfidence: 0,
      memoryMissedFrames: 0,
      memoryReacquisitionAttempts: 0,
      memorySearchRadius: 0.06
    },

    fpsCounter: {
      frames: 0,
      lastTime: performance.now(),
      fps: 0
    },

    currentDetections: {
      ball: null,
      allBalls: [],
      players: [],
      ballTrail: []
    }
  };

  chrome.storage.local.get('footballTrainingSamples', data => {
    if (chrome.runtime.lastError) {
      console.error(
        '[PlayerNation AI Logger] Could not read football training sample count:',
        chrome.runtime.lastError.message
      );
      return;
    }
    state.telemetry.trainingSamplesCount = Array.isArray(data.footballTrainingSamples)
      ? data.footballTrainingSamples.length
      : 0;
  });

  // Initialize Event Store and Adapter
  let eventStoreReady = Promise.resolve();
  if (MatchEventStore) {
    state.eventStore = new MatchEventStore();
    eventStoreReady = state.eventStore.init().then(logs => {
      state.telemetry.latestLogs = logs;
      return logs;
    });
  }

  if (PlayerNationAdapter) {
    state.pnAdapter = new PlayerNationAdapter({ autoLoggingEnabled: false });
  }

  // Load Settings
  chrome.storage.local.get('settings', (data) => {
    if (data.settings) {
      state.teamAColor = data.settings.teamAColor || state.teamAColor;
      state.teamBColor = data.settings.teamBColor || state.teamBColor;
      state.autoLogging = !!data.settings.autoLoggingEnabled;
      if (state.pnAdapter) state.pnAdapter.setAutoLogging(state.autoLogging);

      if (data.settings.showPlayers !== undefined) state.overlaySettings.showPlayers = !!data.settings.showPlayers;
      if (data.settings.showBall !== undefined) state.overlaySettings.showBall = !!data.settings.showBall;
      if (data.settings.showPlayerLabels !== undefined) state.overlaySettings.showPlayerLabels = !!data.settings.showPlayerLabels;
      if (data.settings.showBallTrail !== undefined) state.overlaySettings.showBallTrail = !!data.settings.showBallTrail;
      if (data.settings.showTelemetryBadge !== undefined) state.overlaySettings.showTelemetryBadge = !!data.settings.showTelemetryBadge;
      if (data.settings.playerConfidence !== undefined) state.overlaySettings.playerConfidence = data.settings.playerConfidence;
      if (data.settings.ballConfidence !== undefined) state.overlaySettings.ballConfidence = data.settings.ballConfidence;
      if (Number.isInteger(data.settings.minimumTrainingSamples)) {
        state.minimumTrainingSamples = Math.max(10, Math.min(10000, data.settings.minimumTrainingSamples));
      }
    }
  });

  // Message Handler from Background / Popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const { type, payload } = request;

    switch (type) {
      case 'CMD_START':
        startDetectionPipeline(payload)
          .then(res => sendResponse(res))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true;

      case 'CMD_STOP':
        stopDetectionPipeline();
        sendResponse({ success: true });
        break;

      case 'CMD_PAUSE':
        pauseDetectionPipeline();
        sendResponse({ success: true });
        break;

      case 'CMD_RESUME':
        resumeDetectionPipeline();
        sendResponse({ success: true });
        break;

      case 'CMD_GET_STATUS':
        syncTelemetry();
        sendResponse({
          success: true,
          telemetry: state.telemetry,
          overlaySettings: state.overlaySettings,
          isPinpointBallMode: state.isPinpointBallMode,
          manualBallLock: !!state.ballTracker?.manualLock
        });
        break;

      case 'CMD_ENABLE_PINPOINT_BALL':
        enablePinpointBallMode();
        sendResponse({ success: true, isPinpoint: state.isPinpointBallMode });
        break;

      case 'CMD_CLEAR_BALL_LOCK':
        if (state.ballTracker) {
          state.ballTracker.clearManualLock();
        }
        state.telemetry.manualBallLock = false;
        showToastNotification('Manual ball lock released');
        updateFloatingHud(true);
        if (state.lastFramePackage) renderVideoOverlay(state.lastFramePackage);
        sendResponse({ success: true });
        break;

      case 'CMD_TOGGLE_HUD':
        toggleHud();
        sendResponse({ success: true, visible: state.hudVisible });
        break;

      case 'CMD_UPDATE_OVERLAY_SETTINGS':
        if (payload) {
          Object.assign(state.overlaySettings, payload);
          if (state.detector) {
            if (payload.playerConfidence !== undefined) state.detector.playerConfidence = payload.playerConfidence;
            if (payload.ballConfidence !== undefined) state.detector.ballConfidence = payload.ballConfidence;
          }
          if (state.lastFramePackage) {
            renderVideoOverlay(state.lastFramePackage);
          }
          updateFloatingHud(true);
        }
        sendResponse({ success: true, settings: state.overlaySettings });
        break;

      case 'CMD_UPDATE_TEAM_COLORS':
        if (payload) {
          state.teamAColor = payload.teamAColor || state.teamAColor;
          state.teamBColor = payload.teamBColor || state.teamBColor;
        }
        sendResponse({ success: true });
        break;

      case 'CMD_SET_AUTO_LOGGING':
        if (payload) {
          state.autoLogging = !!payload.enabled;
          if (state.pnAdapter) state.pnAdapter.setAutoLogging(state.autoLogging);
        }
        sendResponse({ success: true });
        break;

      case 'CMD_SET_TRAINING_MINIMUM':
        if (Number.isInteger(payload?.minimumSamples)
          && payload.minimumSamples >= 10
          && payload.minimumSamples <= 10000) {
          state.minimumTrainingSamples = payload.minimumSamples;
          state.backendClient?.setTrainingConfig(state.minimumTrainingSamples).catch(err => {
            console.warn('[PlayerNation AI Logger] Could not update backend training threshold:', err.message);
          });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Minimum training samples must be between 10 and 10000.' });
        }
        break;

      case 'CMD_CONFIRM_SUGGESTION':
        if (payload?.id) {
          confirmSuggestion(payload.id);
          sendResponse({ success: true });
        }
        break;

      case 'CMD_REJECT_SUGGESTION':
        if (payload?.id) {
          rejectSuggestion(payload.id);
          sendResponse({ success: true });
        }
        break;

      case 'CMD_UPDATE_EVENT':
        if (payload?.id && state.eventStore) {
          state.eventStore.updateEvent(payload.id, payload);
          state.telemetry.latestLogs = state.eventStore.getAll();
          sendResponse({ success: true });
        }
        break;

      case 'CMD_ADD_BULK_EVENTS':
        if (!Array.isArray(payload?.events) || !state.eventStore) {
          sendResponse({ success: false, error: 'Bulk events are missing or the event store is unavailable.' });
          break;
        }
        eventStoreReady.then(() => {
          const { added, duplicates } = state.eventStore.addEvents(payload.events);
          state.telemetry.latestLogs = state.eventStore.getAll();
          updateFloatingHud(true);
          sendResponse({ success: true, added: added.length, duplicates });
        }).catch(err => {
          sendResponse({ success: false, error: `Could not add bulk events: ${err.message}` });
        });
        return true;

      case 'CMD_CLEAR_LOGS':
        if (state.eventStore) state.eventStore.clear();
        state.telemetry.latestLogs = [];
        sendResponse({ success: true });
        break;

      case 'CMD_EXPORT_MEMORY_DIAGNOSTIC':
        if (state.memoryManager) {
          const diag = state.memoryManager.exportDiagnostic();
          sendResponse({ success: true, diagnostic: diag });
        } else {
          sendResponse({ success: false, error: 'Memory manager not active.' });
        }
        break;

      case 'CMD_RESET_MEMORY':
        if (state.memoryManager) {
          state.memoryManager.reset();
          if (state.ballTracker) state.ballTracker.memoryState = null;
          showToastNotification('🧠 Tracking memory reset');
        }
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: `Unknown command ${type}` });
    }
  });

  async function startDetectionPipeline(options = {}) {
    if (state.isRunning) return { success: true };

    const video = VideoCaptureManager.findVideoElement();
    if (!video) {
      throw new Error('No active video found on this page. If the video is loading, click Play and try again.');
    }

    state.telemetry.isLive = VideoCaptureManager.isLiveStream(video);
    state.telemetry.siteDomain = window.location.hostname || 'Local Webpage';
    state.telemetry.videoFound = true;

    if (options.teamAColor) state.teamAColor = options.teamAColor;
    if (options.teamBColor) state.teamBColor = options.teamBColor;
    if (options.autoLogging !== undefined) {
      state.autoLogging = !!options.autoLogging;
      if (state.pnAdapter) state.pnAdapter.setAutoLogging(state.autoLogging);
    }
    if (Number.isInteger(options.minimumTrainingSamples)
      && options.minimumTrainingSamples >= 10
      && options.minimumTrainingSamples <= 10000) {
      state.minimumTrainingSamples = options.minimumTrainingSamples;
    }
    if (options.overlaySettings) {
      Object.assign(state.overlaySettings, options.overlaySettings);
    }

    // 1. Initialize Backend Client & In-Browser Fallback YOLO Detector
    if (!state.backendClient && LocalBackendClient) {
      state.backendClient = new LocalBackendClient({ serverUrl: 'http://127.0.0.1:8000' });
      try {
        const isOnline = await state.backendClient.checkHealth();
        if (isOnline) {
          state.telemetry.inferenceBackend = `🟢 Local PyTorch (${state.backendClient.serverInfo?.device?.toUpperCase() || 'CPU'})`;
          state.telemetry.modelName = state.backendClient.serverInfo?.model || 'yolov8n.pt';
          state.telemetry.trainingStatus = trainingStatusLabel(state.backendClient.serverInfo?.training);
          console.log('[PlayerNation AI Logger] Connected to Local Python AI Backend at http://127.0.0.1:8000');
          state.backendClient.setTrainingConfig(state.minimumTrainingSamples)
            .catch(err => console.warn('[PlayerNation AI Logger] Could not configure backend training:', err.message));
          syncPendingTrainingSamples();
        }
      } catch (e) {
        console.log('[PlayerNation AI Logger] Local backend not detected, using browser runtime.');
      }
    }

    if (!state.detector) {
      state.detector = new FootballYoloDetector({
        modelPath: 'models/yolov8n.onnx',
        playerConfidence: state.overlaySettings.playerConfidence || 0.25,
        ballConfidence: state.overlaySettings.ballConfidence || 0.12,
        iouThreshold: 0.45
      });
      try {
        await state.detector.load();
        state.isModelLoaded = true;
        if (!state.backendClient?.isOnline) {
          state.telemetry.inferenceBackend = state.detector.backendUsed;
        }
      } catch (loadErr) {
        console.warn('[PlayerNation AI Logger] Could not load ONNX model directly:', loadErr.message);
        state.isModelLoaded = false;
        if (!state.backendClient?.isOnline) {
          state.telemetry.inferenceBackend = 'Standby (Start Python server or models/yolov8n.onnx)';
        }
      }
    }

    // 2. Initialize Trackers, Memory Manager, and Analyzer
    state.playerTracker = new PlayerTracker({ maxLostFrames: 12, iouThreshold: 0.3 });
    state.memoryManager = FootballMemoryManager
      ? new FootballMemoryManager({ memoryWindowSec: 120, enableCameraMotion: true })
      : null;
    state.ballTracker = new BallTracker({
      maxTrailLength: 20,
      maxLostFrames: 8,
      memoryManager: state.memoryManager
    });
    state.eventAnalyzer = new FootballEventAnalyzer({
      onEventCandidate: handleNewEventCandidate,
      dedupWindow: 2.5
    });
    if (state.eventStore) {
      state.eventAnalyzer.setConfirmedLogs(state.eventStore.getAll());
    }

    // 3. Attach Overlay Canvas & Floating HUD
    attachVideoOverlay(video);
    createFloatingHud();

    // 4. Start Video Capture
    state.captureManager = new VideoCaptureManager({
      targetFps: 8,
      targetWidth: 640,
      targetHeight: 640,
      onFrame: processVideoFrame,
      onStatusChange: handleCaptureStatus,
      onError: handleCaptureError
    });

    const attached = state.captureManager.attach(video);
    if (!attached) {
      throw new Error('Failed to attach capture to video element.');
    }

    state.captureManager.start();
    state.isRunning = true;
    state.isPaused = false;
    state.telemetry.status = 'capturing';

    // Hook click on any video element on page to switch tracking (useful for match compare side-by-side)
    const allVideos = VideoCaptureManager.findAllVideoElements();
    allVideos.forEach(v => {
      v.addEventListener('click', () => {
        if (state.isRunning && v !== state.captureManager?.videoElement) {
          switchTrackingVideo(v);
        }
      });
    });

    return { success: true };
  }

  function switchTrackingVideo(targetVideo) {
    if (!targetVideo || targetVideo === state.captureManager?.videoElement) return;

    console.log('[PlayerNation AI Logger] Switching tracking to video:', targetVideo);
    if (state.captureManager) {
      state.captureManager.stop();
      clearVideoOverlay();
      attachVideoOverlay(targetVideo);
      state.captureManager.attach(targetVideo);
      state.captureManager.start();
      state.telemetry.isLive = VideoCaptureManager.isLiveStream(targetVideo);
      showToastNotification('Switched AI Vision to Selected Match Video');
      updateFloatingHud();
    }
  }

  function stopDetectionPipeline() {
    if (state.captureManager) {
      state.captureManager.stop();
      state.captureManager = null;
    }
    state.isRunning = false;
    state.isPaused = false;
    state.telemetry.status = 'stopped';
    clearVideoOverlay();
  }

  function pauseDetectionPipeline() {
    if (state.captureManager) state.captureManager.pause();
    state.isPaused = true;
    state.telemetry.status = 'paused';
  }

  function resumeDetectionPipeline() {
    if (state.captureManager) state.captureManager.resume();
    state.isPaused = false;
    state.telemetry.status = 'capturing';
  }

  // Frame helpers for Tab Capture and Local Backend conversion
  let _sharedHelperCanvas = null;
  let _sharedHelperCtx = null;
  function imageDataToDataUrl(imageData, quality = 0.80) {
    if (!imageData || !imageData.data || imageData.width <= 1) return null;
    if (!_sharedHelperCanvas) {
      _sharedHelperCanvas = document.createElement('canvas');
      _sharedHelperCtx = _sharedHelperCanvas.getContext('2d');
    }
    if (_sharedHelperCanvas.width !== imageData.width || _sharedHelperCanvas.height !== imageData.height) {
      _sharedHelperCanvas.width = imageData.width;
      _sharedHelperCanvas.height = imageData.height;
    }
    _sharedHelperCtx.putImageData(imageData, 0, 0);
    return _sharedHelperCanvas.toDataURL('image/jpeg', quality);
  }

  let _tabCaptureImg = null;
  let _cropCanvas = null;
  let _cropCtx = null;
  let _lastCaptureTime = 0;
  let _cachedCapturedResult = null;

  async function captureTabCroppedFrame(video) {
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const now = performance.now();
    // Throttle tab capture to max 12 FPS (~80ms)
    if (_cachedCapturedResult && (now - _lastCaptureTime < 80)) {
      return _cachedCapturedResult;
    }

    let resp = null;
    try {
      resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_TAB_FRAME' }, (res) => {
          if (chrome.runtime?.lastError) {
            resolve(null);
          } else {
            resolve(res);
          }
        });
      });
    } catch (e) {
      return null;
    }

    if (!resp || !resp.success || !resp.dataUrl) return null;

    if (!_tabCaptureImg) {
      _tabCaptureImg = new Image();
    }

    await new Promise((resolve, reject) => {
      _tabCaptureImg.onload = () => resolve();
      _tabCaptureImg.onerror = () => reject(new Error('Tab capture decode failed'));
      _tabCaptureImg.src = resp.dataUrl;
    });

    if (!_cropCanvas) {
      _cropCanvas = document.createElement('canvas');
      _cropCanvas.width = 640;
      _cropCanvas.height = 640;
      _cropCtx = _cropCanvas.getContext('2d', { willReadFrequently: true });
    }

    const dpr = window.devicePixelRatio || 1;
    const sx = Math.max(0, Math.round(rect.left * dpr));
    const sy = Math.max(0, Math.round(rect.top * dpr));
    const sw = Math.min(_tabCaptureImg.width - sx, Math.round(rect.width * dpr));
    const sh = Math.min(_tabCaptureImg.height - sy, Math.round(rect.height * dpr));

    if (sw <= 0 || sh <= 0) return null;

    _cropCtx.fillStyle = '#000000';
    _cropCtx.fillRect(0, 0, 640, 640);

    const scale = Math.min(640 / sw, 640 / sh);
    const scaledW = Math.round(sw * scale);
    const scaledH = Math.round(sh * scale);
    const padX = Math.round((640 - scaledW) / 2);
    const padY = Math.round((640 - scaledH) / 2);

    _cropCtx.drawImage(_tabCaptureImg, sx, sy, sw, sh, padX, padY, scaledW, scaledH);

    const dataUrl = _cropCanvas.toDataURL('image/jpeg', 0.80);
    const imageData = _cropCtx.getImageData(0, 0, 640, 640);

    _lastCaptureTime = now;
    _cachedCapturedResult = {
      dataUrl,
      imageData,
      letterbox: { scale, padX, padY, scaledW, scaledH }
    };
    return _cachedCapturedResult;
  }

  /**
   * Maps bounding boxes from model-output normalised space (C) back to
   * normalised video space (D) using the true inverse-letterbox formula.
   *
   * IMPORTANT: The old implementation divided by scaledW / scaledH which gave
   * the wrong result for any video whose aspect ratio differs from 1:1 because
   * it treated the scaled content region (e.g. 640×360) as if it were the full
   * 640×640 model input. The correct operation is to:
   *   1. Convert from model-norm to model-pixel  (×640)
   *   2. Subtract the letterbox padding          (−padX, −padY)
   *   3. Divide by the letterbox scale factor    (÷scale)
   *   4. Normalise by intrinsic video dimensions (÷videoWidth, ÷videoHeight)
   *
   * videoWidth / videoHeight are read from the active video element at call
   * time so the transform is always correct even if the video switches
   * resolution mid-session.
   *
   * @param {object} box       – model-output normalised box { x, y, width, height }
   * @param {object} letterbox – from VideoCaptureManager: { scale, padX, padY, scaledW, scaledH }
   * @returns {object}         – normalised video coords (D) { x, y, width, height, cx, cy }
   */
  function unletterboxBox(box, letterbox) {
    if (!box || !letterbox || !letterbox.scale) return box;

    const video = state.captureManager?.videoElement;
    const videoWidth  = video?.videoWidth  || letterbox.scaledW / letterbox.scale || 1920;
    const videoHeight = video?.videoHeight || letterbox.scaledH / letterbox.scale || 1080;

    // Use the canonical coord-transform function if it has been loaded.
    if (typeof modelBoxToVideoNorm === 'function') {
      return modelBoxToVideoNorm(box, letterbox, videoWidth, videoHeight);
    }

    // Fallback (in case the module hasn't loaded yet): correct formula inline.
    const mpX1 = box.x * 640;
    const mpY1 = box.y * 640;
    const mpX2 = (box.x + box.width)  * 640;
    const mpY2 = (box.y + box.height) * 640;

    const vpX1 = (mpX1 - letterbox.padX) / letterbox.scale;
    const vpY1 = (mpY1 - letterbox.padY) / letterbox.scale;
    const vpX2 = (mpX2 - letterbox.padX) / letterbox.scale;
    const vpY2 = (mpY2 - letterbox.padY) / letterbox.scale;

    const cX1 = Math.max(0, vpX1);
    const cY1 = Math.max(0, vpY1);
    const cX2 = Math.min(videoWidth,  vpX2);
    const cY2 = Math.min(videoHeight, vpY2);

    const nx = cX1 / videoWidth;
    const ny = cY1 / videoHeight;
    const nw = Math.max(0.001, (cX2 - cX1) / videoWidth);
    const nh = Math.max(0.001, (cY2 - cY1) / videoHeight);

    return { ...box, x: nx, y: ny, width: nw, height: nh, cx: nx + nw / 2, cy: ny + nh / 2 };
  }

  /**
   * Main Frame Processing Loop
   */
  async function processVideoFrame(framePackage) {
    const tStart = performance.now();

    // Measure FPS
    state.fpsCounter.frames++;
    const now = performance.now();
    const elapsedSec = (now - state.fpsCounter.lastTime) / 1000;
    if (elapsedSec >= 1.0) {
      state.fpsCounter.fps = state.fpsCounter.frames / elapsedSec;
      state.fpsCounter.frames = 0;
      state.fpsCounter.lastTime = now;
    }

    const matchTime = framePackage.videoTimestamp;

    // Periodically re-check Local AI Backend (every 4 seconds)
    if (state.backendClient && (now - (state.backendClient.lastCheckTime || 0) > 4000)) {
      state.backendClient.checkHealth().then(online => {
        if (online) {
          state.telemetry.inferenceBackend = `🟢 Local PyTorch (${state.backendClient.serverInfo?.device?.toUpperCase() || 'CPU'})`;
          state.telemetry.modelName = state.backendClient.serverInfo?.model || 'yolov8n.pt';
          state.telemetry.trainingStatus = trainingStatusLabel(state.backendClient.serverInfo?.training);
          syncPendingTrainingSamples();
        } else if (state.isModelLoaded && state.detector) {
          state.telemetry.inferenceBackend = state.detector.backendUsed;
          state.telemetry.modelName = 'YOLOv8n ONNX';
        }
      });
    }

    let detectedBall = null;
    let detectedBalls = [];
    let detectedPlayers = [];
    let latencyMs = 0;
    let effectiveImageData = framePackage.imageData;

    // Convert last known ball position (normalised video D) → model-output norm (C) as hint.
    // Uses the correct forward letterbox transform: D → A → B → C
    let hintCanvasX = null;
    let hintCanvasY = null;
    const curLetterbox = framePackage.letterbox;
    const hintVideo = state.captureManager?.videoElement;
    if (
      state.currentDetections.ball &&
      curLetterbox && curLetterbox.scale &&
      hintVideo?.videoWidth && hintVideo?.videoHeight
    ) {
      if (typeof videoNormToModelNorm === 'function') {
        const h = videoNormToModelNorm(
          state.currentDetections.ball.cx,
          state.currentDetections.ball.cy,
          hintVideo.videoWidth,
          hintVideo.videoHeight,
          curLetterbox
        );
        hintCanvasX = h.hx;
        hintCanvasY = h.hy;
      } else {
        // Inline fallback: D → A → B → C
        const vpx = state.currentDetections.ball.cx * hintVideo.videoWidth;
        const vpy = state.currentDetections.ball.cy * hintVideo.videoHeight;
        hintCanvasX = Math.max(0, Math.min(1, (vpx * curLetterbox.scale + curLetterbox.padX) / 640));
        hintCanvasY = Math.max(0, Math.min(1, (vpy * curLetterbox.scale + curLetterbox.padY) / 640));
      }
    }

    // 1. Detection Phase (Handles CORS Streams & Non-CORS Streams)
    if (framePackage.isCorsTainted) {
      state.telemetry.isCorsProtected = true;
      const targetVideo = state.captureManager?.videoElement;
      const captured = await captureTabCroppedFrame(targetVideo);

      if (captured) {
        effectiveImageData = captured.imageData;
        if (captured.letterbox) {
          framePackage.letterbox = captured.letterbox;
        }

        // Path A: Local Python Backend (High Speed, Maximum Accuracy)
        if (state.backendClient?.isOnline) {
          try {
            const bkdRes = await state.backendClient.detect(captured.dataUrl, {
              playerConfidence: state.overlaySettings.playerConfidence || 0.25,
              ballConfidence: state.overlaySettings.ballConfidence || 0.08,
              hint_x: hintCanvasX,
              hint_y: hintCanvasY
            });
            if (bkdRes.success) {
              detectedBall = bkdRes.ball;
              detectedBalls = bkdRes.allBalls || (bkdRes.ball ? [bkdRes.ball] : []);
              detectedPlayers = bkdRes.players || [];
              latencyMs = bkdRes.latencyMs || bkdRes.roundTripMs || 0;
            }
          } catch (err) {
            console.warn('[Local Backend Error]:', err.message);
          }
        }

        // Path B: In-Browser ONNX Fallback
        if ((!detectedBall || detectedPlayers.length === 0) && state.isModelLoaded && state.detector) {
          try {
            state.detector.playerConfidence = state.overlaySettings.playerConfidence || 0.25;
            state.detector.ballConfidence = state.overlaySettings.ballConfidence || 0.08;
            const detResults = await state.detector.detect(captured.imageData, null, {
              hintX: hintCanvasX,
              hintY: hintCanvasY
            });
            if (!detectedBall) {
              detectedBall = detResults.ball;
              detectedBalls = detResults.allBalls || (detResults.ball ? [detResults.ball] : []);
            }
            if (detectedPlayers.length === 0) {
              detectedPlayers = detResults.players || [];
            }
            latencyMs = latencyMs || detResults.latencyMs;
          } catch (err) {
            console.error('[In-Browser Detector Error]:', err);
          }
        }
      }
    } else {
      // Standard Direct Canvas Stream
      state.telemetry.isCorsProtected = false;

      // Path A: Local Python Backend if online
      if (state.backendClient?.isOnline) {
        try {
          const dataUrl = imageDataToDataUrl(framePackage.imageData);
          if (dataUrl) {
            const bkdRes = await state.backendClient.detect(dataUrl, {
              playerConfidence: state.overlaySettings.playerConfidence || 0.25,
              ballConfidence: state.overlaySettings.ballConfidence || 0.08,
              hint_x: hintCanvasX,
              hint_y: hintCanvasY
            });
            if (bkdRes.success) {
              detectedBall = bkdRes.ball;
              detectedBalls = bkdRes.allBalls || (bkdRes.ball ? [bkdRes.ball] : []);
              detectedPlayers = bkdRes.players || [];
              latencyMs = bkdRes.latencyMs || bkdRes.roundTripMs || 0;
            }
          }
        } catch (err) {
          console.warn('[Local Backend Error]:', err.message);
        }
      }

      // Path B: In-Browser ONNX Fallback
      if ((!detectedBall || detectedPlayers.length === 0) && state.isModelLoaded && state.detector) {
        try {
          state.detector.playerConfidence = state.overlaySettings.playerConfidence || 0.25;
          state.detector.ballConfidence = state.overlaySettings.ballConfidence || 0.08;
          const detResults = await state.detector.detect(framePackage.imageData, null, {
            hintX: hintCanvasX,
            hintY: hintCanvasY
          });
          if (!detectedBall) {
            detectedBall = detResults.ball;
            detectedBalls = detResults.allBalls || (detResults.ball ? [detResults.ball] : []);
          }
          if (detectedPlayers.length === 0) {
            detectedPlayers = detResults.players || [];
          }
          latencyMs = latencyMs || detResults.latencyMs;
        } catch (err) {
          console.error('[In-Browser Detector Error]:', err);
        }
      }
    }

    // Unletterbox all detections from 640x640 model canvas space back to true normalized video coordinates [0..1]
    const activeLb = framePackage.letterbox;
    if (activeLb && activeLb.scaledW && activeLb.scaledH) {
      if (detectedBall) {
        detectedBall = unletterboxBox(detectedBall, activeLb);
      }
      if (detectedBalls && detectedBalls.length > 0) {
        detectedBalls = detectedBalls.map(b => unletterboxBox(b, activeLb));
      }
      if (detectedPlayers && detectedPlayers.length > 0) {
        detectedPlayers = detectedPlayers.map(p => unletterboxBox(p, activeLb));
      }
    }

    // 2. Multi-Object Tracking & Event Analysis
    let trackedPlayers = [];
    let ballState = { ball: null, trail: [], lostFrames: 0, memoryState: null };

    if (effectiveImageData && effectiveImageData.width > 1) {
      trackedPlayers = state.playerTracker.update(
        detectedPlayers,
        effectiveImageData,
        state.teamAColor,
        state.teamBColor
      );

      // 3. Track Football & Velocity (With candidate matching, manual lock, localized saliency
      //    detector, and two-minute memory-assisted prediction)
      ballState = state.ballTracker.update(
        detectedBall,
        matchTime,
        trackedPlayers,
        detectedBalls,
        state.captureManager?.videoElement,
        framePackage.isSeek ?? false
      );

      // 4. Analyze Events
      state.eventAnalyzer.processFrame(ballState, trackedPlayers, matchTime);
    }

    // 5. Update State & Telemetry
    state.currentDetections.ball = ballState.ball;
    state.currentDetections.allBalls = detectedBalls;
    state.currentDetections.players = trackedPlayers;
    state.currentDetections.ballTrail = ballState.trail;

    state.telemetry.currentTime = matchTime;
    state.telemetry.videoWidth = framePackage.videoWidth;
    state.telemetry.videoHeight = framePackage.videoHeight;
    state.telemetry.playbackRate = framePackage.playbackRate;
    state.telemetry.videoPaused = framePackage.isPaused;
    state.telemetry.fps = state.fpsCounter.fps;
    state.telemetry.latencyMs = latencyMs || (performance.now() - tStart);

    state.telemetry.ballDetected = !!ballState.ball;
    state.telemetry.ballConfidence = ballState.ball ? ballState.ball.confidence : 0;
    state.telemetry.manualBallLock = !!ballState.manualLock;
    state.telemetry.ballLostFrames = ballState.lostFrames;
    state.telemetry.playersCount = trackedPlayers.length;
    state.telemetry.trackedObjectsCount = trackedPlayers.length + (ballState.ball ? 1 : 0);

    // Update memory telemetry from memory state
    const ms = ballState.memoryState;
    if (ms) {
      state.telemetry.memoryTrackingState        = ms.trackingState;
      state.telemetry.memorySearchMode           = ms.searchMode;
      state.telemetry.memoryCameraStatus         = ms.cameraStatus;
      state.telemetry.memoryAgeSec               = ms.ageSinceLastConfirmed;
      state.telemetry.memoryTotalSamples         = ms.totalMemorySamples;
      state.telemetry.memoryPredictedCx          = ms.predictedCx;
      state.telemetry.memoryPredictedCy          = ms.predictedCy;
      state.telemetry.memoryPredictionConfidence = ms.predictionConfidence;
      state.telemetry.memoryMissedFrames         = ms.missedDetectionFrames;
      state.telemetry.memoryReacquisitionAttempts= ms.reacquisitionAttempts;
      state.telemetry.memorySearchRadius         = ms.searchRadius;
    }
    state.lastTrainingImageData = effectiveImageData;

    // 6. Render Overlays
    renderVideoOverlay(framePackage);
    updateFloatingHud();

    const reminderMinute = getFootballTrainingReminderMinute?.(
      matchTime,
      state.lastTrainingReminderMinute
    );
    if (reminderMinute !== null && reminderMinute !== undefined) {
      state.lastTrainingReminderMinute = reminderMinute;
      enablePinpointBallMode();
      showToastNotification(
        `⚽ ${formatMatchTime ? formatMatchTime(matchTime) : `${reminderMinute}:00`}: ` +
        'Click the football to confirm its position and save a training frame.'
      );
    }
  }

  function handleNewEventCandidate(candidate) {
    console.log('[Event Candidate Detected]:', candidate);

    if (state.autoLogging && candidate.confidence >= 0.80) {
      // Auto-submit mode
      const submitRes = state.pnAdapter.submitEvent(candidate, false);
      if (submitRes.success) {
        candidate.status = 'submitted';
        if (state.eventStore) state.eventStore.addEvent(candidate);
        showToastNotification(`Auto-Logged: ${candidate.eventType.toUpperCase()} (${Math.round(candidate.confidence * 100)}%)`);
        return;
      }
    }

    // Assisted Mode: Queue for review
    state.telemetry.pendingSuggestions = state.eventAnalyzer.pendingSuggestions;
    updateFloatingHud();
  }

  function confirmSuggestion(id) {
    const list = state.eventAnalyzer.pendingSuggestions;
    const idx = list.findIndex(s => s.id === id);
    if (idx === -1) return;

    const [confirmed] = list.splice(idx, 1);
    confirmed.status = 'confirmed';

    if (state.eventStore) {
      state.eventStore.addEvent(confirmed);
      state.telemetry.latestLogs = state.eventStore.getAll();
    }

    // Submit to PlayerNation interface
    if (state.pnAdapter) {
      state.pnAdapter.submitEvent(confirmed, true);
    }

    state.telemetry.pendingSuggestions = list;
    updateFloatingHud();
    showToastNotification(`Confirmed & Logged: ${confirmed.eventType}`);
  }

  function rejectSuggestion(id) {
    const list = state.eventAnalyzer.pendingSuggestions;
    const idx = list.findIndex(s => s.id === id);
    if (idx !== -1) {
      list.splice(idx, 1);
      state.telemetry.pendingSuggestions = list;
      updateFloatingHud();
    }
  }

  let overlayResizeObserver = null;

  function attachVideoOverlay(video) {
    if (state.overlayCanvas) state.overlayCanvas.remove();
    if (overlayResizeObserver) {
      overlayResizeObserver.disconnect();
      overlayResizeObserver = null;
    }

    try {
      if (!video.crossOrigin && !video.src?.startsWith('blob:')) {
        video.crossOrigin = 'anonymous';
      }
    } catch (e) {}

    const canvas = document.createElement('canvas');
    canvas.id = 'pn-ai-overlay-canvas';

    const parent = video.parentElement || video;
    if (window.getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    parent.appendChild(canvas);
    state.overlayCanvas = canvas;
    state.overlayCtx = canvas.getContext('2d');

    // Attach Interactive Pinpoint Event Listeners
    canvas.addEventListener('click', handleOverlayCanvasClick);
    canvas.addEventListener('mousemove', handleOverlayCanvasMouseMove);
    canvas.addEventListener('mouseleave', () => {
      state.lastMousePos = null;
      if (state.isPinpointBallMode && state.lastFramePackage) renderVideoOverlay(state.lastFramePackage);
    });

    if (!window._pnAiKeyHook) {
      window._pnAiKeyHook = true;
      window.addEventListener('keydown', handleGlobalKeyDown);
    }

    let resizeRafId = null;
    const updateSize = () => {
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      resizeRafId = requestAnimationFrame(() => {
        if (!state.overlayCanvas || !video) return;
        const rect = video.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        const targetW = Math.round(rect.width);
        const targetH = Math.round(rect.height);

        if (targetW > 0 && targetH > 0) {
          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }
          const offsetTop = Math.max(0, rect.top - parentRect.top);
          const offsetLeft = Math.max(0, rect.left - parentRect.left);
          canvas.style.top = `${offsetTop}px`;
          canvas.style.left = `${offsetLeft}px`;
          canvas.style.width = `${targetW}px`;
          canvas.style.height = `${targetH}px`;
        }
      });
    };

    updateSize();
    window.addEventListener('resize', updateSize, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      overlayResizeObserver = new ResizeObserver(updateSize);
      overlayResizeObserver.observe(video);
    }

    document.addEventListener('fullscreenchange', () => {
      setTimeout(updateSize, 120);
    });
  }

  function enablePinpointBallMode() {
    state.isPinpointBallMode = true;
    state.telemetry.isPinpointBallMode = true;
    if (state.overlayCanvas) {
      state.overlayCanvas.style.pointerEvents = 'auto';
      state.overlayCanvas.style.cursor = 'crosshair';
    }
    showToastNotification('🎯 Click directly on the football on video (Key: B / ESC to cancel)');
    if (state.lastFramePackage) renderVideoOverlay(state.lastFramePackage);
    updateFloatingHud(true);
  }

  function disablePinpointBallMode() {
    state.isPinpointBallMode = false;
    state.telemetry.isPinpointBallMode = false;
    state.lastMousePos = null;
    if (state.overlayCanvas) {
      state.overlayCanvas.style.pointerEvents = 'none';
      state.overlayCanvas.style.cursor = 'default';
    }
    if (state.lastFramePackage) renderVideoOverlay(state.lastFramePackage);
    updateFloatingHud(true);
  }

  function togglePinpointBallMode() {
    if (state.isPinpointBallMode) {
      disablePinpointBallMode();
    } else {
      enablePinpointBallMode();
    }
  }

  async function handleOverlayCanvasClick(e) {
    if (!state.isPinpointBallMode && !e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();

    if (!state.overlayCanvas) return;
    const rect = state.overlayCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const clickX = (e.clientX - rect.left) / rect.width;
    const clickY = (e.clientY - rect.top) / rect.height;

    let targetX = Math.max(0.01, Math.min(0.99, clickX));
    let targetY = Math.max(0.01, Math.min(0.99, clickY));

    const curTime = state.telemetry.currentTime || (state.captureManager?.videoElement?.currentTime || 0);
    if (state.ballTracker) {
      const res = state.ballTracker.setManualBall(targetX, targetY, curTime, state.currentDetections.players);
      state.currentDetections.ball = res.ball;
      state.currentDetections.ballTrail = res.trail;
    }

    state.telemetry.ballDetected = true;
    state.telemetry.manualBallLock = true;
    state.pinpointRipple = { cx: targetX, cy: targetY, startTime: performance.now() };

    disablePinpointBallMode();
    try {
      await saveFootballTrainingSample(clickX, clickY, curTime);
      showToastNotification(
        `🎯 Football locked and labeled. Training frames: ${state.telemetry.trainingSamplesCount}.`
      );
    } catch (err) {
      console.error('[PlayerNation AI Logger] Could not save football training frame:', err);
      showToastNotification(`Football locked, but training frame could not be saved: ${err.message}`);
    }
  }

  async function saveFootballTrainingSample(x, y, matchTimestamp) {
    const imageData = state.lastTrainingImageData || state.lastFramePackage?.imageData;
    if (!imageData || !createFootballTrainingAnnotation) {
      throw new Error('No captured video frame is available. Keep the match playing and try again.');
    }

    const image = imageDataToDataUrl(imageData, 0.95);
    if (!image) throw new Error('Could not encode the captured video frame.');

    const sample = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      matchTimestamp,
      capturedAt: new Date().toISOString(),
      source: window.location.hostname || 'Local Webpage',
      imageWidth: imageData.width,
      imageHeight: imageData.height,
      image,
      annotations: [
        createFootballTrainingAnnotation(x, y, state.lastFramePackage?.letterbox)
      ],
      uploadedForTraining: false
    };

    state.telemetry.trainingSamplesCount = await updateFootballTrainingSamples(samples => {
      samples.push(sample);
    });
    if (state.backendClient?.isOnline) {
      await syncPendingTrainingSamples();
    }
  }

  async function syncPendingTrainingSamples() {
    if (!state.backendClient?.isOnline || state.trainingSyncInProgress) return;
    state.trainingSyncInProgress = true;
    try {
      const data = await new Promise((resolve, reject) => {
        chrome.storage.local.get('footballTrainingSamples', result => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(result);
        });
      });
      const samples = Array.isArray(data.footballTrainingSamples) ? data.footballTrainingSamples : [];
      for (const sample of samples) {
        if (sample.uploadedForTraining) continue;
        const result = await state.backendClient.uploadTrainingSample(
          sample,
          state.minimumTrainingSamples
        );
        if (state.backendClient.serverInfo) {
          state.backendClient.serverInfo.training = result.training;
          if (result.training?.football_model) {
            state.backendClient.serverInfo.model = 'yolov8n.pt + football_finetuned.pt';
            state.telemetry.modelName = state.backendClient.serverInfo.model;
          }
        }
        sample.uploadedForTraining = true;
        sample.trainingStatus = trainingStatusLabel(result.training);
        state.telemetry.trainingStatus = sample.trainingStatus;
        await updateFootballTrainingSamples(latestSamples => {
          const latestSample = latestSamples.find(item => item.id === sample.id);
          if (!latestSample) {
            throw new Error(`Training sample ${sample.id} disappeared before its upload status was saved.`);
          }
          latestSample.uploadedForTraining = true;
          latestSample.trainingStatus = sample.trainingStatus;
        });
      }
    } catch (err) {
      console.error('[PlayerNation AI Logger] Training sample sync failed:', err);
      state.telemetry.trainingStatus = `upload error: ${err.message}`;
    } finally {
      state.trainingSyncInProgress = false;
    }
  }

  function updateFootballTrainingSamples(updateSamples) {
    const operation = state.trainingStorageQueue.then(() => new Promise((resolve, reject) => {
      chrome.storage.local.get('footballTrainingSamples', data => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const samples = Array.isArray(data.footballTrainingSamples)
          ? data.footballTrainingSamples
          : [];
        try {
          updateSamples(samples);
        } catch (err) {
          reject(err);
          return;
        }
        chrome.storage.local.set({ footballTrainingSamples: samples }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(samples.length);
        });
      });
    }));
    state.trainingStorageQueue = operation.catch(() => {});
    return operation;
  }

  function handleOverlayCanvasMouseMove(e) {
    if (!state.isPinpointBallMode || !state.overlayCanvas) return;
    const rect = state.overlayCanvas.getBoundingClientRect();
    state.lastMousePos = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
    if (state.lastFramePackage) {
      renderVideoOverlay(state.lastFramePackage);
    }
  }

  function handleGlobalKeyDown(e) {
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTag === 'input' || activeTag === 'textarea' || document.activeElement?.isContentEditable) return;
    if ((e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      togglePinpointBallMode();
    } else if (e.key === 'Escape' && state.isPinpointBallMode) {
      disablePinpointBallMode();
    }
  }

  function clearVideoOverlay() {
    if (state.overlayCanvas && state.overlayCtx) {
      state.overlayCtx.clearRect(0, 0, state.overlayCanvas.width, state.overlayCanvas.height);
    }
  }

  function renderVideoOverlay(framePackage) {
    if (!state.overlayCanvas || !state.overlayCtx) return;
    state.lastFramePackage = framePackage;
    const ctx = state.overlayCtx;
    // canvas.width / canvas.height are set by attachVideoOverlay() to the
    // displayed video's CSS pixel dimensions — no DPR scaling applied here.
    const w = state.overlayCanvas.width;
    const h = state.overlayCanvas.height;

    ctx.clearRect(0, 0, w, h);

    const isLive = !!(state.telemetry.isLive || framePackage?.isLive);
    const videoTimestamp = framePackage?.videoTimestamp || state.telemetry.currentTime || 0;
    const clockText = isLive
      ? `🔴 LIVE ${formatMatchTime ? formatMatchTime(videoTimestamp) : '00:00'}`
      : `⏱ MATCH ${formatMatchTime ? formatMatchTime(videoTimestamp) : '00:00'}`;

    // 1. Overlay Header Telemetry Badge
    if (state.overlaySettings.showTelemetryBadge) {
      const badgeW = isLive ? 245 : 225;
      ctx.fillStyle = 'rgba(10, 13, 20, 0.88)';
      ctx.fillRect(10, 10, badgeW, 36);
      ctx.strokeStyle = isLive ? 'rgba(239, 68, 68, 0.6)' : 'rgba(16, 185, 129, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(10, 10, badgeW, 36);

      ctx.fillStyle = isLive ? '#ef4444' : '#10b981';
      ctx.font = 'bold 12px monospace';
      ctx.fillText(clockText, 18, 32);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px monospace';
      ctx.fillText(`${state.telemetry.fps.toFixed(1)} FPS`, badgeW - 55, 32);
    }

    // Helper: normalised-video (D) → canvas pixel (E)
    // All detections stored in state use normalised-video coords.
    // The canvas exactly covers the displayed video, so this mapping is
    // simply (nx * canvasWidth, ny * canvasHeight) — no DPR factor needed.
    const toCanvasX = (nx) => nx * w;
    const toCanvasY = (ny) => ny * h;

    // 2. Ball Trail Trajectory
    if (state.overlaySettings.showBallTrail && state.currentDetections.ballTrail.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
      ctx.lineWidth = 2;
      for (let i = 0; i < state.currentDetections.ballTrail.length; i++) {
        const pt = state.currentDetections.ballTrail[i];
        const tx = toCanvasX(pt.cx);
        const ty = toCanvasY(pt.cy);
        if (i === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.stroke();
    }

    // 3. Ball Bounding Box & Label
    // All ball coords are normalised-video (D), converted to canvas (E) here.
    if (state.overlaySettings.showBall && state.currentDetections.ball) {
      const b = state.currentDetections.ball;
      // D → E
      const bx = toCanvasX(b.x);
      const by = toCanvasY(b.y);
      const bw = b.width  * w;
      const bh = b.height * h;
      const memState = state.telemetry.memoryTrackingState;
      const isPredicted = b.isPredictedByMemory ||
        memState === 'PREDICTED' || memState === 'UNCERTAIN';

      if (b.isManual || state.ballTracker?.manualLock) {
        // Glowing cyan/blue targeting lock
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(bx, by, bw, bh);

        // Corner reticle accents
        const arm = Math.max(4, Math.min(bw, bh) * 0.4);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(bx - 3, by + arm); ctx.lineTo(bx - 3, by - 3); ctx.lineTo(bx + arm, by - 3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx + bw + 3 - arm, by - 3); ctx.lineTo(bx + bw + 3, by - 3); ctx.lineTo(bx + bw + 3, by + arm); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx - 3, by + bh - arm); ctx.lineTo(bx - 3, by + bh + 3); ctx.lineTo(bx + arm, by + bh + 3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx + bw + 3 - arm, by + bh + 3); ctx.lineTo(bx + bw + 3, by + bh + 3); ctx.lineTo(bx + bw + 3, by + bh - arm); ctx.stroke();

        if (state.overlaySettings.showPlayerLabels) {
          ctx.fillStyle = 'rgba(14, 165, 233, 0.9)';
          ctx.fillRect(bx, by - 16, 76, 15);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px sans-serif';
          ctx.fillText(`🎯 ⚽ LOCKED`, bx + 4, by - 5);
        }
      } else if (isPredicted) {
        // Dashed amber box — memory-predicted position
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.restore();

        if (state.overlaySettings.showPlayerLabels) {
          ctx.fillStyle = 'rgba(245, 158, 11, 0.85)';
          ctx.fillRect(bx, by - 16, 90, 15);
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 9px sans-serif';
          ctx.fillText(`⚽ PREDICTED ${Math.round(b.confidence * 100)}%`, bx + 4, by - 5);
        }

        // Draw search region circle (normalised radius scaled to canvas)
        if (state.telemetry.memorySearchMode !== 'FULL_FRAME') {
          const sr  = state.telemetry.memorySearchRadius;
          const scx = toCanvasX(state.telemetry.memoryPredictedCx ?? b.cx);
          const scy = toCanvasY(state.telemetry.memoryPredictedCy ?? b.cy);
          const rad = sr * Math.min(w, h);
          ctx.save();
          ctx.setLineDash([3, 5]);
          ctx.beginPath();
          ctx.arc(scx, scy, rad, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        }
      } else {
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2;
        ctx.strokeRect(bx, by, bw, bh);

        if (state.overlaySettings.showPlayerLabels) {
          ctx.fillStyle = '#10b981';
          ctx.font = 'bold 10px sans-serif';
          ctx.fillText(`⚽ ${Math.round(b.confidence * 100)}%`, bx, by - 4);
        }
      }
    }

    // 4. Tracked Players (Humans) — normalised-video (D) → canvas (E)
    if (state.overlaySettings.showPlayers) {
      for (const player of state.currentDetections.players) {
        const px = toCanvasX(player.x);
        const py = toCanvasY(player.y);
        const pw = player.width  * w;
        const ph = player.height * h;

        ctx.strokeStyle = player.team === 'Team A' ? state.teamAColor :
          (player.team === 'Team B' ? state.teamBColor : '#94a3b8');
        ctx.lineWidth = 1.8;
        ctx.strokeRect(px, py, pw, ph);

        if (state.overlaySettings.showPlayerLabels) {
          ctx.fillStyle = 'rgba(10, 13, 20, 0.75)';
          ctx.fillRect(px, py - 14, 55, 14);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px sans-serif';
          ctx.fillText(`ID:${player.id} [${player.team.slice(0, 6)}]`, px + 2, py - 4);
        }
      }
    }

    // 5. Expanding Radar Ripple on Tagged Click
    if (state.pinpointRipple) {
      const elapsed = (performance.now() - state.pinpointRipple.startTime) / 1000;
      if (elapsed < 1.0) {
        const rx = toCanvasX(state.pinpointRipple.cx);
        const ry = toCanvasY(state.pinpointRipple.cy);
        const radius = 8 + elapsed * 60;
        const alpha  = Math.max(0, 1 - elapsed);
        ctx.beginPath();
        ctx.arc(rx, ry, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(56, 189, 248, ${alpha})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rx, ry, radius * 0.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(16, 185, 129, ${alpha * 0.8})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        state.pinpointRipple = null;
      }
    }

    // 6. Pinpoint Mode Active Banner & Crosshair Reticle
    if (state.isPinpointBallMode) {
      const bannerW = Math.min(380, w - 20);
      const bx = (w - bannerW) / 2;
      ctx.fillStyle = 'rgba(14, 165, 233, 0.95)';
      ctx.fillRect(bx, 10, bannerW, 30);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, 10, bannerW, 30);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🎯 Click on the football in video to lock tracking (ESC to cancel)', w / 2, 30);
      ctx.textAlign = 'left';

      // Mouse Reticle (already in canvas pixel coords from mousemove handler)
      if (state.lastMousePos) {
        const mx = state.lastMousePos.x;
        const my = state.lastMousePos.y;
        ctx.beginPath();
        ctx.arc(mx, my, 14, 0, Math.PI * 2);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx - 22, my); ctx.lineTo(mx + 22, my);
        ctx.moveTo(mx, my - 22); ctx.lineTo(mx, my + 22);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // 7. Debug Coordinate Visualisation (enable via debugCoords setting)
    if (state.overlaySettings.debugCoords && typeof buildDebugInfo === 'function') {
      const ball = state.currentDetections.ball;
      const lb   = framePackage?.letterbox;
      const vid  = state.captureManager?.videoElement;

      // For debug: reconstruct the raw model box from the current normalised ball
      // by reversing the D→C transform so we can display all three stages.
      let rawModelBox  = null;
      let videoNormBox = null;
      let canvasBox    = null;

      if (ball && lb && vid?.videoWidth) {
        videoNormBox = { x: ball.x, y: ball.y, width: ball.width, height: ball.height,
                         cx: ball.cx, cy: ball.cy };
        canvasBox    = { x: ball.x * w, y: ball.y * h,
                         width: ball.width * w, height: ball.height * h,
                         cx: (ball.cx) * w, cy: (ball.cy) * h };
        // Reconstruct approximate raw model box (D → A → B → C)
        if (typeof videoNormToModelNorm === 'function') {
          const hX = videoNormToModelNorm(ball.cx, ball.cy, vid.videoWidth, vid.videoHeight, lb);
          const halfW = (ball.width  * vid.videoWidth  * lb.scale / 640) / 2;
          const halfH = (ball.height * vid.videoHeight * lb.scale / 640) / 2;
          rawModelBox = {
            x:  hX.hx - halfW, y:  hX.hy - halfH,
            width: halfW * 2,  height: halfH * 2,
            cx: hX.hx,         cy: hX.hy
          };
        }
      }

      const debugInfo = buildDebugInfo({
        video: vid,
        canvasWidth:  w,
        canvasHeight: h,
        letterbox:    lb,
        rawModelBox,
        videoNormBox,
        canvasBox
      });
      drawDebugPanel(ctx, debugInfo);
    }
  }

  function createFloatingHud() {
    if (state.floatingHud) return;

    const hud = document.createElement('div');
    hud.id = 'pn-ai-floating-hud';
    hud.innerHTML = `
      <div class="pn-hud-header" id="pnHudHeader">
        <span class="pn-hud-title">⚽ AI Vision <span class="pn-hud-domain" id="pnDomainBadge">${state.telemetry.siteDomain || 'Live'}</span></span>
        <div class="pn-hud-controls">
          <button class="pn-hud-btn" id="pnBtnSwitchVideo" style="display:none; font-size:9px; background:rgba(255,255,255,0.1); padding:2px 6px;" title="Switch tracked match video">📹 Switch</button>
          <button class="pn-hud-btn" id="pnBtnTagBall" style="font-size:9px; background:rgba(34,197,94,0.18); border:1px solid rgba(34,197,94,0.4); color:#4ade80; padding:2px 7px; border-radius:4px; font-weight:600; cursor:pointer;" title="Manually pinpoint/lock football (Hotkeys: 'B' or Shift+Click video)">🎯 Pinpoint</button>
          <button class="pn-hud-btn" id="pnBtnMin" title="Minimize">_</button>
          <button class="pn-hud-btn" id="pnBtnClose" title="Close">&times;</button>
        </div>
      </div>
      <div class="pn-hud-body">
        <section class="pn-hud-section pn-recent-logs">
          <div class="pn-hud-section-heading pn-recent-logs-heading">
            <span>Live Match Table</span>
            <span id="pnRecentLogsClock">00:00:00</span>
            <button class="pn-hud-collapse" type="button" aria-expanded="true" aria-label="Collapse live match table">−</button>
          </div>
          <div class="pn-hud-section-content" id="pnRecentLogsContent">
            <div class="pn-recent-logs-group">
              <div class="pn-recent-logs-subheading">Past 5</div>
              <div id="pnPastLogs" class="pn-corner-log-table"></div>
            </div>
            <div class="pn-recent-logs-group">
              <div class="pn-recent-logs-subheading">Upcoming 5</div>
              <div id="pnUpcomingLogs" class="pn-corner-log-table"></div>
            </div>
          </div>
        </section>
        <section class="pn-hud-section">
          <div class="pn-hud-section-heading">
            <span>Live Status</span>
            <button class="pn-hud-collapse" type="button" aria-expanded="true" aria-label="Collapse live status">−</button>
          </div>
          <div class="pn-hud-section-content" id="pnHudStatusContent">
            <div class="pn-hud-stats">
              <span class="live-badge" id="pnStat">ACTIVE</span>
              <span id="pnClock">00:00</span>
              <span id="pnFps">-- FPS</span>
            </div>
          </div>
        </section>
        <section class="pn-hud-section">
          <div class="pn-hud-section-heading">
            <span>Display Layers</span>
            <button class="pn-hud-collapse" type="button" aria-expanded="true" aria-label="Collapse display layers">−</button>
          </div>
          <div class="pn-hud-section-content" id="pnHudLayersContent">
            <div class="pn-hud-layers-bar" id="pnHudLayersBar">
              <button class="pn-hud-layer-pill ${state.overlaySettings.showPlayers ? 'active' : ''}" id="pnPillPlayers" title="Toggle Human / Players Bounding Boxes">👤 Human</button>
              <button class="pn-hud-layer-pill ${state.overlaySettings.showBall ? 'active' : ''}" id="pnPillBall" title="Toggle Football Bounding Box">⚽ Ball</button>
              <button class="pn-hud-layer-pill ${state.overlaySettings.showPlayerLabels ? 'active' : ''}" id="pnPillLabels" title="Toggle Player ID & Team Labels">🏷️ Labels</button>
              <button class="pn-hud-layer-pill ${state.overlaySettings.showBallTrail ? 'active' : ''}" id="pnPillTrail" title="Toggle Ball Trajectory Trail">〰️ Trail</button>
            </div>
          </div>
        </section>
        <section class="pn-hud-section">
          <div class="pn-hud-section-heading">
            <span>Event Suggestions</span>
            <button class="pn-hud-collapse" type="button" aria-expanded="true" aria-label="Collapse event suggestions">−</button>
          </div>
          <div class="pn-hud-section-content" id="pnSuggestionsContent">
            <div id="pnSuggestionsBox">
              <span style="color:#64748b; font-size:10px;">Monitoring football action...</span>
            </div>
          </div>
        </section>
      </div>
      <div class="pn-hud-footer">
        <span id="pnModeTag">Assisted Mode</span>
        <span id="pnLogsCount">0 Logged</span>
      </div>
    `;

    document.body.appendChild(hud);
    state.floatingHud = hud;
    state.floatingHudElements = {
      stat: hud.querySelector('#pnStat'),
      clock: hud.querySelector('#pnClock'),
      fps: hud.querySelector('#pnFps'),
      logs: hud.querySelector('#pnLogsCount'),
      mode: hud.querySelector('#pnModeTag'),
      box: hud.querySelector('#pnSuggestionsBox'),
      domain: hud.querySelector('#pnDomainBadge'),
      switchBtn: hud.querySelector('#pnBtnSwitchVideo'),
      btnTagBall: hud.querySelector('#pnBtnTagBall'),
      recentLogsClock: hud.querySelector('#pnRecentLogsClock'),
      pastLogs: hud.querySelector('#pnPastLogs'),
      upcomingLogs: hud.querySelector('#pnUpcomingLogs'),
      pillPlayers: hud.querySelector('#pnPillPlayers'),
      pillBall: hud.querySelector('#pnPillBall'),
      pillLabels: hud.querySelector('#pnPillLabels'),
      pillTrail: hud.querySelector('#pnPillTrail'),
    };

    const btnTag = hud.querySelector('#pnBtnTagBall');
    if (btnTag) {
      btnTag.onclick = () => {
        if (state.telemetry.manualBallLock) {
          if (state.ballTracker) state.ballTracker.clearManualLock();
          state.telemetry.manualBallLock = false;
          showToastNotification('Football manual lock released');
          updateFloatingHud(true);
        } else {
          togglePinpointBallMode();
        }
      };
    }

    const toggleLayer = (key, pillEl, name) => {
      state.overlaySettings[key] = !state.overlaySettings[key];
      const val = state.overlaySettings[key];
      if (pillEl) pillEl.classList.toggle('active', val);
      chrome.storage.local.get('settings', (data) => {
        const s = data.settings || {};
        s[key] = val;
        chrome.storage.local.set({ settings: s });
      });
      if (state.lastFramePackage) {
        renderVideoOverlay(state.lastFramePackage);
      }
      showToastNotification(`${name}: ${val ? 'ON' : 'OFF'}`);
    };

    const pillP = hud.querySelector('#pnPillPlayers');
    const pillB = hud.querySelector('#pnPillBall');
    const pillL = hud.querySelector('#pnPillLabels');
    const pillT = hud.querySelector('#pnPillTrail');

    if (pillP) pillP.onclick = () => toggleLayer('showPlayers', pillP, 'Human overlay');
    if (pillB) pillB.onclick = () => toggleLayer('showBall', pillB, 'Football overlay');
    if (pillL) pillL.onclick = () => toggleLayer('showPlayerLabels', pillL, 'Player labels');
    if (pillT) pillT.onclick = () => toggleLayer('showBallTrail', pillT, 'Ball trail');

    hud.querySelectorAll('.pn-hud-collapse').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const content = button.closest('.pn-hud-section')?.querySelector('.pn-hud-section-content');
        if (!content) return;
        const expanded = button.getAttribute('aria-expanded') === 'true';
        content.hidden = expanded;
        button.setAttribute('aria-expanded', String(!expanded));
        button.setAttribute('aria-label', `${expanded ? 'Expand' : 'Collapse'} ${button.getAttribute('aria-label').replace(/^(Collapse|Expand) /, '')}`);
        button.textContent = expanded ? '+' : '−';
      });
    });

    makeDraggable(hud, hud.querySelector('#pnHudHeader'));
    hud.querySelector('#pnBtnMin').onclick = () => hud.classList.toggle('minimized');
    hud.querySelector('#pnBtnClose').onclick = () => {
      hud.style.display = 'none';
      state.hudVisible = false;
    };
  }

  function toggleHud() {
    if (!state.floatingHud) createFloatingHud();
    state.hudVisible = !state.hudVisible;
    if (state.floatingHud) state.floatingHud.style.display = state.hudVisible ? 'flex' : 'none';
  }

  let lastHudUpdateTime = 0;
  let lastVideoCheckTime = 0;

  function updateFloatingHud(force = false) {
    if (!state.floatingHud || !state.floatingHudElements) return;

    const now = performance.now();
    if (!force && (now - lastHudUpdateTime < 250)) return;
    lastHudUpdateTime = now;

    const { stat, clock, fps, logs, mode, box, domain, switchBtn, btnTagBall, pillPlayers, pillBall, pillLabels, pillTrail } = state.floatingHudElements;

    if (btnTagBall) {
      if (state.isPinpointBallMode) {
        btnTagBall.textContent = '🎯 Click Video...';
        btnTagBall.style.background = 'rgba(239, 68, 68, 0.3)';
        btnTagBall.style.borderColor = 'rgba(239, 68, 68, 0.7)';
        btnTagBall.style.color = '#fca5a5';
      } else if (state.telemetry.manualBallLock) {
        btnTagBall.textContent = '🎯 Locked ✖';
        btnTagBall.style.background = 'rgba(6, 182, 212, 0.25)';
        btnTagBall.style.borderColor = 'rgba(6, 182, 212, 0.6)';
        btnTagBall.style.color = '#67e8f9';
        btnTagBall.title = 'Football locked! Click to unlock';
      } else {
        btnTagBall.textContent = '🎯 Pinpoint';
        btnTagBall.style.background = 'rgba(34, 197, 94, 0.18)';
        btnTagBall.style.borderColor = 'rgba(34, 197, 94, 0.4)';
        btnTagBall.style.color = '#4ade80';
        btnTagBall.title = "Manually pinpoint/lock football (Hotkeys: 'B' or Shift+Click video)";
      }
    }

    if (pillPlayers) pillPlayers.classList.toggle('active', !!state.overlaySettings.showPlayers);
    if (pillBall) pillBall.classList.toggle('active', !!state.overlaySettings.showBall);
    if (pillLabels) pillLabels.classList.toggle('active', !!state.overlaySettings.showPlayerLabels);
    if (pillTrail) pillTrail.classList.toggle('active', !!state.overlaySettings.showBallTrail);

    if (domain) domain.textContent = state.telemetry.siteDomain || 'Live';
    if (stat) {
      if (state.telemetry.isCorsProtected) {
        stat.textContent = 'PROTECTED';
        stat.style.color = '#f59e0b';
      } else if (state.telemetry.isLive) {
        stat.textContent = '🔴 LIVE';
        stat.style.color = '#ef4444';
      } else {
        stat.textContent = state.telemetry.status.toUpperCase();
        stat.style.color = '#10b981';
      }
    }
    if (clock) clock.textContent = formatMatchTime ? formatMatchTime(state.telemetry.currentTime) : '00:00';
    if (fps) fps.textContent = `${state.telemetry.fps.toFixed(1)} FPS`;
    if (mode) mode.textContent = state.autoLogging ? 'Auto-Logging ON' : 'Assisted Mode';
    if (logs && state.eventStore) {
      const eventLogs = state.eventStore.getAll();
      logs.textContent = `${eventLogs.length} Logged`;
      renderHudRecentLogs(eventLogs);
    }

    // Only query videos periodically (every 2s), NOT on every frame
    if (switchBtn && (now - lastVideoCheckTime > 2000 || force)) {
      lastVideoCheckTime = now;
      const allVideos = VideoCaptureManager.findAllVideoElements();
      if (allVideos.length > 1) {
        const curIdx = allVideos.indexOf(state.captureManager?.videoElement);
        switchBtn.style.display = 'inline-flex';
        switchBtn.textContent = `📹 Video ${curIdx >= 0 ? curIdx + 1 : 1}/${allVideos.length}`;
        switchBtn.onclick = (e) => {
          e.stopPropagation();
          const nextIdx = ((curIdx >= 0 ? curIdx : 0) + 1) % allVideos.length;
          switchTrackingVideo(allVideos[nextIdx]);
        };
      } else {
        switchBtn.style.display = 'none';
      }
    }

    const pending = state.telemetry.pendingSuggestions;
    if (box && pending.length > 0) {
      box.dataset.hasSuggestions = 'true';
      box.innerHTML = pending.map(s => `
        <div class="pn-hud-suggestion-card" data-id="${s.id}">
          <div class="pn-hud-sugg-title">
            <span>${formatMatchTime(s.matchTimestamp)} - ${s.eventType.toUpperCase()}</span>
            <span>${Math.round(s.confidence * 100)}%</span>
          </div>
          <div class="pn-hud-actions">
            <button class="pn-hud-act-btn pn-act-confirm" onclick="window.pnConfirmSugg('${s.id}')">Confirm</button>
            <button class="pn-hud-act-btn pn-act-reject" onclick="window.pnRejectSugg('${s.id}')">Reject</button>
          </div>
        </div>
      `).join('');
    } else if (box && box.dataset.hasSuggestions === 'true') {
      box.dataset.hasSuggestions = 'false';
      box.innerHTML = '<span style="color:#64748b; font-size:10px;">Monitoring football action...</span>';
    }
  }

  function renderHudRecentLogs(events) {
    const { recentLogsClock, pastLogs, upcomingLogs } = state.floatingHudElements || {};
    if (!pastLogs || !upcomingLogs) return;

    const liveTime = state.telemetry.currentTime || 0;
    const { past, upcoming } = getRecentEventsAroundTime(events, liveTime, 5);
    if (recentLogsClock) recentLogsClock.textContent = formatMatchTime(liveTime, true);
    renderHudLogTable(pastLogs, past, 'No past logs.');
    renderHudLogTable(upcomingLogs, upcoming, 'No upcoming logs.');
  }

  function renderHudLogTable(container, events, emptyMessage) {
    container.replaceChildren();
    if (events.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pn-corner-log-empty';
      empty.textContent = emptyMessage;
      container.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'pn-corner-log-grid';
    const header = table.createTHead().insertRow();
    ['Time', 'Event', 'Name', 'PID', 'Jersey', 'Manual ID'].forEach(label => {
      const cell = document.createElement('th');
      cell.textContent = label;
      header.appendChild(cell);
    });

    const body = table.createTBody();
    events.forEach(event => {
      const row = body.insertRow();
      const label = event.eventLabel || event.eventType
        .split('-')
        .map(part => part ? part[0].toUpperCase() + part.slice(1) : '')
        .join(' ');
      const values = [
        formatMatchTime(event.matchTimestamp, true),
        label,
        event.playerName || '',
        event.pid || event.playerId || '',
        event.jersey || '',
        event.manualId || ''
      ];
      values.forEach(value => {
        const cell = row.insertCell();
        cell.textContent = value;
      });
    });

    container.appendChild(table);
  }

  window.pnConfirmSugg = (id) => confirmSuggestion(id);
  window.pnRejectSugg = (id) => rejectSuggestion(id);

  function syncTelemetry() {
    const video = VideoCaptureManager.findVideoElement();
    state.telemetry.videoFound = !!video;
    state.telemetry.siteDomain = window.location.hostname || 'Local Webpage';
    if (video) {
      state.telemetry.isLive = VideoCaptureManager.isLiveStream(video);
      state.telemetry.currentTime = video.currentTime;
      state.telemetry.videoPaused = video.paused;
      state.telemetry.videoWidth = video.videoWidth;
      state.telemetry.videoHeight = video.videoHeight;
    }
    if (state.eventAnalyzer) {
      state.telemetry.pendingSuggestions = state.eventAnalyzer.pendingSuggestions;
    }
    if (state.eventStore) {
      state.telemetry.latestLogs = state.eventStore.getAll();
    }
    if (state.backendClient?.serverInfo?.training) {
      state.telemetry.trainingStatus = trainingStatusLabel(state.backendClient.serverInfo.training);
    }
  }

  function trainingStatusLabel(training) {
    if (training?.error) return `error: ${training.error}`;
    return training?.status || 'collecting';
  }

  function handleCaptureStatus(evt) {
    if (evt.currentTime != null) state.telemetry.currentTime = evt.currentTime;
    if (evt.isLive !== undefined) state.telemetry.isLive = evt.isLive;
    if (evt.state === 'cors_protected') {
      state.telemetry.isCorsProtected = true;
      state.telemetry.status = 'cors_protected';
    }
    if (evt.state === 'attached' || evt.state === 'playing') state.telemetry.videoFound = true;
    updateFloatingHud();
  }

  function handleCaptureError(err) {
    console.error('[Capture Error]:', err);
    state.telemetry.status = 'error';
    updateFloatingHud();
  }

  function showToastNotification(msg) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(10, 13, 20, 0.95);
      border: 1px solid #10b981;
      color: #10b981;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      z-index: 100000;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  function makeDraggable(element, handle) {
    let p1 = 0, p2 = 0, p3 = 0, p4 = 0;
    handle.onmousedown = (e) => {
      if (e.target.closest('button, input, textarea, select, a')) return;
      e.preventDefault();
      p3 = e.clientX;
      p4 = e.clientY;
      document.onmouseup = () => {
        document.onmouseup = null;
        document.onmousemove = null;
      };
      document.onmousemove = (e2) => {
        e2.preventDefault();
        p1 = p3 - e2.clientX;
        p2 = p4 - e2.clientY;
        p3 = e2.clientX;
        p4 = e2.clientY;
        element.style.top = (element.offsetTop - p2) + 'px';
        element.style.left = (element.offsetLeft - p1) + 'px';
        element.style.bottom = 'auto';
        element.style.right = 'auto';
      };
    };
  }

  // Dynamic observer for newly mounted match videos (e.g., SPA navigation on playernation.app)
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    const pageVideoObserver = new MutationObserver(() => {
      if (state.isRunning) {
        const curVideo = state.captureManager?.videoElement;
        if (!curVideo || !document.contains(curVideo)) {
          const newVideo = VideoCaptureManager.findVideoElement();
          if (newVideo && newVideo !== curVideo) {
            console.log('[PlayerNation AI Logger] Re-attaching to newly mounted match video element');
            switchTrackingVideo(newVideo);
          }
        }
      }
    });
    pageVideoObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
})();
