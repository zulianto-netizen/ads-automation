# COROS health assistant

Pulls your COROS training and health history into local JSON, then reads it back
as a training/recovery report.

Nothing here phones home. Data lands in `health/data/`, which is gitignored.

---

## Read this first: there is an easier route

COROS ships an **official MCP server** that needs no password and no scripts:

```
https://mcp.coros.com/mcp
```

Add it in Claude (Settings -> Connectors -> Add custom connector), sign in with
OAuth once, and Claude can read your activities, sleep, HRV, recovery status,
training load and race predictions directly. It is free, supported by COROS, and
covers **sleep and recovery data that the scripts here cannot reach**.

Use these scripts when you want something the MCP does not give you:

- a **local archive** of your own data that survives account or API changes
- **scheduled** pulls (cron) building history the API only exposes in short windows
- your own analysis code over the raw numbers

The two work fine together.

---

## Setup

Needs Node 18+ (uses global `fetch`). No dependencies beyond `dotenv`, already in
this repo.

Add to `.env` in the repo root (already gitignored):

```
COROS_EMAIL=you@example.com
COROS_PASSWORD=your-coros-password
```

## Use

```bash
node health/pull-coros.js                       # last 3 years
node health/pull-coros.js --from 20240101       # from a date
node health/pull-coros.js --fit                 # also grab .fit files (50/day cap)

node health/analyze-health.js                   # readout
node health/analyze-health.js --json            # machine-readable
node health/analyze-health.js --weeks 26        # longer volume table
```

Region is detected automatically by probing each COROS host; `--region us|eu|asia`
skips that.

## What lands in health/data/

| File | Contents |
|---|---|
| `activities.json` | Every activity: distance, duration, pace, HR, elevation, load |
| `daily.json` | Per-day resting HR, training load, ATL/CTL, fatigue, VO2max, threshold, stamina |
| `dashboard.json` | Overnight HRV with baseline and SD (~last 7 days) |
| `analyse-summary.json` | Rolling 28-day fitness summary |
| `schedule.json` | Planned workouts |
| `fit/*.fit` | Raw activity files, with `--fit` |
| `meta.json` | Pull timestamp, range, and any sections that failed |

## What the analysis looks at

- **Acute:chronic load ratio** — flags the >1.5 spike zone and <0.8 detraining
- **Resting HR** — 7-day mean against your own 28-day baseline
- **Overnight HRV** — against your baseline minus 1 SD
- **Weekly volume** — week-on-week jumps past ~30%, ignoring the in-progress week
- **Consistency** — training vs rest days over 4 weeks

Thresholds live in `THRESHOLDS` at the top of `analyze-health.js`. They are
conventions from endurance-training literature, not facts about you — once you
know your own normal ranges, edit them.

## Limits worth knowing

- **The API is unofficial.** `teamapi.coros.com` is what t.coros.com calls from
  the browser. COROS does not document or support it and can change it without
  notice. The official MCP above is the stable route.
- **Logging in here logs you out of the COROS website**, and logging into the
  website invalidates the script's token. One session at a time.
- **No sleep duration or sleep score.** Those live behind the mobile API, which
  needs AES-encrypted credentials using a key extracted from the COROS app
  binary. Not worth reimplementing — the official MCP exposes sleep properly.
- **HRV history is ~7 days.** The endpoint takes no date range. Pull on a
  schedule to accumulate more.
- **FIT downloads are capped at 50 per calendar day** by COROS.
- Your password is sent as an MD5 digest because that is what the web app does.
  That is obfuscation, not security — treat `.env` as holding a live credential.

## Not medical advice

This reads training data. Resting HR that stays elevated, HRV that stays
suppressed, or fatigue that does not lift with rest is a reason to see a doctor,
not to tweak a threshold.
