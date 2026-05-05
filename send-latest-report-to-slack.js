require("dotenv").config({ override: true });
const { Client } = require("pg");

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function roas(value) {
  return `${Number(value || 0).toFixed(2)}x`;
}

function classifyMarket(campaignName = "") {
  const name = campaignName.toLowerCase();

  if (
    name.includes("secondary market") ||
    name.includes("secondary") ||
    name.includes("_secondary_") ||
    name.includes(" secondary ")
  ) {
    return "secondary";
  }

  if (
    name.includes("main market") ||
    name.includes("main") ||
    name.includes("_main_") ||
    name.includes(" main ")
  ) {
    return "main";
  }

  return "unknown";
}

function classifyType(campaignName = "") {
  const name = campaignName.toLowerCase();

  if (name.includes("dg") || name.includes("demand gen")) return "DG";
  if (name.includes("sem") || name.includes("search")) return "SEM";

  return "OTHER";
}

function summarizeGroup(campaigns) {
  const active = campaigns.filter(
    (c) => String(c.status || "").toUpperCase() !== "REMOVED"
  );

  const total = active.reduce(
    (acc, c) => {
      acc.cost += Number(c.cost || 0);
      acc.clicks += Number(c.clicks || 0);
      acc.impressions += Number(c.impressions || 0);
      acc.conversions += Number(c.conversions || 0);
      acc.conversion_value += Number(c.conversion_value || 0);
      return acc;
    },
    {
      cost: 0,
      clicks: 0,
      impressions: 0,
      conversions: 0,
      conversion_value: 0,
    }
  );

  total.roas = total.cost > 0 ? total.conversion_value / total.cost : 0;

  return {
    active_count: active.length,
    ...total,
  };
}

function summarizeType(campaigns, type, threshold) {
  const filtered = campaigns.filter(
    (c) => classifyType(c.campaign_name || c.campaign_key) === type
  );
  const totals = summarizeGroup(filtered);

  const roasValues = filtered
    .map((c) => Number(c.roas || 0))
    .filter((v) => !Number.isNaN(v));

  const minRoas = roasValues.length ? Math.min(...roasValues) : 0;
  const maxRoas = roasValues.length ? Math.max(...roasValues) : 0;
  const belowCount = filtered.filter((c) => Number(c.roas || 0) < threshold).length;

  return {
    type,
    count: filtered.length,
    threshold,
    ...totals,
    min_roas: minRoas,
    max_roas: maxRoas,
    below_count: belowCount,
  };
}

function buildPatterns(campaigns, marketLabel) {
  const sortedByCost = [...campaigns].sort(
    (a, b) => Number(b.cost || 0) - Number(a.cost || 0)
  );
  const sortedByRoas = [...campaigns]
    .filter((c) => Number(c.cost || 0) > 0)
    .sort((a, b) => Number(b.roas || 0) - Number(a.roas || 0));

  const patterns = [];

  const best = sortedByRoas[0];
  if (best) {
    patterns.push(
      `• ${best.campaign_name} ${roas(best.roas)} on ${money(
        best.cost
      )} — strongest ${marketLabel} performer by ROAS in yesterday’s data.`
    );
  }

  const worstPaid = sortedByCost.find(
    (c) => Number(c.cost || 0) > 0 && Number(c.conversions || 0) === 0
  );
  if (worstPaid) {
    patterns.push(
      `• ${worstPaid.campaign_name} ${roas(worstPaid.roas)} on ${money(
        worstPaid.cost
      )} — spent with 0 conversions; review search terms, tracking, and campaign intent before scaling.`
    );
  }

  const lowRoas = sortedByCost.find(
    (c) =>
      Number(c.cost || 0) >= 10 &&
      Number(c.roas || 0) > 0 &&
      Number(c.roas || 0) < 1
  );
  if (lowRoas) {
    patterns.push(
      `• ${lowRoas.campaign_name} ${roas(lowRoas.roas)} on ${money(
        lowRoas.cost
      )} — conversion value is very low relative to spend.`
    );
  }

  const highSpend = sortedByCost[0];
  if (highSpend && !patterns.some((p) => p.includes(highSpend.campaign_name))) {
    patterns.push(
      `• ${highSpend.campaign_name} ${roas(highSpend.roas)} on ${money(
        highSpend.cost
      )} — highest spend campaign in ${marketLabel}; monitor efficiency closely.`
    );
  }

  if (patterns.length === 0) {
    patterns.push("• No clear campaign-level pattern detected from yesterday’s snapshot.");
  }

  return patterns.slice(0, 5);
}

function formatRecommendation(rec, index) {
  const campaign = rec.campaign_key || "unknown";
  const action = rec.action_type || "REVIEW_CAMPAIGN";
  const impact = Number(rec.estimated_daily_impact || 0);

  let tag = `${index}. [${action}|camp:${campaign}]`;

  const current = rec.current_value || {};
  const spend = Number(current.cost || current.spend || 0);
  const roasValue = current.roas !== undefined ? Number(current.roas) : null;
  const clicks = current.clicks !== undefined ? Number(current.clicks) : null;
  const conversions = current.conversions !== undefined ? Number(current.conversions) : null;

  const metricParts = [];

  if (spend > 0) metricParts.push(`${money(spend)} spend`);
  if (roasValue !== null && !Number.isNaN(roasValue)) metricParts.push(`${roas(roasValue)} ROAS`);
  if (clicks !== null && !Number.isNaN(clicks)) metricParts.push(`${clicks} clicks`);
  if (conversions !== null && !Number.isNaN(conversions)) metricParts.push(`${conversions} conv`);

  const metricText = metricParts.length ? metricParts.join(", ") : "";

  if (action === "ADD_NEGATIVES") {
    const keywords = rec.proposed_value?.negative_keywords || [];
    const keywordText = keywords.length ? ` KWs: ${keywords.join(", ")}.` : "";
    return `${tag} ${money(impact)} wasted spend — add negatives.${keywordText} Est. avoid ${money(impact)}/day.`;
  }

  if (action === "ADD_KEYWORD") {
    const reason = String(rec.reason || "");
    const reasonMatch =
      reason.match(/Search term ['"]([^'"]+)['"]/i) ||
      reason.match(/term ['"]([^'"]+)['"]/i);

    const keyword =
      rec.proposed_value?.keyword ||
      rec.proposed_value?.keywords?.[0] ||
      rec.keyword_text ||
      reasonMatch?.[1] ||
      "";

    const keywordText = keyword
      ? ` Add "${keyword}" as exact.`
      : " Add converting term as exact keyword.";

    return `${tag} converting search term — add as managed keyword.${keywordText} Est. +${money(impact)}/day cv.`;
  }

  if (action === "REVIEW_SEARCH_TERMS") {
    return `${tag} ${metricText} — pull search terms before adding negatives. Est. review ${money(impact)}/day.`;
  }

  if (action === "REVIEW_CAMPAIGN") {
    return `${tag} ${metricText} — review targeting, creative, and landing page fit. Est. review ${money(impact)}/day.`;
  }

  if (action === "MONITOR") {
    return `${tag} ${metricText} — monitor 2–3 days before changing spend.`;
  }

  if (action === "DECREASE_BUDGET" || action === "LOWER_BUDGET") {
    return `${tag} ${metricText} — decrease budget carefully. :hourglass_flowing_sand: Est. save ${money(impact)}/day.`;
  }

  if (action === "RAISE_BUDGET") {
    return `${tag} ${metricText} — raise budget carefully. :hourglass_flowing_sand: Est. +${money(impact)}/day cv.`;
  }

  if (action === "PAUSE_KEYWORD") {
    return `${tag} ${metricText} — pause keyword. Est. avoid ${money(impact)}/day.`;
  }

  return `${tag} ${metricText} — ${action}. Est. impact ${money(impact)}/day.`;
}

function buildMarketSection({ title, cc, campaigns, recommendations, date }) {
  const totals = summarizeGroup(campaigns);
  const sem = summarizeType(campaigns, "SEM", 10);
  const dg = summarizeType(campaigns, "DG", 20);

  const lines = [];

  lines.push(`:bar_chart: *${title} DAILY ALERT — ${date}* — cc ${cc}`);
  lines.push("");

  lines.push(`${title} totals — ${money(totals.cost)} cost, ${totals.active_count} active campaigns`);
  lines.push(
    `• SEM: ${money(sem.cost)} → ${money(sem.conversion_value)} cv, ROAS ${roas(
      sem.roas
    )} (range ${roas(sem.min_roas)}–${roas(sem.max_roas)}, ${
      sem.below_count
    } camps below ≥10x threshold)`
  );
  lines.push(
    `• DG:  ${money(dg.cost)} → ${money(dg.conversion_value)} cv, ROAS ${roas(
      dg.roas
    )} (range ${roas(dg.min_roas)}–${roas(dg.max_roas)}, ${
      dg.below_count
    } camps below ≥20x threshold)`
  );
  lines.push("");

  lines.push("*Patterns*");
  buildPatterns(campaigns, title).forEach((p) => lines.push(p));
  lines.push("");

  lines.push("*Top recommendations*");
  if (recommendations.length === 0) {
    lines.push("No recommendations for this market.");
  } else {
    const maxRecs = 8;

    recommendations
      .sort(
        (a, b) =>
          Number(b.estimated_daily_impact || 0) -
          Number(a.estimated_daily_impact || 0)
      )
      .slice(0, maxRecs)
      .forEach((rec, i) => {
        lines.push(formatRecommendation(rec, i + 1));
      });
  }

  lines.push("");
  lines.push("_Reply in thread: approve N | approve all | decline N | details N_");

  return lines.join("\n");
}

async function buildLatestReports() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const alertResult = await client.query(`
      SELECT *
      FROM alerts
      ORDER BY created_at DESC
      LIMIT 1;
    `);

    if (alertResult.rows.length === 0) {
      throw new Error("No alerts found.");
    }

    const alert = alertResult.rows[0];

    const recommendationResult = await client.query(
      `
      SELECT *
      FROM recommendations
      WHERE alert_id = $1
      ORDER BY recommendation_number;
      `,
      [alert.id]
    );

    const snapshotResult = await client.query(`
      SELECT payload
      FROM ads_metric_snapshots
      WHERE source = 'google_ads_script'
      ORDER BY created_at DESC
      LIMIT 1;
    `);

    if (snapshotResult.rows.length === 0) {
      throw new Error("No google_ads_script snapshot found.");
    }

    const snapshot = snapshotResult.rows[0].payload;
    const campaigns = snapshot.campaigns || [];

    const mainCampaigns = campaigns.filter(
      (c) => classifyMarket(c.campaign_name || c.campaign_key) === "main"
    );
    const secondaryCampaigns = campaigns.filter(
      (c) => classifyMarket(c.campaign_name || c.campaign_key) === "secondary"
    );

    const recs = recommendationResult.rows;
    const mainRecs = recs.filter(
      (rec) => classifyMarket(rec.campaign_key || "") === "main"
    );
    const secondaryRecs = recs.filter(
      (rec) => classifyMarket(rec.campaign_key || "") === "secondary"
    );

    const date =
      alert.id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
      snapshot.date ||
      String(alert.alert_date).slice(0, 10);

    const mainReport = buildMarketSection({
      title: "MAIN MARKET",
      cc: "@Habibie",
      campaigns: mainCampaigns,
      recommendations: mainRecs,
      date,
    });

    const secondaryReport = buildMarketSection({
      title: "SECONDARY MARKET",
      cc: "@Desvantyo",
      campaigns: secondaryCampaigns,
      recommendations: secondaryRecs,
      date,
    });

    return {
      mainReport,
      secondaryReport,
    };
  } finally {
    await client.end();
  }
}

async function sendToSlack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) {
    throw new Error("SLACK_WEBHOOK_URL is missing.");
  }

  const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${body}`);
  }

  console.log("Slack report sent successfully.");
  console.log(body);
}

async function main() {
  const { mainReport, secondaryReport } = await buildLatestReports();

  console.log("Main Market report preview:");
  console.log("----------------------------------------");
  console.log(mainReport);
  console.log("----------------------------------------");
  await sendToSlack(mainReport);

  console.log("Secondary Market report preview:");
  console.log("----------------------------------------");
  console.log(secondaryReport);
  console.log("----------------------------------------");
  await sendToSlack(secondaryReport);
}

main().catch((error) => {
  console.error("Failed to send Slack report:");
  console.error(error.message);
  process.exit(1);
});