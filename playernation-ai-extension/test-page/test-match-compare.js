/**
 * PlayerNation Match Compare Test Simulation Engine
 * Powers dual pitch simulation streams, synchronized video controls,
 * local video file loaders, and action button audit logging.
 */

const video1 = document.getElementById('matchVideo1');
const video2 = document.getElementById('matchVideo2');
const card1 = document.getElementById('cardMatch1');
const card2 = document.getElementById('cardMatch2');
const tagActive1 = document.getElementById('tagActive1');
const tagActive2 = document.getElementById('tagActive2');
const telActiveVideo = document.getElementById('telActiveVideo');

const clock1 = document.getElementById('clockMatch1');
const clock2 = document.getElementById('clockMatch2');
const masterClock = document.getElementById('masterClockDisplay');
const masterScrubber = document.getElementById('masterScrubber');
const btnMasterPlayPause = document.getElementById('btnMasterPlayPause');
const btnToggleSync = document.getElementById('btnToggleSync');
const auditStream = document.getElementById('auditStream');

let isSyncLinked = true;
let isPlaying = true;
let activeVideoIndex = 1;

// 1. Focus / Switch active video handlers
function setActiveVideo(idx) {
  activeVideoIndex = idx;
  if (idx === 1) {
    card1.classList.add('is-active');
    card2.classList.remove('is-active');
    tagActive1.style.display = 'block';
    tagActive2.style.display = 'none';
    video1.setAttribute('data-active-player', 'true');
    video2.removeAttribute('data-active-player');
    video1.classList.add('active');
    video2.classList.remove('active');
    telActiveVideo.textContent = 'Video #1 (Match 454ba202)';
    telActiveVideo.style.color = '#10b981';
  } else {
    card2.classList.add('is-active');
    card1.classList.remove('is-active');
    tagActive2.style.display = 'block';
    tagActive1.style.display = 'none';
    video2.setAttribute('data-active-player', 'true');
    video1.removeAttribute('data-active-player');
    video2.classList.add('active');
    video1.classList.remove('active');
    telActiveVideo.textContent = 'Video #2 (Match a710594e)';
    telActiveVideo.style.color = '#38bdf8';
  }
}

video1.addEventListener('click', () => setActiveVideo(1));
video2.addEventListener('click', () => setActiveVideo(2));
document.getElementById('btnFocusMatch1').addEventListener('click', () => setActiveVideo(1));
document.getElementById('btnFocusMatch2').addEventListener('click', () => setActiveVideo(2));

// 2. Action buttons event logging & audit hooks
const actionButtons = [
  'short-passBtn',
  'long-passBtn',
  'shotBtn',
  'goalBtn',
  'defensive-actionBtn',
  'clearanceBtn',
  'saveBtn',
  'free-kickBtn',
  'cornerBtn',
  'penaltyBtn'
];

actionButtons.forEach(btnId => {
  const btn = document.getElementById(btnId);
  if (btn) {
    btn.addEventListener('click', () => {
      const timeStr = masterClock.textContent;
      const logEntry = document.createElement('div');
      logEntry.className = 'audit-log-line event-injected';
      logEntry.innerHTML = `<span>[${timeStr}]</span> <span>TRIGGERED: <strong>${btn.textContent.trim()}</strong> (#${btnId})</span>`;
      auditStream.prepend(logEntry);
    });
  }
});

// Keyboard shortcuts for quick event tagging matching PlayerNation
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const keyMap = {
    'p': 'short-passBtn',
    'l': 'long-passBtn',
    'x': 'shotBtn',
    'g': 'goalBtn',
    'e': 'defensive-actionBtn',
    'r': 'clearanceBtn',
    's': 'saveBtn',
    '2': 'free-kickBtn',
    'c': 'cornerBtn',
    'k': 'penaltyBtn'
  };
  const targetId = keyMap[e.key.toLowerCase()];
  if (targetId) {
    const btn = document.getElementById(targetId);
    if (btn) btn.click();
  }
});

// 3. Dual Pitch Canvas Simulations
function createPitchSimulator(canvasWidth, canvasHeight, teamAColor, teamBColor, teamAName, teamBName, speedFactor) {
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');

  let frame = 0;
  let ballX = canvasWidth / 2;
  let ballY = canvasHeight / 2;
  let ballVx = 4.0 * speedFactor;
  let ballVy = 2.4 * speedFactor;

  function render() {
    if (isPlaying) frame++;

    const totalSeconds = Math.floor(frame / 30);
    const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');

    // Field background
    ctx.fillStyle = '#142a17';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Subtle pitch grass stripes
    ctx.fillStyle = '#19331c';
    for (let x = 0; x < canvasWidth; x += 120) {
      if ((x / 120) % 2 === 0) ctx.fillRect(x, 0, 60, canvasHeight);
    }

    // Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 3;
    ctx.strokeRect(50, 30, canvasWidth - 100, canvasHeight - 60);

    // Halfway line & center circle
    ctx.beginPath();
    ctx.moveTo(canvasWidth / 2, 30);
    ctx.lineTo(canvasWidth / 2, canvasHeight - 30);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(canvasWidth / 2, canvasHeight / 2, 70, 0, Math.PI * 2);
    ctx.stroke();

    // Penalty Boxes
    ctx.strokeRect(50, 140, 140, canvasHeight - 280);
    ctx.strokeRect(canvasWidth - 190, 140, 140, canvasHeight - 280);

    // Goal mouth boxes
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 5;
    ctx.strokeRect(25, 220, 25, canvasHeight - 440);
    ctx.strokeRect(canvasWidth - 50, 220, 25, canvasHeight - 440);

    // Ball movement
    if (isPlaying) {
      ballX += ballVx;
      ballY += ballVy;
      if (ballX < 70 || ballX > canvasWidth - 70) ballVx *= -1;
      if (ballY < 50 || ballY > canvasHeight - 50) ballVy *= -1;
    }

    // Draw football
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ballX, ballY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Team A Players
    const teamAPos = [
      { x: canvasWidth * 0.25 + Math.sin(frame * 0.04) * 35, y: canvasHeight * 0.3 },
      { x: canvasWidth * 0.35 + Math.cos(frame * 0.03) * 25, y: canvasHeight * 0.5 },
      { x: canvasWidth * 0.42 + Math.sin(frame * 0.05) * 40, y: canvasHeight * 0.7 },
      { x: 100, y: canvasHeight / 2 } // Goalkeeper
    ];

    teamAPos.forEach((p, i) => {
      ctx.fillStyle = teamAColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText(`${teamAName[0]}${i + 1}`, p.x - 7, p.y + 3);
    });

    // Team B Players
    const teamBPos = [
      { x: canvasWidth * 0.75 + Math.cos(frame * 0.04) * 35, y: canvasHeight * 0.3 },
      { x: canvasWidth * 0.65 + Math.sin(frame * 0.03) * 25, y: canvasHeight * 0.5 },
      { x: canvasWidth * 0.58 + Math.cos(frame * 0.05) * 40, y: canvasHeight * 0.7 },
      { x: canvasWidth - 100, y: canvasHeight / 2 } // Goalkeeper
    ];

    teamBPos.forEach((p, i) => {
      ctx.fillStyle = teamBColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText(`${teamBName[0]}${i + 1}`, p.x - 7, p.y + 3);
    });

    // Match Time Banner in Corner
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(60, 40, 110, 26);
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(`${mm}:${ss}`, 72, 58);

    requestAnimationFrame(render);
  }

  render();
  return { canvas, getSeconds: () => Math.floor(frame / 30) };
}

// Instantiate Match 1 (White vs Red)
const sim1 = createPitchSimulator(1280, 720, '#f8fafc', '#dc2626', 'Alpha', 'Beta', 1.0);
if (sim1.canvas.captureStream) {
  video1.srcObject = sim1.canvas.captureStream(30);
}

// Instantiate Match 2 (Blue vs Yellow)
const sim2 = createPitchSimulator(1280, 720, '#0284c7', '#eab308', 'Gamma', 'Delta', 0.9);
if (sim2.canvas.captureStream) {
  video2.srcObject = sim2.canvas.captureStream(30);
}

// 4. Time synchronization loop
setInterval(() => {
  const s1 = sim1.getSeconds();
  const s2 = sim2.getSeconds();

  const mm1 = String(Math.floor(s1 / 60)).padStart(2, '0');
  const ss1 = String(s1 % 60).padStart(2, '0');
  clock1.textContent = `${mm1}:${ss1}`;

  const mm2 = String(Math.floor(s2 / 60)).padStart(2, '0');
  const ss2 = String(s2 % 60).padStart(2, '0');
  clock2.textContent = `${mm2}:${ss2}`;

  const curSec = activeVideoIndex === 1 ? s1 : s2;
  const mmm = String(Math.floor(curSec / 60)).padStart(2, '0');
  const sss = String(curSec % 60).padStart(2, '0');
  masterClock.textContent = `${mmm}:${sss}`;
  masterScrubber.value = curSec;
}, 300);

// 5. Play / Pause & Speed Controls
btnMasterPlayPause.addEventListener('click', () => {
  isPlaying = !isPlaying;
  btnMasterPlayPause.textContent = isPlaying ? '⏸ Pause Both' : '▶ Play Both';
  if (isPlaying) {
    if (video1.paused) video1.play();
    if (video2.paused) video2.play();
  } else {
    video1.pause();
    video2.pause();
  }
});

btnToggleSync.addEventListener('click', () => {
  isSyncLinked = !isSyncLinked;
  const badge = document.getElementById('syncStatusBadge');
  if (isSyncLinked) {
    badge.textContent = '⚡ DUAL SYNCHRONIZED PLAYBACK';
    badge.style.color = '#10b981';
    btnToggleSync.textContent = 'Unlink Sync';
  } else {
    badge.textContent = '⚡ INDEPENDENT PLAYBACK';
    badge.style.color = '#f59e0b';
    btnToggleSync.textContent = 'Link Sync';
  }
});

const speedButtons = [
  { id: 'btnSpeed05', speed: 0.5 },
  { id: 'btnSpeed1', speed: 1.0 },
  { id: 'btnSpeed15', speed: 1.5 },
  { id: 'btnSpeed2', speed: 2.0 }
];

speedButtons.forEach(({ id, speed }) => {
  const b = document.getElementById(id);
  if (b) {
    b.addEventListener('click', () => {
      speedButtons.forEach(sb => document.getElementById(sb.id)?.classList.remove('btn-blue'));
      b.classList.add('btn-blue');
      video1.playbackRate = speed;
      video2.playbackRate = speed;
    });
  }
});

// 6. Custom Local Video File Loaders
function setupFilePicker(pickerId, nameId, targetVideo, label) {
  const picker = document.getElementById(pickerId);
  const nameLabel = document.getElementById(nameId);

  picker.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      targetVideo.srcObject = null;
      targetVideo.src = url;
      targetVideo.play();
      nameLabel.textContent = `Loaded: ${file.name}`;
      nameLabel.style.color = '#10b981';

      const entry = document.createElement('div');
      entry.className = 'audit-log-line';
      entry.innerHTML = `<span>[File]</span> <span>Loaded ${label}: <strong>${file.name}</strong></span>`;
      auditStream.prepend(entry);
    }
  });
}

setupFilePicker('filePicker1', 'fileName1', video1, 'Match 1');
setupFilePicker('filePicker2', 'fileName2', video2, 'Match 2');

// Initial default state
setActiveVideo(1);
