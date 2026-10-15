/**
 * Test Match Simulation Generator
 * Generates an active football match video stream via Canvas captureStream
 * and instruments PlayerNation action buttons with audit logging.
 */

const video = document.getElementById('matchVideo');
const auditStream = document.getElementById('auditStream');
const simClock = document.getElementById('simClock');

// Action button audit hooks
const buttons = [
  'short-passBtn',
  'long-passBtn',
  'shotBtn',
  'goalBtn',
  'defensive-actionBtn',
  'clearanceBtn',
  'saveBtn',
  'free-kickBtn'
];

buttons.forEach(id => {
  const btn = document.getElementById(id);
  if (btn) {
    btn.addEventListener('click', () => {
      const timeStr = simClock.textContent;
      const logEntry = document.createElement('div');
      logEntry.style.color = '#38bdf8';
      logEntry.textContent = `[${timeStr}] Button #${id} TRIGGERED (${btn.textContent.trim()})`;
      auditStream.prepend(logEntry);
    });
  }
});

// Setup 1280x720 football pitch simulation stream
const pitchCanvas = document.createElement('canvas');
pitchCanvas.width = 1280;
pitchCanvas.height = 720;
const pctx = pitchCanvas.getContext('2d');

let frameCount = 0;
let ballX = 640;
let ballY = 360;
let ballVx = 3.5;
let ballVy = 2.0;

function drawPitchSimulation() {
  frameCount++;
  const matchSeconds = Math.floor(frameCount / 30);
  const mm = String(Math.floor(matchSeconds / 60)).padStart(2, '0');
  const ss = String(matchSeconds % 60).padStart(2, '0');
  simClock.textContent = `00:${mm}:${ss}`;

  // Grass
  pctx.fillStyle = '#1e3a1e';
  pctx.fillRect(0, 0, 1280, 720);

  // Field markings
  pctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  pctx.lineWidth = 4;
  pctx.strokeRect(60, 40, 1160, 640);

  // Halfway line & center circle
  pctx.beginPath();
  pctx.moveTo(640, 40);
  pctx.lineTo(640, 680);
  pctx.stroke();

  pctx.beginPath();
  pctx.arc(640, 360, 90, 0, Math.PI * 2);
  pctx.stroke();

  // Penalty areas
  pctx.strokeRect(60, 180, 180, 360);
  pctx.strokeRect(1040, 180, 180, 360);

  // Goals
  pctx.strokeStyle = '#f8fafc';
  pctx.lineWidth = 6;
  pctx.strokeRect(30, 280, 30, 160);
  pctx.strokeRect(1220, 280, 30, 160);

  // Move Ball
  ballX += ballVx;
  ballY += ballVy;
  if (ballX < 80 || ballX > 1200) ballVx *= -1;
  if (ballY < 60 || ballY > 660) ballVy *= -1;

  // Draw Ball
  pctx.fillStyle = '#ffffff';
  pctx.beginPath();
  pctx.arc(ballX, ballY, 9, 0, Math.PI * 2);
  pctx.fill();
  pctx.strokeStyle = '#000000';
  pctx.lineWidth = 2;
  pctx.stroke();

  // Draw Team A Players (White jerseys)
  const teamAPos = [
    { x: 300 + Math.sin(frameCount * 0.05) * 40, y: 220 },
    { x: 420 + Math.cos(frameCount * 0.04) * 30, y: 360 },
    { x: 500 + Math.sin(frameCount * 0.03) * 50, y: 500 },
    { x: 120, y: 360 } // Goalkeeper
  ];

  teamAPos.forEach((p, idx) => {
    // Body / Jersey (White)
    pctx.fillStyle = '#f8fafc';
    pctx.beginPath();
    pctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
    pctx.fill();
    pctx.strokeStyle = '#0284c7';
    pctx.lineWidth = 2;
    pctx.stroke();

    pctx.fillStyle = '#0f172a';
    pctx.font = 'bold 10px sans-serif';
    pctx.fillText(`A${idx + 1}`, p.x - 7, p.y + 4);
  });

  // Draw Team B Players (Red jerseys)
  const teamBPos = [
    { x: 900 + Math.cos(frameCount * 0.05) * 40, y: 240 },
    { x: 780 + Math.sin(frameCount * 0.04) * 30, y: 360 },
    { x: 700 + Math.cos(frameCount * 0.03) * 50, y: 480 },
    { x: 1160, y: 360 } // Goalkeeper
  ];

  teamBPos.forEach((p, idx) => {
    // Body / Jersey (Red)
    pctx.fillStyle = '#ef4444';
    pctx.beginPath();
    pctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
    pctx.fill();
    pctx.strokeStyle = '#f8fafc';
    pctx.lineWidth = 2;
    pctx.stroke();

    pctx.fillStyle = '#ffffff';
    pctx.font = 'bold 10px sans-serif';
    pctx.fillText(`B${idx + 1}`, p.x - 7, p.y + 4);
  });

  // Burn match time in video corner
  pctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  pctx.fillRect(80, 60, 140, 32);
  pctx.fillStyle = '#10b981';
  pctx.font = 'bold 16px monospace';
  pctx.fillText(`LIVE 00:${mm}:${ss}`, 90, 82);

  requestAnimationFrame(drawPitchSimulation);
}

drawPitchSimulation();

// Stream canvas to video element
if (pitchCanvas.captureStream) {
  const stream = pitchCanvas.captureStream(30);
  video.srcObject = stream;
}
