/**
 * Content Script for PlayerNation AI Event Logger
 * Connects Video Capture, YOLO Detection, Multi-Object Tracking,
 * Football Event Analysis, and the PlayerNation Interface Bridge.
 */

(async function () {
  console.log('[PlayerNation AI Logger] Initializing vision pipeline on', window.location.href);

  // Dynamic ES Module Imports
  let VideoCaptureManager, formatMatchTime, isDuplicateEvent;
  let FootballYoloDetector, PlayerTracker, BallTracker;
  let FootballEventAnalyzer, PlayerNationAdapter, MatchEventStore;

  try {
    const vcMod = await import(chrome.runtime.getURL('utils/video-capture.js'));
    const tsMod = await import(chrome.runtime.getURL('utils/timestamps.js'));
    const detMod = await import(chrome.runtime.getURL('detector/detector.js'));
    const trkMod = await import(chrome.runtime.getURL('tracking/tracker.js'));
    const ballMod = await import(chrome.runtime.getURL('tracking/ball-tracker.js'));
    const evtMod = await import(chrome.runtime.getURL('events/event-analyzer.js'));
    const adpMod = await import(chrome.runtime.getURL('integration/playernation-adapter.js'));
    const storeMod = await import(chrome.runtime.getURL('logs/event-store.js'));

    VideoCaptureManager = vcMod.VideoCaptureManager;
    formatMatchTime = tsMod.formatMatchTime;
    isDuplicateEvent = tsMod.isDuplicateEvent;
    FootballYoloDetector = detMod.FootballYoloDetector;
    PlayerTracker = trkMod.PlayerTracker;
    BallTracker = ballMod.BallTracker;
    FootballEventAnalyzer = evtMod.FootballEventAnalyzer;
    PlayerNationAdapter = adpMod.PlayerNationAdapter;
    MatchEventStore = storeMod.MatchEventStore;
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
    playerTracker: null,
    ballTracker: null,
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
      playersCount: 0,
      trackedObjectsCount: 0,
      pendingSuggestions: [],
      latestLogs: []
    },

    fpsCounter: {
      frames: 0,
      lastTime: performance.now(),
      fps: 0
    },

    currentDetections: {
      ball: null,
      players: [],
      ballTrail: []
    }
  };

  // Initialize Event Store and Adapter
  if (MatchEventStore) {
    state.eventStore = new MatchEventStore();
    state.eventStore.init().then(logs => {
      state.telemetry.latestLogs = logs;
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
        sendResponse({ success: true, telemetry: state.telemetry });
        break;

      case 'CMD_TOGGLE_HUD':
        toggleHud();
        sendResponse({ success: true, visible: state.hudVisible });
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

      case 'CMD_CLEAR_LOGS':
        if (state.eventStore) state.eventStore.clear();
        state.telemetry.latestLogs = [];
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

    // 1. Initialize YOLO Detector
    if (!state.detector) {
      state.detector = new FootballYoloDetector({
        modelPath: 'models/yolov8n.onnx',
        playerConfidence: 0.30,
        ballConfidence: 0.15,
        iouThreshold: 0.45
      });
      try {
        await state.detector.load();
        state.isModelLoaded = true;
        state.telemetry.inferenceBackend = state.detector.backendUsed;
      } catch (loadErr) {
        console.warn('[PlayerNation AI Logger] Could not load ONNX model directly:', loadErr.message);
        state.isModelLoaded = false;
        state.telemetry.inferenceBackend = 'Standby (Load model in models/)';
      }
    }

    // 2. Initialize Trackers and Analyzer
    state.playerTracker = new PlayerTracker({ maxLostFrames: 12, iouThreshold: 0.3 });
    state.ballTracker = new BallTracker({ maxTrailLength: 20, maxLostFrames: 8 });
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

    return { success: true };
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

    // 1. Run YOLO Inference if model is loaded
    let detectedBall = null;
    let detectedPlayers = [];
    let latencyMs = 0;

    if (state.isModelLoaded && state.detector) {
      try {
        const detResults = await state.detector.detect(framePackage.imageData);
        detectedBall = detResults.ball;
        detectedPlayers = detResults.players;
        latencyMs = detResults.latencyMs;
      } catch (err) {
        console.error('[Detector Error]:', err);
      }
    }

    // 2. Track Players & Sample Jersey Colors
    const trackedPlayers = state.playerTracker.update(
      detectedPlayers,
      framePackage.imageData,
      state.teamAColor,
      state.teamBColor
    );

    // 3. Track Football & Velocity
    const ballState = state.ballTracker.update(detectedBall, matchTime, trackedPlayers);

    // 4. Analyze Events
    state.eventAnalyzer.processFrame(ballState, trackedPlayers, matchTime);

    // 5. Update State
    state.currentDetections.ball = ballState.ball;
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
    state.telemetry.ballLostFrames = ballState.lostFrames;
    state.telemetry.playersCount = trackedPlayers.length;
    state.telemetry.trackedObjectsCount = trackedPlayers.length + (ballState.ball ? 1 : 0);

    // 6. Render Overlays
    renderVideoOverlay(framePackage);
    updateFloatingHud();
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

    const canvas = document.createElement('canvas');
    canvas.id = 'pn-ai-overlay-canvas';

    const parent = video.parentElement || video;
    if (window.getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    parent.appendChild(canvas);
    state.overlayCanvas = canvas;
    state.overlayCtx = canvas.getContext('2d');

    const updateSize = () => {
      const rect = video.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;

      // Position canvas overlay exactly over the video bounds
      const offsetTop = Math.max(0, rect.top - parentRect.top);
      const offsetLeft = Math.max(0, rect.left - parentRect.left);
      canvas.style.top = `${offsetTop}px`;
      canvas.style.left = `${offsetLeft}px`;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };

    updateSize();
    window.addEventListener('resize', updateSize);

    if (typeof ResizeObserver !== 'undefined') {
      overlayResizeObserver = new ResizeObserver(updateSize);
      overlayResizeObserver.observe(video);
    }

    document.addEventListener('fullscreenchange', () => {
      setTimeout(updateSize, 120);
    });
  }

  function clearVideoOverlay() {
    if (state.overlayCanvas && state.overlayCtx) {
      state.overlayCtx.clearRect(0, 0, state.overlayCanvas.width, state.overlayCanvas.height);
    }
  }

  function renderVideoOverlay(framePackage) {
    if (!state.overlayCanvas || !state.overlayCtx) return;
    const ctx = state.overlayCtx;
    const w = state.overlayCanvas.width;
    const h = state.overlayCanvas.height;

    ctx.clearRect(0, 0, w, h);

    const isLive = !!(state.telemetry.isLive || framePackage.isLive);
    const clockText = isLive
      ? `🔴 LIVE ${formatMatchTime ? formatMatchTime(framePackage.videoTimestamp) : '00:00'}`
      : `⏱ MATCH ${formatMatchTime ? formatMatchTime(framePackage.videoTimestamp) : '00:00'}`;

    // Overlay Header Telemetry Badge
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

    // Ball Trail Trajectory
    if (state.currentDetections.ballTrail.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
      ctx.lineWidth = 2;
      for (let i = 0; i < state.currentDetections.ballTrail.length; i++) {
        const pt = state.currentDetections.ballTrail[i];
        const tx = pt.cx * w;
        const ty = pt.cy * h;
        if (i === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.stroke();
    }

    // Ball Bounding Box
    if (state.currentDetections.ball) {
      const b = state.currentDetections.ball;
      const bx = b.x * w;
      const by = b.y * h;
      const bw = b.width * w;
      const bh = b.height * h;

      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = '#10b981';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(`⚽ ${Math.round(b.confidence * 100)}%`, bx, by - 4);
    }

    // Tracked Players
    for (const player of state.currentDetections.players) {
      const px = player.x * w;
      const py = player.y * h;
      const pw = player.width * w;
      const ph = player.height * h;

      ctx.strokeStyle = player.team === 'Team A' ? state.teamAColor : (player.team === 'Team B' ? state.teamBColor : '#94a3b8');
      ctx.lineWidth = 1.8;
      ctx.strokeRect(px, py, pw, ph);

      ctx.fillStyle = 'rgba(10, 13, 20, 0.75)';
      ctx.fillRect(px, py - 14, 55, 14);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText(`ID:${player.id} [${player.team.slice(0, 6)}]`, px + 2, py - 4);
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
          <button class="pn-hud-btn" id="pnBtnMin" title="Minimize">_</button>
          <button class="pn-hud-btn" id="pnBtnClose" title="Close">&times;</button>
        </div>
      </div>
      <div class="pn-hud-body">
        <div class="pn-hud-stats">
          <span class="live-badge" id="pnStat">ACTIVE</span>
          <span id="pnClock">00:00</span>
          <span id="pnFps">-- FPS</span>
        </div>
        <div id="pnSuggestionsBox">
          <span style="color:#64748b; font-size:10px;">Monitoring football action...</span>
        </div>
      </div>
      <div class="pn-hud-footer">
        <span id="pnModeTag">Assisted Mode</span>
        <span id="pnLogsCount">0 Logged</span>
      </div>
    `;

    document.body.appendChild(hud);
    state.floatingHud = hud;

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

  function updateFloatingHud() {
    if (!state.floatingHud) return;

    const stat = state.floatingHud.querySelector('#pnStat');
    const clock = state.floatingHud.querySelector('#pnClock');
    const fps = state.floatingHud.querySelector('#pnFps');
    const logs = state.floatingHud.querySelector('#pnLogsCount');
    const mode = state.floatingHud.querySelector('#pnModeTag');
    const box = state.floatingHud.querySelector('#pnSuggestionsBox');
    const domain = state.floatingHud.querySelector('#pnDomainBadge');

    if (domain) domain.textContent = state.telemetry.siteDomain || 'Live';
    if (stat) {
      if (state.telemetry.isLive) {
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
    if (logs && state.eventStore) logs.textContent = `${state.eventStore.getAll().length} Logged`;

    const pending = state.telemetry.pendingSuggestions;
    if (box && pending.length > 0) {
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
    } else if (box) {
      box.innerHTML = '<span style="color:#64748b; font-size:10px;">No pending suggestions.</span>';
    }
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
})();
