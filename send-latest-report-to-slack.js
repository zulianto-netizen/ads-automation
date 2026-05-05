require("dotenv").config({ override: true });
const { Client } = require("pg");

function formatRecommendation(rec) {
  let line = `${rec.recommendation_number}. [${rec.action_type}|campaign_id:${rec.campaign_key || "unknown"}`;

  if (rec.ad_group_key) {
    line += `|adgroup:${rec.ad_group_key}`;
  }

  line += `] `;

  if (rec.action_type === "INVESTIGATE_TRACKING") {
    line += `Investigate tracking issue. ${rec.reason}. Est. avoid $${rec.estimated_daily_impact || 0}/day cv loss.`;
  } else if (rec.action_type === "RAISE_BUDGET") {
    line += `${rec.campaign_key} raise budget recommendation. ${rec.reason}. Est. +$${rec.estimated_daily_impact || 0}/day cv.`;
  } else if (rec.action_type === "ADD_NEGATIVES") {
    const keywords = rec.proposed_value?.negative_keywords || [];
    line += `${rec.campaign_key} ${rec.ad_group_key || ""}: add negatives ${keywords.join(", ")}. ${rec.reason}. Est. avoid $${rec.estimated_daily_impact || 0}/day.`;
  } else if (rec.action_type === "PAUSE_KEYWORD") {
    line += `${rec.campaign_key} ${rec.ad_group_key || ""}: pause keyword ${rec.keyword_text || ""}. ${rec.reason}. Est. avoid $${rec.estimated_daily_impact || 0}/day.`;
  } else {
    line += `${rec.reason}`;
  }

  return line;
}

async function buildLatestReport() {
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

    const alertDate =
      alert.id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
      String(alert.alert_date).slice(0, 10);

    const lines = [];

    lines.push(`:bar_chart: *MAIN MARKET DAILY ALERT — ${alertDate}*`);
    lines.push("");
    lines.push(`Alert ID: \`${alert.id}\``);
    lines.push("");
    lines.push("*Summary*");
    lines.push(alert.raw_report_text || "Claude generated Google Ads performance report.");
    lines.push("");
    lines.push("*Top recommendations*");

    if (recommendationResult.rows.length === 0) {
      lines.push("No recommendations generated.");
    } else {
      recommendationResult.rows.forEach((rec) => {
        lines.push(formatRecommendation(rec));
      });
    }

    lines.push("");
    lines.push("*Approval commands for now*");
    lines.push("Run locally:");
    lines.push("```");
    lines.push("node approve.js 1");
    lines.push("node apply-approved.js");
    lines.push("```");
    lines.push("");
    lines.push("_Slack approval buttons/thread commands will come later. This version posts the report only._");

    return lines.join("\n");
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
  const report = await buildLatestReport();

  console.log("Report preview:");
  console.log("----------------------------------------");
  console.log(report);
  console.log("----------------------------------------");

  await sendToSlack(report);
}

main().catch((error) => {
  console.error("Failed to send Slack report:");
  console.error(error.message);
  process.exit(1);
});
