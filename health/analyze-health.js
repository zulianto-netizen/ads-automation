#!/usr/bin/env node
'use strict';

/**
 * Read the JSON archive written by pull-coros.js and produce a training/health
 * readout: load balance, recovery signals, volume trend and fitness markers.
 *
 *   node health/analyze-health.js [--data DIR] [--weeks N] [--json]
 *
 * Every threshold used here is stated in THRESHOLDS below rather than buried in
 * the logic, because they are conventions from the endurance-training
 * literature, not facts about you -- adjust them once you know your own norms.
 */

const fs = require('fs');
const path = require('path');

const THRESHOLDS = {
  // Acute:chronic workload ratio. The 0.8-1.3 "sweet spot" and the >1.5 spike
  // zone are the common convention; treat them as a prompt to look, not a verdict.
  acwrLow: 0.8,
  acwrHigh: 1.3,
  acwrSpike: 1.5,
  // Resting HR this far above your own 28-day baseline is the classic marker of
  // accumulated fatigue, poor sleep, or an infection starting.
  rhrElevatedPct: 5,
  // HRV below (baseline - 1 SD) suggests the nervous system has not recovered.
  hrvSdBelow: 1,
  // A week this much bigger than the prior one is where injury risk climbs.
  volumeJumpPct: 30,
};

function parseArgs(argv) {
  const args = { data: path.join(__dirname, 'data'), weeks: 12, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--weeks') args.weeks = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function load(dir, name, fallback) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`warning: could not parse ${name}: ${err.message}`);
    return fallback;
  }
}

// --- small stats helpers -------------------------------------------------

const nums = (xs) => xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);
const round = (x, n = 1) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(n)) : null);

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Least-squares slope per step; used to say whether a metric is drifting. */
function slope(xs) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (xs[i] - my);
    den += (i - mx) ** 2;
  }
  return den ? num / den : null;
}

const dayToDate = (d) => {
  const s = String(d);
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
};

/** ISO week key, so weeks group the same way regardless of locale. */
function weekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const fmtDur = (sec) => {
  if (!sec) return '0h00';
  // Round to whole minutes first: rounding h and m independently can print "2h60".
  const totalMin = Math.round(sec / 60);
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}`;
};

const fmtKm = (m) => (m ? (m / 1000).toFixed(1) : '0.0');

// --- analysis ------------------------------------------------------------

function analyseLoad(daily) {
  const recent = daily.slice(-42);
  if (!recent.length) return null;

  const latest = [...recent].reverse().find((d) => d.ati != null || d.cti != null) || {};
  const atl = latest.ati;
  const ctl = latest.cti;
  // Prefer the ratio COROS itself reports; fall back to computing it.
  const ratio = latest.trainingLoadRatio != null
    ? latest.trainingLoadRatio
    : atl != null && ctl ? atl / ctl : null;

  let status = 'unknown';
  let note = 'Not enough load data yet.';
  if (ratio != null) {
    if (ratio > THRESHOLDS.acwrSpike) {
      status = 'spike';
      note = 'Acute load is far above your chronic base -- this is the highest-risk pattern for injury. Back off this week.';
    } else if (ratio > THRESHOLDS.acwrHigh) {
      status = 'building-fast';
      note = 'Building faster than the usual safe band. Fine briefly, risky if it holds for weeks.';
    } else if (ratio < THRESHOLDS.acwrLow) {
      status = 'detraining';
      note = 'Acute load has dropped below your base -- either a deliberate taper, or fitness is slipping.';
    } else {
      status = 'optimal';
      note = 'Load is in the sweet spot: progressing without outrunning your base.';
    }
  }

  return {
    atl: round(atl), ctl: round(ctl), ratio: round(ratio, 2), status, note,
    fatigue: round(latest.tiredRateNew),
    performance: round(latest.performance),
    date: latest.happenDay || null,
  };
}

function analyseRhr(daily) {
  const series = daily.filter((d) => d.rhr != null);
  if (series.length < 7) return null;
  const recent = nums(series.slice(-7).map((d) => d.rhr));
  const baseline = nums(series.slice(-28).map((d) => d.rhr));
  const r = mean(recent);
  const b = mean(baseline);
  const delta = pct(r, b);
  const elevated = delta != null && delta > THRESHOLDS.rhrElevatedPct;
  return {
    recent7d: round(r), baseline28d: round(b), deltaPct: round(delta), elevated,
    trend: round(slope(nums(series.slice(-28).map((d) => d.rhr))), 3),
    note: elevated
      ? `Resting HR is ${round(delta)}% above your 28-day baseline. That usually means accumulated fatigue, short sleep, or something coming on -- keep it easy until it settles.`
      : 'Resting heart rate is sitting at its normal level.',
  };
}

function analyseHrv(dashboard, daily) {
  const fromDash = ((dashboard.summaryInfo || {}).sleepHrvData || {}).sleepHrvList || [];
  const list = fromDash.length ? fromDash : daily.filter((d) => d.avgSleepHrv != null);
  if (!list.length) return null;

  const latest = [...list].reverse().find((d) => (d.avgSleepHrv ?? null) != null);
  if (!latest) return null;

  const value = latest.avgSleepHrv;
  const base = latest.sleepHrvBase ?? latest.baseline;
  const sd = latest.sleepHrvSd ?? stdev(nums(list.map((d) => d.avgSleepHrv)));
  const low = base != null && sd != null && value < base - THRESHOLDS.hrvSdBelow * sd;

  return {
    latest: round(value), baseline: round(base), sd: round(sd), belowBaseline: low,
    nights: list.length,
    date: latest.happenDay || null,
    note: low
      ? 'Overnight HRV is below your baseline band -- your nervous system has not recovered. Prioritise sleep and keep intensity low today.'
      : 'Overnight HRV is within your normal band.',
  };
}

function analyseVolume(activities, weeks) {
  const byWeek = new Map();
  for (const a of activities) {
    const ts = a.startTimestamp || a.startTime;
    if (!ts) continue;
    const date = new Date(ts < 1e12 ? ts * 1000 : ts);
    if (Number.isNaN(date.getTime())) continue;
    const key = weekKey(date);
    if (!byWeek.has(key)) byWeek.set(key, { week: key, count: 0, distance: 0, duration: 0, sports: {} });
    const w = byWeek.get(key);
    w.count++;
    w.distance += a.distance || 0;
    w.duration += a.totalTime || a.duration || 0;
    w.sports[a.sportName || a.sportType] = (w.sports[a.sportName || a.sportType] || 0) + 1;
  }

  const all = [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week));
  const thisWeek = weekKey(new Date());
  for (const w of all) w.partial = w.week === thisWeek;

  const recent = all.slice(-weeks);
  // The in-progress week is always short, so including it would mask a real
  // jump (or invent a fake drop). Compare complete weeks only.
  const complete = recent.filter((w) => !w.partial);
  if (complete.length < 2) return { weeks: recent, jump: null, trend: null, bigJump: false };

  const last = complete[complete.length - 1];
  const prev = complete[complete.length - 2];
  const jump = pct(last.duration, prev.duration);

  return {
    weeks: recent,
    lastCompleteWeek: last.week,
    jump: round(jump),
    bigJump: jump != null && jump > THRESHOLDS.volumeJumpPct,
    trend: round(slope(complete.map((w) => w.duration / 3600)), 2),
  };
}

function analyseFitness(daily, summary) {
  const vo2 = daily.filter((d) => d.vo2max != null);
  const latest = vo2.length ? vo2[vo2.length - 1] : null;
  const first = vo2.length ? vo2[0] : null;
  return {
    vo2max: latest ? round(latest.vo2max) : null,
    vo2maxChange: latest && first ? round(latest.vo2max - first.vo2max) : null,
    lthr: latest ? round(latest.lthr) : null,
    ltsp: latest ? round(latest.ltsp, 2) : null,
    stamina: latest ? round(latest.staminaLevel) : null,
    racePredictions: (summary || {}).racePredictions || null,
  };
}

function analyseConsistency(activities, days = 28) {
  const cutoff = Date.now() - days * 86400000;
  const active = new Set();
  for (const a of activities) {
    const ts = a.startTimestamp || a.startTime;
    if (!ts) continue;
    const ms = ts < 1e12 ? ts * 1000 : ts;
    if (ms >= cutoff) active.add(new Date(ms).toDateString());
  }
  const trained = active.size;
  return {
    daysTrained: trained,
    windowDays: days,
    restDays: days - trained,
    note: trained === 0
      ? 'No activities recorded in the last 4 weeks.'
      : days - trained < 4
        ? 'Under 4 rest days in 4 weeks. Adaptation happens on the rest days -- this is too few.'
        : `${trained} training days and ${days - trained} rest days in the last 4 weeks.`,
  };
}

function buildFlags(a) {
  const flags = [];
  const add = (level, msg) => flags.push({ level, msg });

  if (a.load && a.load.status === 'spike') add('high', a.load.note);
  else if (a.load && a.load.status === 'building-fast') add('watch', a.load.note);
  else if (a.load && a.load.status === 'detraining') add('info', a.load.note);

  if (a.rhr && a.rhr.elevated) add('high', a.rhr.note);
  if (a.hrv && a.hrv.belowBaseline) add('watch', a.hrv.note);
  if (a.volume && a.volume.bigJump) {
    add('watch', `Training time jumped ${a.volume.jump}% in ${a.volume.lastCompleteWeek} versus the week before -- above the ~${THRESHOLDS.volumeJumpPct}% step where injury risk climbs.`);
  }
  if (a.consistency && a.consistency.restDays < 4 && a.consistency.daysTrained > 0) {
    add('watch', a.consistency.note);
  }
  if (a.consistency && a.consistency.daysTrained === 0) add('info', a.consistency.note);

  if (!flags.length) add('ok', 'No warning signals. Load, resting HR and HRV all read normal.');
  return flags;
}

// --- reporting -----------------------------------------------------------

const ICON = { high: '[!]', watch: '[~]', info: '[i]', ok: '[+]' };

function report(a) {
  const L = [];
  const line = (s = '') => L.push(s);
  const rule = () => line('-'.repeat(64));

  line();
  line('COROS HEALTH & TRAINING READOUT');
  line(`generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}   `
    + `data pulled ${(a.meta.pulledAt || 'unknown').slice(0, 10)}`);
  rule();

  line();
  line('SIGNALS');
  for (const f of a.flags) line(`  ${ICON[f.level]} ${f.msg}`);

  if (a.load) {
    line();
    line('TRAINING LOAD');
    line(`  acute (7d)      ${a.load.atl ?? '-'}`);
    line(`  chronic (42d)   ${a.load.ctl ?? '-'}`);
    line(`  ratio           ${a.load.ratio ?? '-'}   [${a.load.status}]  safe band ${THRESHOLDS.acwrLow}-${THRESHOLDS.acwrHigh}`);
    if (a.load.fatigue != null) line(`  fatigue         ${a.load.fatigue}`);
    if (a.load.performance != null) line(`  performance     ${a.load.performance}`);
    line(`  ${a.load.note}`);
  }

  if (a.rhr) {
    line();
    line('RESTING HEART RATE');
    line(`  last 7 days     ${a.rhr.recent7d} bpm`);
    line(`  28-day baseline ${a.rhr.baseline28d} bpm`);
    line(`  difference      ${a.rhr.deltaPct > 0 ? '+' : ''}${a.rhr.deltaPct}%`);
  }

  if (a.hrv) {
    line();
    line(`OVERNIGHT HRV  (${a.hrv.nights} nights)`);
    line(`  latest          ${a.hrv.latest} ms`);
    line(`  baseline        ${a.hrv.baseline ?? '-'} ms${a.hrv.sd != null ? `  (sd ${a.hrv.sd})` : ''}`);
  }

  if (a.fitness && a.fitness.vo2max != null) {
    line();
    line('FITNESS MARKERS');
    line(`  VO2max          ${a.fitness.vo2max}`
      + (a.fitness.vo2maxChange != null
        ? `  (${a.fitness.vo2maxChange >= 0 ? '+' : ''}${a.fitness.vo2maxChange} over the pulled range)` : ''));
    if (a.fitness.lthr != null) line(`  threshold HR    ${a.fitness.lthr} bpm`);
    if (a.fitness.stamina != null) line(`  stamina         ${a.fitness.stamina}`);
  }

  if (a.volume && a.volume.weeks.length) {
    line();
    line('WEEKLY VOLUME');
    line('  week       sessions      time      distance');
    for (const w of a.volume.weeks.slice(-12)) {
      line(`  ${w.week}   ${String(w.count).padStart(6)}   ${fmtDur(w.duration).padStart(9)}   ${fmtKm(w.distance).padStart(8)} km`
        + (w.partial ? '  (in progress)' : ''));
    }
    if (a.volume.trend != null) {
      line(`  trend: ${a.volume.trend >= 0 ? '+' : ''}${a.volume.trend} h/week`);
    }
  }

  line();
  line('CONSISTENCY (last 28 days)');
  line(`  ${a.consistency.note}`);

  if (a.meta.warnings && a.meta.warnings.length) {
    line();
    line('DATA GAPS');
    for (const w of a.meta.warnings) line(`  - ${w}`);
  }

  line();
  rule();
  line('Training data, not a medical assessment. Persistent elevated resting HR,');
  line('suppressed HRV or unexplained fatigue is worth a doctor, not a rest day.');
  line();
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.data)) {
    console.error(`No data directory at ${args.data}\nRun: node health/pull-coros.js`);
    process.exit(1);
  }

  const daily = load(args.data, 'daily.json', []);
  const activities = load(args.data, 'activities.json', []);
  const dashboard = load(args.data, 'dashboard.json', {});
  const summary = load(args.data, 'analyse-summary.json', {});
  const meta = load(args.data, 'meta.json', {});

  if (!daily.length && !activities.length) {
    console.error(`No data found in ${args.data}. Run: node health/pull-coros.js`);
    process.exit(1);
  }

  daily.sort((a, b) => String(a.happenDay).localeCompare(String(b.happenDay)));

  const analysis = {
    meta,
    load: analyseLoad(daily),
    rhr: analyseRhr(daily),
    hrv: analyseHrv(dashboard, daily),
    volume: analyseVolume(activities, args.weeks),
    fitness: analyseFitness(daily, summary),
    consistency: analyseConsistency(activities),
    counts: { days: daily.length, activities: activities.length },
  };
  analysis.flags = buildFlags(analysis);

  console.log(args.json ? JSON.stringify(analysis, null, 2) : report(analysis));
}

if (require.main === module) main();

module.exports = { analyseLoad, analyseRhr, analyseHrv, analyseVolume, analyseConsistency, buildFlags, THRESHOLDS, weekKey };
