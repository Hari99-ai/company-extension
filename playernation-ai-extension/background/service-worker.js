/**
 * Background Service Worker for PlayerNation AI Logger
 * Manifest V3 background script managing extension state, tab capture streams,
 * and inter-component message routing.
 */

const STATE = {
  activeTabId: null,
  isDetecting: false,
  isPaused: false,
  autoLoggingEnabled: false,
  lastKnownStatus: {
    videoStatus: 'idle',
    modelStatus: 'not_loaded',
    fps: 0,
    playersCount: 0,
    ballDetected: false,
    currentTime: 0
  }
};

// Initialize default storage on install & configure CORS headers for media streams
chrome.runtime.onInstalled.addListener(() => {
  console.log('[PlayerNation AI Logger] Extension Installed.');
  chrome.storage.local.set({
    settings: {
      targetFps: 8,
      confidenceThreshold: 0.25,
      autoLoggingEnabled: false,
      teamAColor: '#ffffff',
      teamBColor: '#ff2222',
      modelVariant: 'yolov8n',
      minimumTrainingSamples: 20,
      showPlayers: true,
      showBall: true,
      showPlayerLabels: true,
      showBallTrail: true,
      showTelemetryBadge: true,
      playerConfidence: 0.25,
      ballConfidence: 0.08
    },
    eventLogs: []
  });

  // Enable CORS header modification for media streams so videos never taint canvas
  if (chrome.declarativeNetRequest) {
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001],
      addRules: [{
        id: 1001,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
          ]
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['media', 'xmlhttprequest', 'other']
        }
      }]
    }).catch(e => console.warn('[PlayerNation AI SW] Declarative Net Request notice:', e));
  }
});

// Listener for messages from popup or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'GET_STATUS':
      sendResponse({ success: true, data: STATE });
      break;

    case 'START_DETECTION':
      handleStartDetection(sender?.tab?.id, payload)
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // Keep message channel open for async response

    case 'STOP_DETECTION':
      handleStopDetection()
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'PAUSE_DETECTION':
      STATE.isPaused = true;
      forwardToActiveTab({ type: 'CMD_PAUSE' });
      sendResponse({ success: true });
      break;

    case 'RESUME_DETECTION':
      STATE.isPaused = false;
      forwardToActiveTab({ type: 'CMD_RESUME' });
      sendResponse({ success: true });
      break;

    case 'SET_AUTO_LOGGING':
      STATE.autoLoggingEnabled = !!payload.enabled;
      chrome.storage.local.get('settings', (data) => {
        const settings = data.settings || {};
        settings.autoLoggingEnabled = STATE.autoLoggingEnabled;
        chrome.storage.local.set({ settings });
      });
      forwardToActiveTab({ type: 'CMD_SET_AUTO_LOGGING', payload });
      sendResponse({ success: true, autoLoggingEnabled: STATE.autoLoggingEnabled });
      break;

    case 'STATUS_UPDATE':
      if (payload) {
        Object.assign(STATE.lastKnownStatus, payload);
      }
      sendResponse({ success: true });
      break;

    case 'REQUEST_TAB_CAPTURE_STREAM_ID':
      // Generates streamId for tab capture fallback
      chrome.tabCapture.getMediaStreamId({ targetTabId: sender?.tab?.id }, (streamId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, streamId });
        }
      });
      return true;

    case 'LOCAL_TRAINING_REQUEST':
      handleLocalTrainingRequest(payload)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'CAPTURE_TAB_FRAME': {
      // Captures rendered viewport pixels bypassing CORS restrictions on <video> elements
      const winId = sender?.tab?.windowId || null;
      try {
        chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 80 }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ success: true, dataUrl });
          }
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true;
    }

    default:
      sendResponse({ success: false, error: `Unknown message type: ${type}` });
  }
});

async function handleLocalTrainingRequest(payload) {
  const allowedEndpoints = ['/training-config', '/training-samples'];
  if (!payload || !allowedEndpoints.includes(payload.endpoint)) {
    throw new Error('Unsupported local training endpoint.');
  }

  const response = await fetch(`http://127.0.0.1:8000${payload.endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload.body)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `Local training backend returned HTTP ${response.status}.`);
  }
  return result;
}

async function handleStartDetection(tabIdFromSender, payload) {
  let targetTabId = tabIdFromSender;

  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) throw new Error('No active tab found.');
    targetTabId = activeTab.id;
  }

  STATE.activeTabId = targetTabId;
  STATE.isDetecting = true;
  STATE.isPaused = false;

  // Send start command to content script in the target tab with injection fallback
  try {
    const response = await chrome.tabs.sendMessage(targetTabId, {
      type: 'CMD_START',
      payload
    });
    return response || { success: true };
  } catch (err) {
    if (chrome.scripting) {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: targetTabId },
          files: ['content/content.css']
        });
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          files: ['detector/ort/ort.min.js', 'content/content.js']
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        const retryResponse = await chrome.tabs.sendMessage(targetTabId, {
          type: 'CMD_START',
          payload
        });
        return retryResponse || { success: true };
      } catch (injectErr) {
        throw new Error(`Unable to inject vision into active tab: ${injectErr.message}`);
      }
    }
    throw err;
  }
}

async function handleStopDetection() {
  STATE.isDetecting = false;
  STATE.isPaused = false;

  if (STATE.activeTabId) {
    try {
      await chrome.tabs.sendMessage(STATE.activeTabId, { type: 'CMD_STOP' });
    } catch (e) {
      // Tab might have been closed
    }
  }

  return { success: true };
}

function forwardToActiveTab(msg) {
  if (STATE.activeTabId) {
    chrome.tabs.sendMessage(STATE.activeTabId, msg).catch(() => {});
  }
}
