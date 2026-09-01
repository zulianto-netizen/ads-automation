#!/usr/bin/env node
'use strict';

/**
 * Pull the full COROS history into health/data/ as JSON.
 *
 * Run this on your own machine -- COROS domains are blocked from the Claude Code
 * remote sandbox, and this needs your account password.
 *
 *   COROS_EMAIL=you@example.com COROS_PASSWORD='...' node health/pull-coros.js
 *
 * Flags:
 *   --from YYYYMMDD   earliest day to pull        (default: 3 years back)
 *   --to   YYYYMMDD   latest day to pull          (default: today)
 *   --out  DIR        output directory            (default: health/data)
 *   --fit             also download .fit files    (COROS caps this at 50/day)
 *   --region us|eu|asia   skip auto-detection
 */

const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch { /* dotenv is optional here */ }

const { CorosClient, CorosError, SPORT_TYPES } = require('./coros-client');

// /analyse/dayDetail/query refuses ranges longer than ~24 weeks, so long
// histories are pulled in windows and stitched back together.
const MAX_WINDOW_DAYS = 160;

function parseArgs(argv) {
  const args = { fit: false, out: path.join(__dirname, 'data'), region: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fit') args.fit = true;
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const toDay = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

const fromDay = (s) =>
  new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));

function windows(startDay, endDay, size = MAX_WINDOW_DAYS) {
  const out = [];
  let cur = fromDay(startDay);
  const end = fromDay(endDay);
  while (cur <= end) {
    const stop = new Date(Math.min(new Date(cur).setDate(cur.getDate() + size - 1), end.getTime()));
    out.push([toDay(cur), toDay(stop)]);
    cur = new Date(stop);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function writeJson(dir, name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log(`  wrote ${name.padEnd(22)} ${String(Array.isArray(data) ? data.length : '-').padStart(6)} records  ${kb} KB`);
}

/** Never let a partial section abort the whole pull -- record the failure and move on. */
async function section(label, warnings, fn) {
  process.stdout.write(`\n[${label}]\n`);
  try {
    return await fn();
  } catch (err) {
    console.log(`  SKIPPED -- ${err.message}`);
    warnings.push(`${label}: ${err.message}`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    return;
  }

  const email = process.env.COROS_EMAIL;
  const password = process.env.COROS_PASSWORD;
  if (!email || !password) {
    console.error('Missing COROS_EMAIL / COROS_PASSWORD.\nSet them in .env or the environment. See health/README.md.');
    process.exit(1);
  }

  const today = new Date();
  const threeYearsBack = new Date(today);
  threeYearsBack.setFullYear(today.getFullYear() - 3);

  const from = args.from || toDay(threeYearsBack);
  const to = args.to || toDay(today);

  fs.mkdirSync(args.out, { recursive: true });

  const client = new CorosClient();
  const warnings = [];

  console.log(`COROS pull  ${from} -> ${to}`);
  process.stdout.write('\n[auth] ');
  const auth = args.region
    ? await client.login(email, password, args.region)
    : await client.loginAutoRegion(email, password);
  console.log(`logged in (region=${auth.region}, userId=${auth.userId})`);
  console.log('  note: this invalidates any t.coros.com browser session, and vice versa.');

  // --- activities ---
  const activities = await section('activities', warnings, async () => {
    const list = await client.allActivities({
      from,
      to,
      onPage: (page, total) => process.stdout.write(`  page ${page} -> ${total} activities\r`),
    });
    process.stdout.write('\n');
    const enriched = list.map((a) => ({ ...a, sportName: SPORT_TYPES[a.sportType] || `Sport ${a.sportType}` }));
    writeJson(args.out, 'activities.json', enriched);
    return enriched;
  });

  // --- daily health metrics ---
  await section('daily metrics (RHR, load, ATL/CTL, stamina)', warnings, async () => {
    const days = [];
    for (const [s, e] of windows(from, to)) {
      process.stdout.write(`  ${s}-${e}\r`);
      const data = await client.analyseDetail(s, e);
      days.push(...(data.dayList || []));
      await new Promise((r) => setTimeout(r, 400));
    }
    process.stdout.write('\n');

    // t7dayList carries VO2max/threshold, which dayDetail omits -- merge it in
    // so a single daily.json has everything for that date.
    try {
      const summary = await client.analyse();
      const byDate = new Map(days.map((d) => [String(d.happenDay), d]));
      for (const item of summary.t7dayList || []) {
        const rec = byDate.get(String(item.happenDay));
        if (rec) Object.assign(rec, { vo2max: item.vo2max, lthr: item.lthr, ltsp: item.ltsp });
      }
      writeJson(args.out, 'analyse-summary.json', summary);
    } catch (err) {
      warnings.push(`analyse summary: ${err.message}`);
    }

    const unique = [...new Map(days.map((d) => [String(d.happenDay), d])).values()]
      .sort((a, b) => String(a.happenDay).localeCompare(String(b.happenDay)));
    writeJson(args.out, 'daily.json', unique);
    return unique;
  });

  // --- HRV ---
  await section('HRV + dashboard (last ~7 days only)', warnings, async () => {
    const data = await client.dashboard();
    writeJson(args.out, 'dashboard.json', data);
    const n = ((data.summaryInfo || {}).sleepHrvData || {}).sleepHrvList || [];
    console.log(`  ${n.length} nights of HRV. This endpoint has no date range --`);
    console.log('  run the pull regularly to build history, or use COROS MCP for a longer window.');
    return data;
  });

  // --- planned training ---
  await section('training schedule', warnings, async () => {
    const data = await client.trainingSchedule(from, to);
    writeJson(args.out, 'schedule.json', data);
    return data;
  });

  // --- optional raw files ---
  if (args.fit && activities && activities.length) {
    await section('fit files (max 50/day per COROS)', warnings, async () => {
      const fitDir = path.join(args.out, 'fit');
      fs.mkdirSync(fitDir, { recursive: true });
      const pending = activities.filter(
        (a) => !fs.existsSync(path.join(fitDir, `${a.labelId}.fit`))
      ).slice(0, 50);
      let ok = 0;
      for (const a of pending) {
        try {
          const url = await client.activityFileUrl(a.labelId, a.sportType, 'fit');
          if (!url) continue;
          const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
          fs.writeFileSync(path.join(fitDir, `${a.labelId}.fit`), buf);
          ok++;
          process.stdout.write(`  ${ok}/${pending.length}\r`);
        } catch (err) {
          warnings.push(`fit ${a.labelId}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      console.log(`\n  downloaded ${ok} files. Re-run --fit tomorrow to continue.`);
    });
  }

  writeJson(args.out, 'meta.json', {
    pulledAt: new Date().toISOString(),
    range: { from, to },
    region: auth.region,
    userId: auth.userId,
    warnings,
  });

  console.log(`\nDone -> ${args.out}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
  console.log('\nNext: node health/analyze-health.js');
}

main().catch((err) => {
  if (err instanceof CorosError) console.error(`\nCOROS API error [${err.code}]: ${err.message}`);
  else console.error(`\n${err.stack || err.message}`);
  process.exit(1);
});
