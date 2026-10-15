/**
 * Popup Controller for PlayerNation AI Event Logger
 * Manages extension UI, button interactions, live telemetry polling, event reviews,
 * and JSON/CSV log exporting.
 */

import { formatMatchTime, parseMatchTime } from '../utils/timestamps.js';

// DOM Elements
const elements = {
  headerStatusBadge: document.getElementById('headerStatusBadge'),
  headerStatusText: document.getElementById('headerStatusText'),
  sourceDomainPill: document.getElementById('sourceDomainPill'),
  autoLogToggle: document.getElementById('autoLogToggle'),

  btnStart: document.getElementById('btnStart'),
  btnPause: document.getElementById('btnPause'),
  btnResume: document.getElementById('btnResume'),
  btnStop: document.getElementById('btnStop'),
  btnToggleHud: document.getElementById('btnToggleHud'),

  btnExportJson: document.getElementById('btnExportJson'),
  btnExportCsv: document.getElementById('btnExportCsv'),
  btnClearLogs: document.getElementById('btnClearLogs'),

  badgeLiveStream: document.getElementById('badgeLiveStream'),
  videoClockDisplay: document.getElementById('videoClockDisplay'),
  statVideoCapture: document.getElementById('statVideoCapture'),
  statVideoMeta: document.getElementById('statVideoMeta'),
  statModel: document.getElementById('statModel'),
  statModelMeta: document.getElementById('statModelMeta'),
  statSpeed: document.getElementById('statSpeed'),
  statLatency: document.getElementById('statLatency'),
  statFootball: document.getElementById('statFootball'),
  statFootballMeta: document.getElementById('statFootballMeta'),
  statPlayers: document.getElementById('statPlayers'),
  statTrackingMeta: document.getElementById('statTrackingMeta'),

  teamAColorInput: document.getElementById('teamAColorInput'),
  teamBColorInput: document.getElementById('teamBColorInput'),
  statTeamMeta: document.getElementById('statTeamMeta'),

  suggestionCount: document.getElementById('suggestionCount'),
  suggestionsContainer: document.getElementById('suggestionsContainer'),
  suggestionsEmpty: document.getElementById('suggestionsEmpty'),

  logFilterType: document.getElementById('logFilterType'),
  logTableBody: document.getElementById('logTableBody'),
  logEmptyRow: document.getElementById('logEmptyRow'),

  editModalOverlay: document.getElementById('editModalOverlay'),
  editEventForm: document.getElementById('editEventForm'),
  editEventId: document.getElementById('editEventId'),
  editMatchTime: document.getElementById('editMatchTime'),
  editEventType: document.getElementById('editEventType'),
  editTeam: document.getElementById('editTeam'),
  editPlayer: document.getElementById('editPlayer'),
  btnModalClose: document.getElementById('btnModalClose'),
  btnModalCancel: document.getElementById('btnModalCancel'),

  toastNotification: document.getElementById('toastNotification')
};

let currentTabId = null;
let pollIntervalId = null;
let cachedLogs = [];
let cachedSuggestions = [];

document.addEventListener('DOMContentLoaded', async () => {
  await initActiveTab();
  await loadSavedSettings();
  setupEventListeners();
  startStatusPolling();
  refreshLogs();
});

async function initActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentTabId = tab.id;
      if (tab.url) {
        try {
          const u = new URL(tab.url);
          const host = u.hostname || (u.protocol === 'file:' ? 'Local HTML File' : 'Current Tab');
          if (elements.sourceDomainPill) {
            elements.sourceDomainPill.textContent = `🌐 ${host.replace(/^www\./, '')}`;
          }
        } catch (e) {
          if (elements.sourceDomainPill) elements.sourceDomainPill.textContent = '🌐 Local Webpage';
        }
      }
    }
  } catch (err) {
    console.error('Error querying active tab:', err);
  }
}

async function ensureContentScriptInjected(tabId) {
  if (!chrome.scripting) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['detector/ort/ort.min.js', 'content/content.js']
    });
    await new Promise(r => setTimeout(r, 200));
  } catch (err) {
    console.warn('[Popup] Script injection check:', err.message);
  }
}

async function handleStart() {
  elements.btnStart.disabled = true;
  elements.btnStart.textContent = 'Connecting...';

  try {
    let res = await sendTabMessage({
      type: 'CMD_START',
      payload: {
        teamAColor: elements.teamAColorInput.value,
        teamBColor: elements.teamBColorInput.value,
        autoLogging: elements.autoLogToggle.checked
      }
    });

    // Auto-inject content script if the tab hasn't loaded it yet
    if (!res || !res.success) {
      if (currentTabId && (res?.error?.includes('Receiving end does not exist') || !res || res.error?.includes('Could not establish connection'))) {
        elements.btnStart.textContent = 'Injecting Vision...';
        await ensureContentScriptInjected(currentTabId);
        res = await sendTabMessage({
          type: 'CMD_START',
          payload: {
            teamAColor: elements.teamAColorInput.value,
            teamBColor: elements.teamBColorInput.value,
            autoLogging: elements.autoLogToggle.checked
          }
        });
      }
    }

    if (res && res.success) {
      setUiState('capturing');
      showToast('Capture and AI sports detection started');
    } else {
      showToast(res?.error || 'Failed to start. Check if video is loaded and playing.');
      setUiState('idle');
    }
  } catch (err) {
    showToast(`Error: ${err.message || 'Content script not responding. Refresh tab.'}`);
    setUiState('idle');
  }
}

async function handlePause() {
  await sendTabMessage({ type: 'CMD_PAUSE' });
  setUiState('paused');
  showToast('Detection paused');
}

async function handleResume() {
  await sendTabMessage({ type: 'CMD_RESUME' });
  setUiState('capturing');
  showToast('Detection resumed');
}

async function handleStop() {
  await sendTabMessage({ type: 'CMD_STOP' });
  setUiState('idle');
  showToast('Detection stopped');
}

function setUiState(state) {
  const dot = elements.headerStatusBadge.querySelector('.status-dot');
  dot.className = 'status-dot';

  switch (state) {
    case 'capturing':
      dot.classList.add('dot-active');
      elements.headerStatusText.textContent = 'DETECTING';
      elements.btnStart.style.display = 'none';
      elements.btnResume.style.display = 'none';
      elements.btnPause.style.display = 'inline-flex';
      elements.btnPause.disabled = false;
      elements.btnStop.disabled = false;
      break;

    case 'paused':
      dot.classList.add('dot-paused');
      elements.headerStatusText.textContent = 'PAUSED';
      elements.btnPause.style.display = 'none';
      elements.btnResume.style.display = 'inline-flex';
      elements.btnResume.disabled = false;
      elements.btnStop.disabled = false;
      break;

    case 'idle':
    default:
      dot.classList.add('dot-idle');
      elements.headerStatusText.textContent = 'IDLE';
      elements.btnStart.style.display = 'inline-flex';
      elements.btnStart.disabled = false;
      elements.btnStart.textContent = 'Start Detection';
      elements.btnPause.style.display = 'none';
      elements.btnResume.style.display = 'none';
      elements.btnStop.disabled = true;
      break;
  }
}

function updateTeamColors() {
  const teamAColor = elements.teamAColorInput.value;
  const teamBColor = elements.teamBColorInput.value;

  chrome.storage.local.get('settings', (data) => {
    const settings = data.settings || {};
    settings.teamAColor = teamAColor;
    settings.teamBColor = teamBColor;
    chrome.storage.local.set({ settings });
  });

  sendTabMessage({
    type: 'CMD_UPDATE_TEAM_COLORS',
    payload: { teamAColor, teamBColor }
  });
}

function startStatusPolling() {
  if (pollIntervalId) clearInterval(pollIntervalId);

  const poll = async () => {
    if (!currentTabId) return;
    try {
      const res = await sendTabMessage({ type: 'CMD_GET_STATUS' });
      if (res && res.success && res.telemetry) {
        updateTelemetry(res.telemetry);
      }
    } catch (e) {
      // Content script may be inactive or reloading
    }
  };

  poll();
  pollIntervalId = setInterval(poll, 600);
}

function updateTelemetry(telemetry) {
  if (telemetry.status === 'capturing') {
    setUiState('capturing');
  } else if (telemetry.status === 'paused') {
    setUiState('paused');
  } else if (telemetry.status === 'idle' || telemetry.status === 'stopped') {
    setUiState('idle');
  }

  // Live badge & Domain
  if (telemetry.isLive) {
    if (elements.badgeLiveStream) elements.badgeLiveStream.style.display = 'inline-block';
    if (elements.videoClockDisplay) elements.videoClockDisplay.style.color = '#ef4444';
  } else {
    if (elements.badgeLiveStream) elements.badgeLiveStream.style.display = 'none';
    if (elements.videoClockDisplay) elements.videoClockDisplay.style.color = 'var(--accent-football)';
  }

  if (telemetry.siteDomain && elements.sourceDomainPill) {
    elements.sourceDomainPill.textContent = `🌐 ${telemetry.siteDomain.replace(/^www\./, '')}`;
  }

  // Clock
  if (telemetry.currentTime != null) {
    elements.videoClockDisplay.textContent = formatMatchTime(telemetry.currentTime);
  }

  // Video status
  if (telemetry.videoFound) {
    if (telemetry.isCorsProtected) {
      elements.statVideoCapture.textContent = 'Protected Stream (HUD Active)';
      elements.statVideoCapture.style.color = 'var(--accent-amber)';
      elements.statVideoMeta.textContent = `${telemetry.videoWidth || 0}x${telemetry.videoHeight || 0} • In-page HUD enabled`;
    } else {
      const liveTag = telemetry.isLive ? ' • LIVE' : '';
      elements.statVideoCapture.textContent = telemetry.videoPaused ? 'Video Paused' : ('Capturing Active' + liveTag);
      elements.statVideoCapture.style.color = telemetry.videoPaused ? 'var(--accent-amber)' : (telemetry.isLive ? '#ef4444' : 'var(--accent-football)');
      elements.statVideoMeta.textContent = `${telemetry.videoWidth || 0}x${telemetry.videoHeight || 0} @ ${telemetry.playbackRate || 1}x`;
    }
  } else {
    elements.statVideoCapture.textContent = 'Searching Video...';
    elements.statVideoCapture.style.color = 'var(--text-dim)';
    elements.statVideoMeta.textContent = 'Open any web video or live stream';
  }

  // Model & speed
  elements.statModel.textContent = telemetry.modelName || 'YOLOv8n ONNX';
  elements.statModelMeta.textContent = telemetry.inferenceBackend || 'WASM / WebGPU';

  elements.statSpeed.textContent = `${(telemetry.fps || 0).toFixed(1)} FPS`;
  elements.statLatency.textContent = `${Math.round(telemetry.latencyMs || 0)} ms inference`;

  // Football
  if (telemetry.ballDetected) {
    elements.statFootball.textContent = 'Detected ⚽';
    elements.statFootball.style.color = 'var(--accent-football)';
    elements.statFootballMeta.textContent = `Conf: ${Math.round((telemetry.ballConfidence || 0) * 100)}%`;
  } else {
    elements.statFootball.textContent = 'Not Visible';
    elements.statFootball.style.color = 'var(--text-dim)';
    elements.statFootballMeta.textContent = `Lost: ${telemetry.ballLostFrames || 0} frames`;
  }

  // Players
  elements.statPlayers.textContent = `${telemetry.playersCount || 0} Players`;
  elements.statTrackingMeta.textContent = `Tracked objects: ${telemetry.trackedObjectsCount || 0}`;

  // Suggestions
  if (telemetry.pendingSuggestions && Array.isArray(telemetry.pendingSuggestions)) {
    cachedSuggestions = telemetry.pendingSuggestions;
    renderSuggestions();
  }

  // Sync logs if provided
  if (telemetry.latestLogs && Array.isArray(telemetry.latestLogs)) {
    cachedLogs = telemetry.latestLogs;
    renderLogTable();
  }
}

function renderSuggestions() {
  elements.suggestionCount.textContent = cachedSuggestions.length;

  if (cachedSuggestions.length === 0) {
    elements.suggestionsEmpty.style.display = 'block';
    // Clear out any old cards
    const cards = elements.suggestionsContainer.querySelectorAll('.suggestion-card');
    cards.forEach(c => c.remove());
    return;
  }

  elements.suggestionsEmpty.style.display = 'none';

  // Render cards
  const existingCardIds = new Set(Array.from(elements.suggestionsContainer.querySelectorAll('.suggestion-card')).map(c => c.dataset.id));
  const newIds = new Set(cachedSuggestions.map(s => s.id));

  // Remove stale cards
  elements.suggestionsContainer.querySelectorAll('.suggestion-card').forEach(card => {
    if (!newIds.has(card.dataset.id)) card.remove();
  });

  // Add / update cards
  cachedSuggestions.forEach(sugg => {
    let card = elements.suggestionsContainer.querySelector(`[data-id="${sugg.id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'suggestion-card';
      card.dataset.id = sugg.id;
      elements.suggestionsContainer.appendChild(card);
    }

    const confPct = Math.round((sugg.confidence || 0) * 100);
    const evidenceList = Array.isArray(sugg.evidence) ? sugg.evidence.map(e => `<li>${e}</li>`).join('') : '';

    card.innerHTML = `
      <div class="sugg-header">
        <div class="sugg-title-group">
          <span class="sugg-time">${formatMatchTime(sugg.matchTimestamp)}</span>
          <span class="sugg-type">${sugg.eventType}</span>
          <span class="sugg-team">${sugg.team || 'Unknown'}</span>
          ${sugg.playerId ? `<span class="sugg-team">${sugg.playerId}</span>` : ''}
        </div>
        <span class="sugg-conf">${confPct}%</span>
      </div>
      <ul class="sugg-evidence">${evidenceList}</ul>
      <div class="sugg-actions">
        <button class="btn btn-confirm" data-id="${sugg.id}">Confirm (Log)</button>
        <button class="btn btn-reject" data-id="${sugg.id}">Reject</button>
        <button class="btn btn-edit" data-id="${sugg.id}">Edit</button>
      </div>
    `;

    card.querySelector('.btn-confirm').onclick = () => confirmSuggestion(sugg.id);
    card.querySelector('.btn-reject').onclick = () => rejectSuggestion(sugg.id);
    card.querySelector('.btn-edit').onclick = () => openEditModal(sugg);
  });
}

async function confirmSuggestion(suggestionId) {
  const res = await sendTabMessage({
    type: 'CMD_CONFIRM_SUGGESTION',
    payload: { id: suggestionId }
  });
  if (res && res.success) {
    showToast('Event confirmed and registered');
    refreshLogs();
  }
}

async function rejectSuggestion(suggestionId) {
  const res = await sendTabMessage({
    type: 'CMD_REJECT_SUGGESTION',
    payload: { id: suggestionId }
  });
  if (res && res.success) {
    showToast('Event rejected');
  }
}

function refreshLogs() {
  chrome.storage.local.get('eventLogs', (data) => {
    if (Array.isArray(data.eventLogs)) {
      cachedLogs = data.eventLogs;
      renderLogTable();
    }
  });
}

function renderLogTable() {
  const filter = elements.logFilterType.value;
  const filtered = filter === 'ALL' ? cachedLogs : cachedLogs.filter(e => e.eventType === filter);

  if (filtered.length === 0) {
    elements.logTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">No match events match the filter.</td>
      </tr>
    `;
    return;
  }

  elements.logTableBody.innerHTML = '';
  // Sort descending by timestamp
  const sorted = [...filtered].sort((a, b) => b.matchTimestamp - a.matchTimestamp);

  sorted.forEach(log => {
    const tr = document.createElement('tr');
    const confPct = Math.round((log.confidence || 0) * 100);
    const statusClass = `status-${(log.status || 'review').toLowerCase()}`;

    tr.innerHTML = `
      <td class="mono font-bold">${formatMatchTime(log.matchTimestamp)}</td>
      <td><strong>${log.eventType}</strong></td>
      <td>${log.team || 'Unknown'}</td>
      <td>${log.playerId || 'Unknown'}</td>
      <td class="mono">${confPct}%</td>
      <td><span class="status-badge ${statusClass}">${log.status}</span></td>
      <td>
        <button class="btn btn-sm btn-outline btn-table-edit" data-id="${log.id}">Edit</button>
      </td>
    `;

    tr.querySelector('.btn-table-edit').onclick = () => openEditModal(log);
    elements.logTableBody.appendChild(tr);
  });
}

function openEditModal(item) {
  elements.editEventId.value = item.id;
  elements.editMatchTime.value = formatMatchTime(item.matchTimestamp);
  elements.editEventType.value = item.eventType;
  elements.editTeam.value = item.team || 'Unknown';
  elements.editPlayer.value = item.playerId || '';
  elements.editModalOverlay.style.display = 'flex';
}

function closeModal() {
  elements.editModalOverlay.style.display = 'none';
}

function handleModalSave(e) {
  e.preventDefault();
  const id = elements.editEventId.value;
  const updatedSeconds = parseMatchTime(elements.editMatchTime.value);
  const updatedType = elements.editEventType.value;
  const updatedTeam = elements.editTeam.value;
  const updatedPlayer = elements.editPlayer.value.trim() || 'Unknown';

  sendTabMessage({
    type: 'CMD_UPDATE_EVENT',
    payload: {
      id,
      matchTimestamp: updatedSeconds,
      eventType: updatedType,
      team: updatedTeam,
      playerId: updatedPlayer
    }
  }).then(() => {
    closeModal();
    showToast('Event updated successfully');
    refreshLogs();
  });
}

function exportLogsAsJson() {
  if (cachedLogs.length === 0) {
    showToast('No events available to export.');
    return;
  }

  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(cachedLogs, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  downloadAnchor.setAttribute('download', `playernation_events_${Date.now()}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  showToast('JSON log exported');
}

function exportLogsAsCsv() {
  if (cachedLogs.length === 0) {
    showToast('No events available to export.');
    return;
  }

  const headers = ['Match Time', 'Event Type', 'Team', 'Player', 'Confidence', 'Status', 'Timestamp Seconds'];
  const rows = cachedLogs.map(log => [
    `"${formatMatchTime(log.matchTimestamp)}"`,
    `"${log.eventType}"`,
    `"${log.team || 'Unknown'}"`,
    `"${log.playerId || 'Unknown'}"`,
    `"${Math.round((log.confidence || 0) * 100)}%"`,
    `"${log.status}"`,
    log.matchTimestamp
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', encodeURI(csvContent));
  downloadAnchor.setAttribute('download', `playernation_events_${Date.now()}.csv`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  showToast('CSV log exported');
}

function clearAllLogs() {
  if (confirm('Are you sure you want to clear all match event logs?')) {
    chrome.storage.local.set({ eventLogs: [] }, () => {
      cachedLogs = [];
      renderLogTable();
      sendTabMessage({ type: 'CMD_CLEAR_LOGS' });
      showToast('All logs cleared');
    });
  }
}

function showToast(message) {
  elements.toastNotification.textContent = message;
  elements.toastNotification.style.display = 'block';
  setTimeout(() => {
    elements.toastNotification.style.display = 'none';
  }, 2500);
}

function sendTabMessage(msg) {
  if (!currentTabId) return Promise.reject(new Error('No active tab'));
  return chrome.tabs.sendMessage(currentTabId, msg).catch((err) => {
    console.warn('Tab message failed:', err);
    return { success: false, error: err.message };
  });
}
