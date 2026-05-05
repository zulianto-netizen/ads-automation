require("dotenv").config();
const { Client } = require("pg");

function formatRecommendation(rec) {
  let line = `${rec.recommendation_number}. [${rec.action_type}|campaign_id:${rec.campaign_key}`;

  if (rec.ad_group_key) {
    line += `|adgroup:${rec.ad_group_key}`;
  }

  line += `|reason:${rec.reason.replaceAll(" ", "_").toLowerCase()}] `;

  if (rec.action_type === "INVESTIGATE_TRACKING") {
    line += `Investigate tracking issue. ${rec.reason}. Est. avoid $${rec.estimated_daily_impact}/day cv loss.`;
  }

  if (rec.action_type === "RAISE_BUDGET") {
    line += `${rec.campaign_key} raise budget $${rec.current_value.budget}→$${rec.proposed_value.budget}/day. ${rec.reason}. Est. +$${rec.estimated_daily_impact}/day cv.`;
  }

  if (rec.action_type === "ADD_NEGATIVES") {
    line += `${rec.campaign_key} ${rec.ad_group_key}: add negatives ${rec.proposed_value.negative_keywords.join(", ")}. ${rec.reason}. Est. avoid $${rec.estimated_daily_impact}/day.`;
  }

  if (rec.action_type === "PAUSE_KEYWORD") {
    line += `${rec.campaign_key} ${rec.ad_group_key}: pause keyword ${rec.keyword_text}. ${rec.reason}. Est. avoid $${rec.estimated_daily_impact}/day.`;
  }

  return line;
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

 const alertId = process.argv[2] || "2026-05-03-main-market";

  try {
    await client.connect();

    const alertResult = await client.query(
      `
      SELECT *
      FROM alerts
      WHERE id = $1
      LIMIT 1;
      `,
      [alertId]
    );

    if (alertResult.rows.length === 0) {
      console.log("No alert found. Run this first:");
      console.log("node create-daily-alert.js");
      return;
    }

    const alert = alertResult.rows[0];

    const recommendationResult = await client.query(
      `
      SELECT *
      FROM recommendations
      WHERE alert_id = $1
      ORDER BY recommendation_number;
      `,
      [alertId]
    );

    const reportLines = [];

    const alertDate = alert.id.slice(0, 10);
reportLines.push(`:bar_chart: MAIN MARKET DAILY ALERT — ${alertDate} — cc @Habibie`);
    reportLines.push("");
    reportLines.push("Account totals");
    reportLines.push("• Cost $1,168.33 ↓5.70% | Clicks 1,068 ↓6.81% | Conv 263.98 ↓52.84%");
    reportLines.push("• Conv value $5,783.28 ↓52.99% :warning: likely tracking/attribution issue");
    reportLines.push("• ROAS 4.95x ↓50.14%");
    reportLines.push("");
    reportLines.push("Top recommendations");
    recommendationResult.rows.forEach((rec) => {
      reportLines.push(formatRecommendation(rec));
    });
    reportLines.push("");
    reportLines.push("Reply in thread:");
    reportLines.push("• apply 1 / apply 1, 2, 3 / apply 1-5 / apply all");
    reportLines.push("• skip 1 / reject all");
    reportLines.push("• why 1 / more on 5 / show search terms for 7");
    reportLines.push("• STOP");
    reportLines.push(`Alert ID: ${alert.id}`);

    console.log(reportLines.join("\n"));
  } catch (error) {
    console.error("Failed to render report:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();