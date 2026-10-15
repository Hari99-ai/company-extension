import test from 'node:test';
import assert from 'node:assert/strict';
import { FootballEventAnalyzer } from '../events/event-analyzer.js';
import { isTrajectoryTowardGoal, isGoalLineCrossed } from '../events/event-rules.js';
import { eventsToJson, eventsToCsv } from '../logs/export.js';

test('isTrajectoryTowardGoal detects shots aimed at left and right goalmouths', () => {
  // Ball at center-left moving fast toward left goal
  const ballLeft = { cx: 0.35, cy: 0.50 };
  const shotLeft = isTrajectoryTowardGoal(ballLeft, -0.025, 0.0);
  assert.ok(shotLeft);
  assert.equal(shotLeft.targetGoal, 'left');

  // Ball at center-right moving fast toward right goal
  const ballRight = { cx: 0.65, cy: 0.50 };
  const shotRight = isTrajectoryTowardGoal(ballRight, 0.025, 0.0);
  assert.ok(shotRight);
  assert.equal(shotRight.targetGoal, 'right');

  // Slow lateral movement is NOT classified as a shot
  const slowBall = { cx: 0.50, cy: 0.50 };
  const notShot = isTrajectoryTowardGoal(slowBall, 0.003, 0.002);
  assert.equal(notShot, null);
});

test('isGoalLineCrossed detects ball passing over goal line within posts', () => {
  const trailCrossing = [
    { cx: 0.07, cy: 0.50, time: 10.0 },
    { cx: 0.04, cy: 0.50, time: 10.1 }
  ];
  const ballCrossing = { cx: 0.04, cy: 0.50 };

  const goal = isGoalLineCrossed(ballCrossing, trailCrossing);
  assert.ok(goal);
  assert.equal(goal.goalSide, 'left');
  assert.ok(goal.confidence >= 0.90);
});

test('FootballEventAnalyzer suppresses duplicate candidate events within dedupWindow', () => {
  const emittedEvents = [];
  const analyzer = new FootballEventAnalyzer({
    onEventCandidate: (evt) => emittedEvents.push(evt),
    dedupWindow: 2.5
  });

  const playerA = { id: 1, team: 'Team A', x: 0.3, y: 0.5, width: 0.05, height: 0.1 };
  const playerB = { id: 2, team: 'Team A', x: 0.6, y: 0.5, width: 0.05, height: 0.1 };

  // Frame 1: Player A has ball at t=10.0
  analyzer.processFrame(
    { ball: { cx: 0.3, cy: 0.5 }, vx: 0, vy: 0, speed: 0, trail: [], inPossessionPlayer: playerA },
    [playerA, playerB],
    10.0
  );

  // Frame 2: Player B receives ball at t=11.5 (Pass)
  analyzer.processFrame(
    { ball: { cx: 0.6, cy: 0.5 }, vx: 0.02, vy: 0, speed: 0.02, trail: [], inPossessionPlayer: playerB },
    [playerA, playerB],
    11.5
  );

  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].eventType, 'short-pass');

  // Frame 3: Next frame at t=11.6 still near player B (should NOT re-emit duplicate pass)
  analyzer.processFrame(
    { ball: { cx: 0.61, cy: 0.5 }, vx: 0.001, vy: 0, speed: 0.001, trail: [], inPossessionPlayer: playerB },
    [playerA, playerB],
    11.6
  );

  assert.equal(emittedEvents.length, 1); // Deduplicated
});

test('eventsToCsv and eventsToJson serialize structured logs cleanly', () => {
  const sampleEvents = [
    {
      id: 'evt_1',
      matchTimestamp: 506.4,
      eventType: 'shot',
      team: 'Team A',
      playerId: 'A9',
      confidence: 0.85,
      status: 'confirmed',
      evidence: ['High exit speed', 'Aimed at goal']
    }
  ];

  const jsonStr = eventsToJson(sampleEvents);
  assert.ok(jsonStr.includes('"eventType": "shot"'));

  const csvStr = eventsToCsv(sampleEvents);
  assert.ok(csvStr.includes('08:26'));
  assert.ok(csvStr.includes('Team A'));
  assert.ok(csvStr.includes('85%'));
});
