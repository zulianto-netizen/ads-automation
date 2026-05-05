require("dotenv").config({ override: true });
const { Client } = require("pg");

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function roas(value) {
  return `${Number(value || 0).toFixed(2)}x`;
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const result = await client.query(
      `
      SELECT
        im.id,
        im.recommendation_id,
        ac.change_type,
        ac.campaign_key,
        ac.ad_group_key,
        ac.keyword_text,
        im.baseline_start,
        im.baseline_end,
        im.after_start,
        im.after_end,
        im.cost_before,
        im.cost_after,
        im.conversion_value_before,
        im.conversion_value_after,
        im.roas_before,
        im.roas_after,
        im.verdict,
        im.summary
      FROM impact_measurements im
      JOIN applied_changes ac
        ON ac.id = im.applied_change_id
      ORDER BY im.measured_at DESC
      LIMIT 1;
      `
    );

    if (result.rows.length === 0) {
      console.log("No impact measurements found.");
      return;
    }

    const impact = result.rows[0];

    const lines = [];

    lines.push(`:chart_with_upwards_trend: Impact Result — ${impact.change_type}`);
    lines.push("");
    lines.push(`Recommendation ID: ${impact.recommendation_id}`);
    lines.push(`Campaign: ${impact.campaign_key || "-"}`);

    if (impact.ad_group_key) {
      lines.push(`Ad group: ${impact.ad_group_key}`);
    }

    if (impact.keyword_text) {
      lines.push(`Keyword: ${impact.keyword_text}`);
    }

    lines.push("");
    lines.push(
      `Baseline: ${impact.baseline_start.toISOString().slice(0, 10)} → ${impact.baseline_end
        .toISOString()
        .slice(0, 10)}`
    );
    lines.push(
      `After: ${impact.after_start.toISOString().slice(0, 10)} → ${impact.after_end
        .toISOString()
        .slice(0, 10)}`
    );
    lines.push("");
    lines.push("Performance change:");
    lines.push(`• Cost: ${money(impact.cost_before)} → ${money(impact.cost_after)}`);
    lines.push(
      `• Conversion value: ${money(impact.conversion_value_before)} → ${money(
        impact.conversion_value_after
      )}`
    );
    lines.push(`• ROAS: ${roas(impact.roas_before)} → ${roas(impact.roas_after)}`);
    lines.push("");
    lines.push(`Verdict: ${impact.verdict.toUpperCase()}`);
    lines.push(`Summary: ${impact.summary}`);

    console.log(lines.join("\n"));
  } catch (error) {
    console.error("Failed to render impact report:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();