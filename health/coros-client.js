'use strict';

/**
 * Minimal client for the COROS Training Hub web API.
 *
 * This is the *unofficial* API that t.coros.com itself calls from the browser.
 * COROS does not document or support it, and it can change without notice.
 * The officially supported route is the COROS MCP server (https://mcp.coros.com/mcp),
 * which needs no password at all -- see health/README.md.
 *
 * No third-party dependencies: Node 18+ global fetch and the built-in crypto module.
 */

const crypto = require('crypto');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * Login succeeds on any host, but the token it hands back is only accepted by
 * the host for the region the account actually lives in. So every call after
 * login has to go to the regional host, and `detectRegion` finds which one.
 */
const BASE_URLS = {
  us: 'https://teamapi.coros.com',
  eu: 'https://teameuapi.coros.com',
  asia: 'https://teamcnapi.coros.com',
  cn: 'https://teamcnapi.coros.com',
};

const ENDPOINTS = {
  login: '/account/login',
  dashboard: '/dashboard/query',
  analyse: '/analyse/query',
  analyseDetail: '/analyse/dayDetail/query',
  activityList: '/activity/query',
  activityDetail: '/activity/detail/query',
  activityDownload: '/activity/detail/download',
  schedule: '/training/schedule/query',
};

// modeList codes accepted by /activity/query, and how to name them in reports.
const SPORT_TYPES = {
  100: 'Run', 101: 'Indoor Run', 102: 'Trail Run', 103: 'Track Run',
  104: 'Hike', 105: 'Mtn Climb', 106: 'Climb',
  200: 'Road Bike', 201: 'Indoor Bike', 202: 'E-Bike', 203: 'Gravel Bike',
  204: 'Mountain Bike', 205: 'E-MTB', 299: 'Helmet Riding',
  300: 'Pool Swim', 301: 'Open Water',
  400: 'Gym Cardio', 401: 'GPS Cardio', 402: 'Strength',
  500: 'Ski', 501: 'Snowboard', 502: 'XC Ski', 503: 'Ski Touring',
  700: 'Rowing', 701: 'Indoor Rower', 702: 'Whitewater', 704: 'Flatwater',
  705: 'Windsurfing', 706: 'Speedsurfing',
  800: 'Indoor Climb', 801: 'Bouldering',
  900: 'Walk', 901: 'Jump Rope', 902: 'Floor Climb',
  10000: 'Triathlon', 10001: 'Multisport', 10002: 'Ski Touring', 10003: 'Outdoor Climb',
};

const FILE_TYPES = { csv: 0, gpx: 1, kml: 2, tcx: 3, fit: 4 };

class CorosError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CorosError';
    this.code = code;
  }
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The API answers 200 with a `result` code even for failures, so HTTP status
 * alone never tells you whether a call worked. "0000" is the only success code.
 */
function unwrap(body, what) {
  if (!body || typeof body !== 'object') {
    throw new CorosError('bad_response', `${what}: response was not JSON`);
  }
  if (body.result !== '0000') {
    const code = String(body.result || 'unknown');
    const hint =
      code === '1019'
        ? ' (token invalid or expired -- logging into t.coros.com in a browser invalidates it)'
        : '';
    throw new CorosError(code, `${what} failed: ${body.message || code}${hint}`);
  }
  return body.data || {};
}

class CorosClient {
  constructor({ region = null, retries = 3, timeoutMs = 30000 } = {}) {
    this.region = region;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.accessToken = null;
    this.userId = null;
  }

  get baseUrl() {
    if (!this.region) throw new CorosError('no_region', 'Region not set -- call login() first');
    return BASE_URLS[this.region];
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      accessToken: this.accessToken,
      // The web app sends this alongside the token; some endpoints reject calls without it.
      yfheader: JSON.stringify({ userId: this.userId }),
    };
  }

  async #fetch(url, options, what) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(this.timeoutMs) });
        if (!resp.ok) {
          // 4xx is a real answer -- retrying will not change it.
          if (resp.status >= 400 && resp.status < 500) {
            throw new CorosError(`http_${resp.status}`, `${what}: HTTP ${resp.status}`);
          }
          throw new Error(`${what}: HTTP ${resp.status}`);
        }
        return resp;
      } catch (err) {
        lastErr = err;
        if (err instanceof CorosError) throw err;
        if (attempt < this.retries) await sleep(2000 * 2 ** attempt);
      }
    }
    throw new CorosError('network', `${what}: ${lastErr && lastErr.message}`);
  }

  async get(path, query = {}, what = path) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const resp = await this.#fetch(url.toString(), { method: 'GET', headers: this.headers() }, what);
    return unwrap(await resp.json(), what);
  }

  /**
   * Authenticate. `password` is sent as an MD5 hex digest, which is what the
   * web app does -- it is transport obfuscation, not security, so treat the
   * password itself as a live secret.
   */
  async login(email, password, region = this.region) {
    const payload = JSON.stringify({ accountType: 2, account: email, pwd: md5(password) });
    const host = BASE_URLS[region] || BASE_URLS.us;
    const resp = await this.#fetch(
      host + ENDPOINTS.login,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: payload },
      'login'
    );
    const data = unwrap(await resp.json(), 'login');
    if (!data.accessToken) throw new CorosError('no_token', 'login returned no accessToken');
    this.accessToken = data.accessToken;
    this.userId = data.userId;
    this.region = region;
    return { userId: this.userId, region };
  }

  /**
   * Find the region whose host actually accepts this account's token, by
   * logging in and probing the cheapest authenticated read on each host.
   * Saves the user from having to know their account region.
   */
  async loginAutoRegion(email, password) {
    const candidates = ['us', 'eu', 'asia'];
    const failures = [];
    for (const region of candidates) {
      try {
        await this.login(email, password, region);
        await this.get(ENDPOINTS.dashboard, {}, `region probe (${region})`);
        return { userId: this.userId, region };
      } catch (err) {
        failures.push(`${region}: ${err.message}`);
        // A rejected password is the same on every host -- stop rather than
        // hammering all three with bad credentials.
        if (err instanceof CorosError && /password|account/i.test(err.message)) break;
      }
    }
    throw new CorosError('region_detect_failed', `Could not authenticate on any region.\n  ${failures.join('\n  ')}`);
  }

  // --- reads -------------------------------------------------------------

  /** Nightly HRV plus the account summary. Always the last ~7 days; no date range. */
  dashboard() {
    return this.get(ENDPOINTS.dashboard, {}, 'dashboard');
  }

  /** Rolling summary: t7dayList carries VO2max and fitness for the last ~28 days. */
  analyse() {
    return this.get(ENDPOINTS.analyse, {}, 'analyse');
  }

  /** Per-day metrics (RHR, training load, ATL/CTL, stamina) for a date range. */
  analyseDetail(startDay, endDay) {
    return this.get(ENDPOINTS.analyseDetail, { startDay, endDay }, 'analyse detail');
  }

  activityPage({ size = 200, pageNumber = 1, from, to, modeList } = {}) {
    return this.get(ENDPOINTS.activityList, { size, pageNumber, from, to, modeList }, 'activity list');
  }

  activityDetail(labelId, sportType) {
    return this.get(ENDPOINTS.activityDetail, { labelId, sportType }, 'activity detail');
  }

  trainingSchedule(startDate, endDate) {
    return this.get(
      ENDPOINTS.schedule,
      { startDate, endDate, supportRestExercise: 1 },
      'training schedule'
    );
  }

  /** Returns a short-lived CDN URL for the activity file, not the bytes. */
  async activityFileUrl(labelId, sportType, fileType = 'fit') {
    const code = FILE_TYPES[fileType];
    if (code === undefined) throw new CorosError('bad_file_type', `Unknown file type: ${fileType}`);
    const url = new URL(this.baseUrl + ENDPOINTS.activityDownload);
    url.searchParams.set('labelId', labelId);
    url.searchParams.set('sportType', sportType);
    url.searchParams.set('fileType', String(code));
    const resp = await this.#fetch(url.toString(), { method: 'POST', headers: this.headers() }, 'activity download');
    const data = unwrap(await resp.json(), 'activity download');
    return data.fileUrl || data.url || null;
  }

  /**
   * Walk the paginated activity list until it runs dry.
   * `onPage` is called after each page so long pulls can report progress.
   */
  async allActivities({ from, to, modeList, pageSize = 200, onPage } = {}) {
    const out = [];
    const seen = new Set();
    for (let page = 1; ; page++) {
      const data = await this.activityPage({ size: pageSize, pageNumber: page, from, to, modeList });
      const list = data.dataList || [];
      if (list.length === 0) break;

      for (const a of list) {
        // The API can repeat rows across page boundaries; labelId is the stable key.
        const key = a.labelId || `${a.date}-${a.startTime}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(a);
        }
      }
      if (onPage) onPage(page, out.length, data.totalCount);
      if (list.length < pageSize) break;
      await sleep(400); // stay well clear of any rate limiting
    }
    return out;
  }
}

module.exports = { CorosClient, CorosError, SPORT_TYPES, FILE_TYPES, BASE_URLS, ENDPOINTS, md5 };
