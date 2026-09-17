import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FIELD } from '../shared/simulation.js';

const round = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));
const planarSpeed = body => Math.hypot(body.velocity.x, body.velocity.z);
const planarDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const shortHash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
// Algorithm provenance is separate from the persisted metric-column schema.
export const METRICS_VERSION = 'nova-metrics-3';
function geometryMetadata(field = FIELD) {
  if (!field || typeof field !== 'object' || Array.isArray(field) ||
      ['halfX', 'goalHalf', 'goalHeight'].some(key => !Object.hasOwn(field, key)) ||
      Object.values(field).some(value => !Number.isFinite(value) || value <= 0)) {
    throw new TypeError('field geometry must contain positive finite halfX, goalHalf and goalHeight dimensions');
  }
  const snapshot = Object.freeze(Object.fromEntries(Object.keys(field).sort().map(key => [key, field[key]])));
  return { field: snapshot, geometryHash: shortHash(JSON.stringify(snapshot)), metricsVersion: METRICS_VERSION };
}

const threatensGoal = (position, velocity, team, field) => {
  const ownGoalX = team === 0 ? -field.halfX : field.halfX;
  if ((ownGoalX - position.x) * velocity.x <= 0 || Math.abs(velocity.x) < 1) return false;
  const time = (ownGoalX - position.x) / velocity.x;
  const projectedZ = position.z + velocity.z * time;
  const projectedY = position.y + velocity.y * time;
  return time >= 0 && time <= 4 && Math.abs(projectedZ) <= field.goalHalf && projectedY <= field.goalHeight;
};

export function isOpenGoalMiss(ball, attackingTeam, opponents = [], field = FIELD) {
  const attack = attackingTeam === 0 ? 1 : -1;
  const goalX = attack * field.halfX;
  if (attack * ball.position.x <= 0 || attack * ball.velocity.x <= 6) return false;
  const time = (goalX - ball.position.x) / ball.velocity.x;
  if (time <= 0 || time > 4) return false;
  const projectedZ = ball.position.z + ball.velocity.z * time;
  const projectedY = ball.position.y + ball.velocity.y * time;
  const missesGoal = Math.abs(projectedZ) > field.goalHalf || projectedY > field.goalHeight;
  if (!missesGoal) return false;
  return !opponents.some(opponent => {
    if (opponent.team === attackingTeam) return false;
    return Math.hypot(opponent.position.x - goalX, opponent.position.z) <= 24;
  });
};

export function buildVersionMetadata({
  source,
  nova1Version,
  nova2Version,
  nova3Version,
  controllerVersions,
  controllerSources = {},
  simulationVersion,
  physicsVersion,
  arenaVersion,
  metricsSchemaVersion = 2,
  evaluatorProtocolVersion = 1,
  field = FIELD
}) {
  const versions = controllerVersions || {
    1: nova1Version,
    2: nova2Version,
    ...(nova3Version ? { 3: nova3Version } : {})
  };
  const controllers = Object.fromEntries(Object.entries(versions).map(([id, version]) => [id, {
    family: `nova${id}`,
    version,
    hash: shortHash(`${version}\n${controllerSources[id] || source}`)
  }]));
  return {
    controllers,
    nova1: controllers['1'],
    nova2: controllers['2'],
    ...(controllers['3'] ? { nova3: controllers['3'] } : {}),
    simulationVersion,
    simulationHash: shortHash(source),
    physicsVersion,
    arenaVersion,
    metricsSchemaVersion,
    evaluatorProtocolVersion,
    ...geometryMetadata(field)
  };
}

function blankModel(player, metadata) {
  const controllerId = player.controllerId ?? player.aiVersion;
  const identity = metadata.controllers?.[String(controllerId)] || (player.aiVersion === 1 ? metadata.nova1 : metadata.nova2);
  if (!identity) throw new Error(`missing controller metadata for controller ${controllerId}`);
  return {
    id: player.id,
    team: player.team,
    version: identity.version,
    modelHash: identity.hash,
    opponentVersion: '',
    opponentHash: '',
    won: false,
    goalsFor: 0,
    goalsAgainst: 0,
    ownGoals: 0,
    contacts: 0,
    usefulContacts: 0,
    harmfulContacts: 0,
    shots: 0,
    shotsOnTarget: 0,
    firstTouches: 0,
    kickoffWins: 0,
    firstTouchTimes: [],
    possessionSeconds: 0,
    distanceMeters: 0,
    speedSum: 0,
    speedSamples: 0,
    maxSpeed: 0,
    boostUsed: 0,
    boostCollected: 0,
    collisions: 0,
    jumpCommands: 0,
    saves: 0,
    clearances: 0,
    ballProgressAfterContact: 0,
    openGoalMisses: 0,
    timeInOwnDangerZone: 0,
    recoverySeconds: 0,
    stateDurations: {},
    stateTransitions: {},
    previousPosition: { x: player.body.position.x, z: player.body.position.z },
    previousBoost: player.boost,
    previousState: player.aiState || `nova${player.aiVersion || 1}`,
    previousJump: false
  };
}

export class NovaMatchStats {
  constructor(metadata, { matchId = randomUUID(), startedAt = new Date().toISOString() } = {}) {
    this.metadata = { ...metadata, ...geometryMetadata(metadata.field) };
    this.field = this.metadata.field;
    this.matchId = matchId;
    this.startedAt = startedAt;
    this.ticks = 0;
    this.elapsed = 0;
    this.deadlocks = 0;
    this.nudges = 0;
    this.models = new Map();
    this.activeContacts = new Set();
    this.lastTouchId = null;
    this.lastTouchAt = -Infinity;
    this.awaitingFirstTouch = false;
    this.kickoffStartedAt = null;
    this.ballBefore = null;
    this.threatenedTeams = new Set();
    this.pendingProgress = new Map();
    this.beforeStatus = 'waiting';
  }

  beforeStep(simulation) {
    this.beforeStatus = simulation.status;
    this.ballBefore = {
      position: { x: simulation.ball.position.x, y: simulation.ball.position.y, z: simulation.ball.position.z },
      velocity: { x: simulation.ball.velocity.x, y: simulation.ball.velocity.y, z: simulation.ball.velocity.z }
    };
    this.threatenedTeams = new Set([0, 1].filter(team => threatensGoal(this.ballBefore.position, this.ballBefore.velocity, team, this.field)));
    for (const player of simulation.players.values()) {
      if (!this.models.has(player.id)) this.models.set(player.id, blankModel(player, this.metadata));
    }
  }

  #ballContact(simulation, player) {
    const stats = this.models.get(player.id);
    if (!stats) return;
    for (const [pendingId, pending] of this.pendingProgress) {
      const pendingStats = this.models.get(pendingId);
      if (pendingStats) pendingStats.ballProgressAfterContact += pending.attack * simulation.ball.position.x - pending.start;
    }
    this.pendingProgress.clear();
    stats.contacts++;
    this.lastTouchId = player.id;
    this.lastTouchAt = this.elapsed;
    const attackingDirection = player.team === 0 ? 1 : -1;
    const goalwardSpeed = simulation.ball.velocity.x * attackingDirection;
    const wasThreatened = this.threatenedTeams.has(player.team);
    const stillThreatened = threatensGoal(simulation.ball.position, simulation.ball.velocity, player.team, this.field);
    if (wasThreatened && !stillThreatened) stats.saves++;
    const wasDeepInOwnHalf = attackingDirection * (this.ballBefore?.position.x ?? simulation.ball.position.x) < -this.field.halfX * .55;
    if (wasDeepInOwnHalf && (goalwardSpeed > 1 || (wasThreatened && !stillThreatened))) stats.clearances++;
    this.pendingProgress.set(player.id, { elapsed: 0, start: attackingDirection * simulation.ball.position.x, attack: attackingDirection });
    if (goalwardSpeed > 1) stats.usefulContacts++;
    else if (goalwardSpeed < -1) stats.harmfulContacts++;
    if (goalwardSpeed > 6) {
      stats.shots++;
      const goalX = attackingDirection * this.field.halfX;
      const time = (goalX - simulation.ball.position.x) / simulation.ball.velocity.x;
      const projectedZ = simulation.ball.position.z + simulation.ball.velocity.z * Math.max(0, time);
      const projectedY = simulation.ball.position.y + simulation.ball.velocity.y * Math.max(0, time);
      if (time > 0 && projectedY <= this.field.goalHeight && Math.abs(projectedZ) <= this.field.goalHalf) stats.shotsOnTarget++;
      const opponents = [...simulation.players.values()].map(other => ({ team: other.team, position: other.body.position }));
      if (isOpenGoalMiss({ position: simulation.ball.position, velocity: simulation.ball.velocity }, player.team, opponents, this.field)) stats.openGoalMisses++;
    }
    if (this.awaitingFirstTouch) {
      stats.firstTouches++;
      stats.kickoffWins++;
      if (this.kickoffStartedAt !== null) stats.firstTouchTimes.push(this.elapsed - this.kickoffStartedAt);
      this.awaitingFirstTouch = false;
    }
  }

  #collectContacts(simulation) {
    const players = [...simulation.players.values()];
    const bodyToPlayer = new Map(players.map(player => [player.body, player]));
    const current = new Set();
    for (const contact of simulation.world.contacts || []) {
      const a = bodyToPlayer.get(contact.bi);
      const b = bodyToPlayer.get(contact.bj);
      const aIsBall = contact.bi === simulation.ball;
      const bIsBall = contact.bj === simulation.ball;
      if ((a && bIsBall) || (b && aIsBall)) {
        const player = a || b;
        const key = `ball:${player.id}`;
        current.add(key);
        if (!this.activeContacts.has(key)) this.#ballContact(simulation, player);
      } else if (a && b) {
        const ids = [a.id, b.id].sort();
        const key = `cars:${ids[0]}:${ids[1]}`;
        current.add(key);
        if (!this.activeContacts.has(key)) {
          this.models.get(a.id).collisions++;
          this.models.get(b.id).collisions++;
        }
      }
    }
    this.activeContacts = current;
  }

  afterStep(simulation, events, dt) {
    this.ticks++;
    this.elapsed += dt;
    this.#collectContacts(simulation);
    for (const [playerId, pending] of this.pendingProgress) {
      pending.elapsed += dt;
      if (pending.elapsed < 1) continue;
      const stats = this.models.get(playerId);
      if (stats) stats.ballProgressAfterContact += pending.attack * simulation.ball.position.x - pending.start;
      this.pendingProgress.delete(playerId);
    }
    const countdownReset = events.some(event => event.type === 'countdown' && event.value === 3);

    for (const player of simulation.players.values()) {
      const stats = this.models.get(player.id) || blankModel(player, this.metadata);
      this.models.set(player.id, stats);
      const distance = planarDistance(player.body.position, stats.previousPosition);
      if (distance < 10) stats.distanceMeters += distance;
      stats.previousPosition = { x: player.body.position.x, z: player.body.position.z };
      const speed = planarSpeed(player.body);
      stats.speedSum += speed;
      stats.speedSamples++;
      stats.maxSpeed = Math.max(stats.maxSpeed, speed);
      if (!countdownReset) {
        const boostDelta = player.boost - stats.previousBoost;
        if (boostDelta > 0) stats.boostCollected += boostDelta;
        else stats.boostUsed -= boostDelta;
      }
      stats.previousBoost = player.boost;
      const state = player.aiState || `nova${player.aiVersion || 1}`;
      stats.stateDurations[state] = (stats.stateDurations[state] || 0) + dt;
      if (stats.previousState !== state) {
        const transition = `${stats.previousState}->${state}`;
        stats.stateTransitions[transition] = (stats.stateTransitions[transition] || 0) + 1;
      }
      stats.previousState = state;
      const jump = Boolean(player.input?.jump);
      if (jump && !stats.previousJump) stats.jumpCommands++;
      stats.previousJump = jump;
      const attack = player.team === 0 ? 1 : -1;
      if (attack * simulation.ball.position.x < -this.field.halfX * .6) stats.timeInOwnDangerZone += dt;
      const up = player.body.quaternion.vmult({ x: 0, y: 1, z: 0 });
      if (player.body.position.y > 2.4 || up.y < .7) stats.recoverySeconds += dt;
    }

    const possessor = this.models.get(this.lastTouchId);
    const possessorPlayer = simulation.players.get(this.lastTouchId);
    if (possessor && possessorPlayer && this.elapsed - this.lastTouchAt <= 2.5 && planarDistance(possessorPlayer.body.position, simulation.ball.position) <= 15) {
      possessor.possessionSeconds += dt;
    }

    if (events.some(event => event.type === 'goal' || event.type === 'duelReset' || event.type === 'go' || (event.type === 'countdown' && event.value === 3))) this.pendingProgress.clear();
    for (const event of events) {
      if (event.type === 'go') {
        this.awaitingFirstTouch = true;
        this.kickoffStartedAt = this.elapsed;
      }
      if (event.type === 'duelReset') this.deadlocks++;
      if (event.type === 'duelNudge') this.nudges++;
      if (event.type === 'goal') {
        for (const [id, stats] of this.models) {
          if (stats.team === event.team) stats.goalsFor++;
          else stats.goalsAgainst++;
          if (id === this.lastTouchId && stats.team !== event.team) stats.ownGoals++;
        }
      }
    }
  }

  finalize(simulation, { endedAt = new Date().toISOString() } = {}) {
    const models = [...this.models.values()];
    for (const stats of models) {
      const opponent = models.find(other => other.team !== stats.team);
      stats.opponentVersion = opponent?.version || '';
      stats.opponentHash = opponent?.modelHash || '';
      stats.won = simulation.winner === stats.team;
    }
    return {
      matchId: this.matchId,
      startedAt: this.startedAt,
      endedAt,
      metadata: this.metadata,
      durationSeconds: round(this.elapsed),
      ticks: this.ticks,
      score: [...simulation.score],
      winner: simulation.winner,
      deadlocks: this.deadlocks,
      nudges: this.nudges,
      models: models.map(stats => ({
        ...stats,
        possessionSeconds: round(stats.possessionSeconds),
        distanceMeters: round(stats.distanceMeters),
        averageSpeed: round(stats.speedSamples ? stats.speedSum / stats.speedSamples : 0),
        maxSpeed: round(stats.maxSpeed),
        boostUsed: round(stats.boostUsed),
        boostCollected: round(stats.boostCollected),
        timeInOwnDangerZone: round(stats.timeInOwnDangerZone),
        recoverySeconds: round(stats.recoverySeconds),
        firstTouchTimes: stats.firstTouchTimes.map(value => round(value)),
        stateDurations: Object.fromEntries(Object.entries(stats.stateDurations).map(([key, value]) => [key, round(value)])),
        previousPosition: undefined,
        previousBoost: undefined,
        previousState: undefined,
        previousJump: undefined,
        speedSum: undefined,
        speedSamples: undefined
      }))
    };
  }
}

export class NovaStatsStore {
  constructor(databasePath) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
        duration_seconds REAL NOT NULL, ticks INTEGER NOT NULL,
        simulation_version TEXT NOT NULL, simulation_hash TEXT NOT NULL,
        physics_version TEXT NOT NULL, arena_version TEXT NOT NULL,
        nova1_version TEXT NOT NULL, nova1_hash TEXT NOT NULL,
        nova2_version TEXT NOT NULL, nova2_hash TEXT NOT NULL,
        score0 INTEGER NOT NULL, score1 INTEGER NOT NULL, winner INTEGER,
        deadlocks INTEGER NOT NULL, nudges INTEGER NOT NULL, summary_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_match_stats (
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL, team INTEGER NOT NULL,
        model_version TEXT NOT NULL, model_hash TEXT NOT NULL,
        opponent_version TEXT NOT NULL, opponent_hash TEXT NOT NULL,
        won INTEGER NOT NULL, goals_for INTEGER NOT NULL, goals_against INTEGER NOT NULL,
        own_goals INTEGER NOT NULL, contacts INTEGER NOT NULL,
        useful_contacts INTEGER NOT NULL, harmful_contacts INTEGER NOT NULL,
        shots INTEGER NOT NULL, shots_on_target INTEGER NOT NULL,
        first_touches INTEGER NOT NULL, possession_seconds REAL NOT NULL,
        distance_meters REAL NOT NULL, average_speed REAL NOT NULL, max_speed REAL NOT NULL,
        boost_used REAL NOT NULL, boost_collected REAL NOT NULL,
        collisions INTEGER NOT NULL, jump_commands INTEGER NOT NULL,
        state_durations_json TEXT NOT NULL, state_transitions_json TEXT NOT NULL,
        PRIMARY KEY (match_id, model_id)
      );
      CREATE INDEX IF NOT EXISTS model_version_matchup_idx
        ON model_match_stats(model_version, model_hash, opponent_version, opponent_hash);
    `);
    const modelColumns = new Set(this.db.prepare('PRAGMA table_info(model_match_stats)').all().map(column => column.name));
    const metricColumns = {
      saves: 'INTEGER NOT NULL DEFAULT 0',
      clearances: 'INTEGER NOT NULL DEFAULT 0',
      ball_progress_after_contact: 'REAL NOT NULL DEFAULT 0',
      open_goal_misses: 'INTEGER NOT NULL DEFAULT 0',
      time_in_own_danger_zone: 'REAL NOT NULL DEFAULT 0',
      recovery_seconds: 'REAL NOT NULL DEFAULT 0',
      kickoff_wins: 'INTEGER NOT NULL DEFAULT 0',
      first_touch_times_json: "TEXT NOT NULL DEFAULT '[]'"
    };
    for (const [column, definition] of Object.entries(metricColumns)) {
      if (!modelColumns.has(column)) this.db.exec(`ALTER TABLE model_match_stats ADD COLUMN ${column} ${definition}`);
    }
    const matchColumns = new Set(this.db.prepare('PRAGMA table_info(matches)').all().map(column => column.name));
    // Old rows remain explicitly unscoped; never relabel them with current geometry.
    if (!matchColumns.has('metrics_version')) this.db.exec("ALTER TABLE matches ADD COLUMN metrics_version TEXT NOT NULL DEFAULT 'legacy-unscoped'");
    if (!matchColumns.has('geometry_hash')) this.db.exec("ALTER TABLE matches ADD COLUMN geometry_hash TEXT NOT NULL DEFAULT 'unknown'");
    if (!matchColumns.has('metrics_schema_version')) this.db.exec('ALTER TABLE matches ADD COLUMN metrics_schema_version INTEGER NOT NULL DEFAULT 1');
    if (!matchColumns.has('evaluator_protocol_version')) this.db.exec('ALTER TABLE matches ADD COLUMN evaluator_protocol_version INTEGER NOT NULL DEFAULT 0');
  }

  saveMatch(record) {
    const insertMatch = this.db.prepare(`INSERT OR REPLACE INTO matches (
      id, started_at, ended_at, duration_seconds, ticks, simulation_version, simulation_hash,
      physics_version, arena_version, nova1_version, nova1_hash, nova2_version, nova2_hash,
      score0, score1, winner, deadlocks, nudges, summary_json, metrics_schema_version, evaluator_protocol_version, metrics_version, geometry_hash
    ) VALUES (${Array(23).fill('?').join(', ')})`);
    const insertModel = this.db.prepare(`INSERT OR REPLACE INTO model_match_stats (
      match_id, model_id, team, model_version, model_hash, opponent_version, opponent_hash,
      won, goals_for, goals_against, own_goals, contacts, useful_contacts, harmful_contacts,
      shots, shots_on_target, first_touches, possession_seconds, distance_meters, average_speed,
      max_speed, boost_used, boost_collected, collisions, jump_commands, state_durations_json,
      state_transitions_json, saves, clearances, ball_progress_after_contact, open_goal_misses,
      time_in_own_danger_zone, recovery_seconds, kickoff_wins, first_touch_times_json
    ) VALUES (${Array(35).fill('?').join(', ')})`);
    this.db.exec('BEGIN');
    try {
      const team0Model = record.models.find(model => model.team === 0);
      const team1Model = record.models.find(model => model.team === 1);
      const legacyNova1 = { version: team0Model?.version || 'unknown', hash: team0Model?.modelHash || 'unknown' };
      const legacyNova2 = { version: team1Model?.version || 'unknown', hash: team1Model?.modelHash || 'unknown' };
      insertMatch.run(
        record.matchId, record.startedAt, record.endedAt, record.durationSeconds, record.ticks,
        record.metadata.simulationVersion, record.metadata.simulationHash,
        record.metadata.physicsVersion, record.metadata.arenaVersion,
        legacyNova1.version, legacyNova1.hash,
        legacyNova2.version, legacyNova2.hash,
        record.score[0], record.score[1], record.winner, record.deadlocks, record.nudges,
        JSON.stringify(record), record.metadata.metricsSchemaVersion || 1,
        record.metadata.evaluatorProtocolVersion || 0,
        record.metadata.metricsVersion || 'legacy-unscoped', record.metadata.geometryHash || 'unknown'
      );
      for (const model of record.models) insertModel.run(
        record.matchId, model.id, model.team, model.version, model.modelHash,
        model.opponentVersion, model.opponentHash, model.won ? 1 : 0,
        model.goalsFor, model.goalsAgainst, model.ownGoals, model.contacts,
        model.usefulContacts, model.harmfulContacts, model.shots, model.shotsOnTarget,
        model.firstTouches, model.possessionSeconds, model.distanceMeters,
        model.averageSpeed, model.maxSpeed, model.boostUsed, model.boostCollected,
        model.collisions, model.jumpCommands, JSON.stringify(model.stateDurations),
        JSON.stringify(model.stateTransitions), model.saves || 0, model.clearances || 0,
        model.ballProgressAfterContact || 0, model.openGoalMisses || 0,
        model.timeInOwnDangerZone || 0, model.recoverySeconds || 0,
        model.kickoffWins || 0, JSON.stringify(model.firstTouchTimes || [])
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getDashboard({ recentLimit = 20 } = {}) {
    const totals = this.db.prepare(`SELECT COUNT(*) AS matches, COALESCE(SUM(duration_seconds), 0) AS simulatedSeconds,
      COALESCE(SUM(deadlocks), 0) AS deadlocks, COALESCE(SUM(score0 + score1), 0) AS goals FROM matches`).get();
    const versionMatchups = this.db.prepare(`SELECT
      p.model_version AS modelVersion, p.model_hash AS modelHash,
      p.opponent_version AS opponentVersion, p.opponent_hash AS opponentHash,
      m.simulation_version AS simulationVersion, m.physics_version AS physicsVersion, m.arena_version AS arenaVersion,
      m.simulation_hash AS simulationHash, m.metrics_version AS metricsVersion, m.geometry_hash AS geometryHash,
      m.metrics_schema_version AS metricsSchemaVersion, m.evaluator_protocol_version AS evaluatorProtocolVersion,
      COUNT(*) AS matches, SUM(p.won) AS wins, ROUND(AVG(p.won) * 100, 2) AS winRate,
      ROUND(AVG(p.goals_for), 3) AS goalsForPerMatch,
      ROUND(AVG(p.goals_against), 3) AS goalsAgainstPerMatch,
      ROUND(AVG(p.contacts), 3) AS contactsPerMatch,
      ROUND(AVG(CASE WHEN p.contacts > 0 THEN p.useful_contacts * 100.0 / p.contacts ELSE 0 END), 2) AS usefulContactRate,
      ROUND(AVG(p.shots), 3) AS shotsPerMatch,
      ROUND(AVG(CASE WHEN p.shots > 0 THEN p.goals_for * 100.0 / p.shots ELSE 0 END), 2) AS shotConversionRate,
      ROUND(AVG(p.possession_seconds), 3) AS possessionSecondsPerMatch,
      ROUND(AVG(p.distance_meters), 3) AS distancePerMatch,
      ROUND(AVG(p.average_speed), 3) AS averageSpeed,
      ROUND(MAX(p.max_speed), 3) AS maxSpeed,
      ROUND(AVG(p.boost_used), 3) AS boostUsedPerMatch,
      ROUND(AVG(p.collisions), 3) AS collisionsPerMatch,
      ROUND(AVG(p.saves), 3) AS savesPerMatch,
      ROUND(AVG(p.clearances), 3) AS clearancesPerMatch,
      ROUND(AVG(p.ball_progress_after_contact), 3) AS ballProgressPerMatch,
      ROUND(AVG(p.open_goal_misses), 3) AS openGoalMissesPerMatch,
      ROUND(AVG(p.time_in_own_danger_zone), 3) AS dangerSecondsPerMatch,
      ROUND(AVG(p.recovery_seconds), 3) AS recoverySecondsPerMatch,
      ROUND(AVG(p.kickoff_wins), 3) AS kickoffWinsPerMatch,
      ROUND(AVG(CASE WHEN p.shots > 0 THEN p.shots_on_target * 100.0 / p.shots ELSE 0 END), 2) AS onTargetShotRate
      FROM model_match_stats p JOIN matches m ON m.id = p.match_id
      GROUP BY p.model_version, p.model_hash, p.opponent_version, p.opponent_hash,
        m.simulation_version, m.physics_version, m.arena_version, m.simulation_hash,
        m.metrics_version, m.geometry_hash, m.metrics_schema_version, m.evaluator_protocol_version
      ORDER BY matches DESC, p.model_version`).all();
    const stateUsage = this.db.prepare(`SELECT m.model_version AS modelVersion, m.model_hash AS modelHash,
      m.opponent_version AS opponentVersion, m.opponent_hash AS opponentHash, x.simulation_version AS simulationVersion,
      x.physics_version AS physicsVersion, x.arena_version AS arenaVersion, j.key AS state,
      x.simulation_hash AS simulationHash, x.metrics_version AS metricsVersion, x.geometry_hash AS geometryHash,
      x.metrics_schema_version AS metricsSchemaVersion, x.evaluator_protocol_version AS evaluatorProtocolVersion,
      ROUND(SUM(CAST(j.value AS REAL)), 3) AS totalSeconds,
      ROUND(AVG(CAST(j.value AS REAL)), 3) AS secondsPerMatch
      FROM model_match_stats m JOIN matches x ON x.id = m.match_id, json_each(m.state_durations_json) j
      GROUP BY m.model_version, m.model_hash, m.opponent_version, m.opponent_hash,
        x.simulation_version, x.physics_version, x.arena_version, x.simulation_hash,
        x.metrics_version, x.geometry_hash, x.metrics_schema_version, x.evaluator_protocol_version, j.key
      ORDER BY m.model_version, totalSeconds DESC`).all();
    const stateTransitions = this.db.prepare(`SELECT m.model_version AS modelVersion, m.model_hash AS modelHash,
      m.opponent_version AS opponentVersion, m.opponent_hash AS opponentHash, x.simulation_version AS simulationVersion,
      x.physics_version AS physicsVersion, x.arena_version AS arenaVersion, j.key AS transition,
      x.simulation_hash AS simulationHash, x.metrics_version AS metricsVersion, x.geometry_hash AS geometryHash,
      x.metrics_schema_version AS metricsSchemaVersion, x.evaluator_protocol_version AS evaluatorProtocolVersion,
      SUM(CAST(j.value AS INTEGER)) AS total
      FROM model_match_stats m JOIN matches x ON x.id = m.match_id, json_each(m.state_transitions_json) j
      GROUP BY m.model_version, m.model_hash, m.opponent_version, m.opponent_hash,
        x.simulation_version, x.physics_version, x.arena_version, x.simulation_hash,
        x.metrics_version, x.geometry_hash, x.metrics_schema_version, x.evaluator_protocol_version, j.key
      ORDER BY m.model_version, total DESC`).all();
    const recentMatches = this.db.prepare(`SELECT id AS matchId, started_at AS startedAt,
      duration_seconds AS durationSeconds, nova1_version AS nova1Version,
      nova2_version AS nova2Version, score0, score1, winner, deadlocks,
      simulation_hash AS simulationHash, metrics_version AS metricsVersion, geometry_hash AS geometryHash,
      metrics_schema_version AS metricsSchemaVersion, evaluator_protocol_version AS evaluatorProtocolVersion
      FROM matches ORDER BY ended_at DESC LIMIT ?`).all(recentLimit);
    return { totals, versionMatchups, stateUsage, stateTransitions, recentMatches };
  }

  getMatch(matchId) {
    const row = this.db.prepare('SELECT summary_json AS summary FROM matches WHERE id = ?').get(matchId);
    return row ? JSON.parse(row.summary) : null;
  }

  close() { this.db.close(); }
}
