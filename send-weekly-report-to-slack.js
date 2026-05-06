require("dotenv").config({ override: true });
const { Client } = require("pg");

const ACCOUNT_ID = "122-674-7536";

function money(value) {
  return `$${Math.round(Number(value || 0)).toLocaleString("en-US")}`;
}

function money2(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function number(value) {
  return `${Math.round(Number(value || 0)).toLocaleString("en-US")}`;
}

function pct(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function roas(value) {
  return `${Number(value || 0).toFixed(2)}x`;
}

function ctr(clicks, impressions) {
  return Number(impressions || 0) > 0
    ? (Number(clicks || 0) / Number(impressions || 0)) * 100
    : 0;
}

function changePercent(current, previous) {
  current = Number(current || 0);
  previous = Number(previous || 0);

  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return 100;

  return ((current - previous) / previous) * 100;
}

function changeWord(change) {
  if (change > 0.005) return "increased";
  if (change < -0.005) return "decreased";
  return "changed";
}

function signedPct(change) {
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

function metricLine(label, current, previous, formatter) {
  const chg = changePercent(current, previous);
  return `  ${label.padEnd(23)} ${changeWord(chg)} by \`${signedPct(chg)}\`  (from \`${formatter(previous)}\` to \`${formatter(current)}\`)`;
}

function classifyMarket(campaignName = "") {
  const name = campaignName.toLowerCase();
  if (name.includes("secondary market") || name.includes("secondary")) return "secondary";
  if (name.includes("main market") || name.includes("main")) return "main";
  return "unknown";
}

function classifyType(campaignName = "") {
  const name = campaignName.toLowerCase();
  if (name.includes("dg") || name.includes("demand gen")) return "DG";
  if (name.includes("sem") || name.includes("search")) return "SEM";
  return "OTHER";
}

function shortCampaignName(name = "") {
  const parts = String(name).split("|").map((p) => p.trim()).filter(Boolean);

  const ignored = new Set([
    "sem",
    "dg",
    "g2g",
    "all user",
    "all users",
    "main market",
    "secondary market",
    "non-branded",
    "branded",
    "global",
  ]);

  const useful = parts.filter((p) => !ignored.has(p.toLowerCase()));

  if (useful.length >= 2) {
    return useful.slice(-2).join(" ");
  }

  return useful[0] || name;
}

function emptyTotals() {
  return {
    cost: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversion_value: 0,
  };
}

function addMetrics(target, row) {
  target.cost += Number(row.cost || 0);
  target.impressions += Number(row.impressions || 0);
  target.clicks += Number(row.clicks || 0);
  target.conversions += Number(row.conversions || 0);
  target.conversion_value += Number(row.conversion_value || 0);
}

function finishTotals(t) {
  return {
    ...t,
    ctr: ctr(t.clicks, t.impressions),
    roas: Number(t.cost || 0) > 0 ? Number(t.conversion_value || 0) / Number(t.cost || 0) : 0,
  };
}

function aggregateByMarketAndType(snapshots, market, type) {
  const totals = emptyTotals();
  const campaignMap = new Map();
  const wasteTerms = new Map();

  for (const snap of snapshots) {
    const payload = snap.payload || {};

    for (const campaign of payload.campaigns || []) {
      const campaignName = campaign.campaign_name || campaign.campaign_key || "";
      if (campaignName.toLowerCase().includes("branding")) continue;
      if (classifyMarket(campaignName) !== market) continue;
      if (classifyType(campaignName) !== type) continue;

      addMetrics(totals, campaign);

      if (!campaignMap.has(campaignName)) {
        campaignMap.set(campaignName, emptyTotals());
      }

      addMetrics(campaignMap.get(campaignName), campaign);
    }

    for (const term of payload.search_terms || []) {
      const campaignName = term.campaign_name || "";
      if (campaignName.toLowerCase().includes("branding")) continue;
      if (classifyMarket(campaignName) !== market) continue;
      if (classifyType(campaignName) !== type) continue;

      const cost = Number(term.cost || 0);
      const conversions = Number(term.conversions || 0);
      const searchTerm = term.search_term || "";

      if (!searchTerm) continue;
      if (cost < 1 || conversions !== 0) continue;

      const key = `${campaignName}|||${searchTerm}`;
      if (!wasteTerms.has(key)) {
        wasteTerms.set(key, {
          campaign_name: campaignName,
          search_term: searchTerm,
          cost: 0,
          clicks: 0,
        });
      }

      const item = wasteTerms.get(key);
      item.cost += cost;
      item.clicks += Number(term.clicks || 0);
    }
  }

  const campaigns = Array.from(campaignMap.entries()).map(([campaign_name, values]) => ({
    campaign_name,
    ...finishTotals(values),
  }));

  const waste = Array.from(wasteTerms.values())
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  return {
    totals: finishTotals(totals),
    campaigns,
    waste,
  };
}

function compareCampaignDrivers(current, previous, type) {
  const previousMap = new Map(previous.campaigns.map((c) => [c.campaign_name, c]));
  const rows = [];

  for (const c of current.campaigns) {
    const p = previousMap.get(c.campaign_name) || finishTotals(emptyTotals());

    rows.push({
      campaign_name: c.campaign_name,
      current: c,
      previous: p,
      cv_delta: c.conversion_value - p.conversion_value,
      roas_delta_pct: changePercent(c.roas, p.roas),
    });
  }

  const increasing = [...rows]
    .filter((r) => r.current.conversion_value > 0)
    .sort((a, b) => b.cv_delta - a.cv_delta)
    .slice(0, 5);

  const decreasing = [...rows]
    .filter((r) => r.current.cost > 0)
    .sort((a, b) => a.cv_delta - b.cv_delta)
    .slice(0, 5);

  return { increasing, decreasing };
}

function driverLine(row, threshold) {
  const name = shortCampaignName(row.campaign_name);
  const currentRoas = row.current.roas;
  const previousRoas = row.previous.roas;

  const thresholdText =
    currentRoas >= threshold
      ? `above ${threshold}x threshold`
      : `below ${threshold}x threshold`;

  if (row.previous.cost > 0) {
    return `    * ${name.padEnd(20)} — ROAS ${roas(previousRoas)} → ${roas(currentRoas)}  (${signedPct(changePercent(currentRoas, previousRoas))})  ← ${thresholdText}`;
  }

  return `    * ${name.padEnd(20)} — ROAS ${roas(currentRoas)}  (${thresholdText})`;
}

function wasteLine(item) {
  return `    * ${shortCampaignName(item.campaign_name).padEnd(20)} — ${money2(item.cost)}/wk wasted on "${item.search_term}"`;
}

function formatSegmentBlock({ marketTitle, type, current, previous, dateLabel, threshold }) {
  const currentTotals = current.totals;
  const previousTotals = previous.totals;
  const drivers = compareCampaignDrivers(current, previous, type);

  const lines = [];

  lines.push(`${marketTitle} — ${type}  (${dateLabel})`);
  lines.push("──────────────────────────────────────────────────────────────────────");
  lines.push(metricLine("Weekly Spent:", currentTotals.cost, previousTotals.cost, money));
  lines.push(metricLine("Impressions:", currentTotals.impressions, previousTotals.impressions, number));
  lines.push(metricLine("Clicks:", currentTotals.clicks, previousTotals.clicks, number));
  lines.push(metricLine("CTR:", currentTotals.ctr, previousTotals.ctr, pct));
  lines.push(metricLine("Conversions:", currentTotals.conversions, previousTotals.conversions, number));
  lines.push(metricLine("Conversion Value:", currentTotals.conversion_value, previousTotals.conversion_value, money));
  lines.push(metricLine("ROAS:", currentTotals.roas, previousTotals.roas, roas));
  lines.push("");

  lines.push("  Key Drivers increasing conversion metrics:");
  if (drivers.increasing.length === 0) {
    lines.push("    * Not enough data yet.");
  } else {
    drivers.increasing.slice(0, 5).forEach((row) => lines.push(driverLine(row, threshold)));
  }
  lines.push("");

  lines.push("  Key Drivers decreasing conversion metrics:");
  const decreasing = drivers.decreasing.filter((row) => row.cv_delta < 0 || row.current.roas < threshold);
  if (decreasing.length === 0 && current.waste.length === 0) {
    lines.push("    * No major decline drivers found.");
  } else {
    decreasing.slice(0, 4).forEach((row) => lines.push(driverLine(row, threshold)));
    current.waste.slice(0, 3).forEach((item) => lines.push(wasteLine(item)));
  }
  lines.push("");

  return lines.join("\n");
}

function getDateLabel(currentSnapshots, previousSnapshots) {
  const currentDates = currentSnapshots.map((s) => String(s.report_date).slice(0, 10)).sort();
  const previousDates = previousSnapshots.map((s) => String(s.report_date).slice(0, 10)).sort();

  const current = currentDates.length
    ? `${currentDates[0]}–${currentDates[currentDates.length - 1]}`
    : "current period";

  const previous = previousDates.length
    ? `${previousDates[0]}–${previousDates[previousDates.length - 1]}`
    : "previous period";

  const year = currentDates.length ? currentDates[currentDates.length - 1].slice(0, 4) : "";

  return `${current} vs ${previous}${year ? `, ${year}` : ""}`;
}

function formatWeeklyReport({ currentSnapshots, previousSnapshots }) {
  const dateLabel = getDateLabel(currentSnapshots, previousSnapshots);

  const mainSemCurrent = aggregateByMarketAndType(currentSnapshots, "main", "SEM");
  const mainSemPrevious = aggregateByMarketAndType(previousSnapshots, "main", "SEM");
  const mainDgCurrent = aggregateByMarketAndType(currentSnapshots, "main", "DG");
  const mainDgPrevious = aggregateByMarketAndType(previousSnapshots, "main", "DG");

  const secondarySemCurrent = aggregateByMarketAndType(currentSnapshots, "secondary", "SEM");
  const secondarySemPrevious = aggregateByMarketAndType(previousSnapshots, "secondary", "SEM");
  const secondaryDgCurrent = aggregateByMarketAndType(currentSnapshots, "secondary", "DG");
  const secondaryDgPrevious = aggregateByMarketAndType(previousSnapshots, "secondary", "DG");

  const lines = [];

  lines.push(`*G2G WEEKLY AI-IMPACT REPORT — Week of ${dateLabel}*`);
  lines.push(`G2G Ad Account ${ACCOUNT_ID}`);
  lines.push("================================================================================");
  lines.push("");
  lines.push("▓▓▓ MAIN MARKET ▓▓▓");
  lines.push("");
  lines.push(formatSegmentBlock({
    marketTitle: "MAIN MARKET",
    type: "SEM",
    current: mainSemCurrent,
    previous: mainSemPrevious,
    dateLabel,
    threshold: 10,
  }));
  lines.push(formatSegmentBlock({
    marketTitle: "MAIN MARKET",
    type: "DG",
    current: mainDgCurrent,
    previous: mainDgPrevious,
    dateLabel,
    threshold: 20,
  }));

  lines.push("▓▓▓ SECONDARY MARKET ▓▓▓");
  lines.push("");
  lines.push(formatSegmentBlock({
    marketTitle: "SECONDARY MARKET",
    type: "SEM",
    current: secondarySemCurrent,
    previous: secondarySemPrevious,
    dateLabel,
    threshold: 10,
  }));
  lines.push(formatSegmentBlock({
    marketTitle: "SECONDARY MARKET",
    type: "DG",
    current: secondaryDgCurrent,
    previous: secondaryDgPrevious,
    dateLabel,
    threshold: 20,
  }));

  return lines.join("\n");
}

async function fetchSnapshots(client) {
  const result = await client.query(`
    WITH ranked AS (
      SELECT
        id,
        report_date,
        payload,
        created_at,
        ROW_NUMBER() OVER (
          PARTITION BY report_date, account_id
          ORDER BY created_at DESC
        ) AS rn
      FROM ads_metric_snapshots
      WHERE source = 'google_ads_script'
        AND report_date IS NOT NULL
    )
    SELECT id, report_date, payload, created_at
    FROM ranked
    WHERE rn = 1
    ORDER BY report_date DESC
    LIMIT 14;
  `);

  return result.rows.reverse();
}

async function sendToSlack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) {
    throw new Error("SLACK_WEBHOOK_URL is missing.");
  }

  // Slack webhook messages can get long. Send as one message first.
  const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${body}`);
  }

  console.log("Slack weekly report sent successfully.");
  console.log(body);
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const snapshots = await fetchSnapshots(client);

    if (snapshots.length < 2) {
      throw new Error("Need at least 2 daily snapshots for weekly comparison.");
    }

    const splitIndex = Math.max(0, snapshots.length - 7);
    const previousSnapshots = snapshots.slice(0, splitIndex);
    const currentSnapshots = snapshots.slice(splitIndex);

    if (previousSnapshots.length === 0) {
      console.log("Warning: previous period has no data yet. Some comparisons will show from $0/0.");
    }

    const report = formatWeeklyReport({
      currentSnapshots,
      previousSnapshots,
    });

    console.log("Weekly report preview:");
    console.log("----------------------------------------");
    console.log(report);
    console.log("----------------------------------------");

    await sendToSlack(report);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed to send weekly report:");
  console.error(error.message);
  process.exit(1);
});
