require("dotenv").config({ override: true });

const { Client } = require("pg");
const { normalizeRecommendation } = require("./normalize-recommendations");

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatPreview(rec) {
  const normalized = normalizeRecommendation(rec);
  const action = normalized.normalized_action;

  const lines = [];

  lines.push(`Recommendation #${rec.recommendation_number}`);
  lines.push(`Action: ${action.action_type}`);
  lines.push(`Campaign: ${action.campaign_key || "unknown"}`);

  if (action.ad_group_key) {
    lines.push(`Ad group: ${action.ad_group_key}`);
  }

  if (action.action_type === "ADD_NEGATIVES") {
    lines.push("");
    lines.push("Would add negative keywords:");
    for (const kw of action.negative_keywords || []) {
      lines.push(`- "${kw}" (${action.match_type})`);
    }
    lines.push(`Apply level: ${action.apply_level}`);
    lines.push(`Estimated avoided waste: ${money(action.estimated_daily_impact)}/day`);
  }

  if (action.action_type === "ADD_KEYWORD") {
    lines.push("");
    lines.push("Would add keyword:");
    lines.push(`- "${action.keyword_text}" (${action.match_type})`);
    if (action.final_url) {
      lines.push(`Final URL: ${action.final_url}`);
    }
    lines.push(`Estimated conversion value upside: ${money(action.estimated_daily_impact)}/day`);
  }

  if (action.action_type === "PAUSE_KEYWORD") {
    lines.push("");
    lines.push("Would pause keyword:");
    lines.push(`- "${action.keyword_text || "unknown"}"${action.match_type ? ` (${action.match_type})` : ""}`);
    if (action.keyword_id) {
      lines.push(`Keyword ID: ${action.keyword_id}`);
    }
    lines.push(`Estimated avoided waste: ${money(action.estimated_daily_impact)}/day`);
  }

  lines.push("");
  lines.push(`Risk: ${action.risk_level}`);
  lines.push("Status: DRY RUN ONLY — no Google Ads changes made.");

  return lines.join("\n");
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const result = await client.query(`
      SELECT *
      FROM recommendations
      WHERE status = 'approved'
      ORDER BY created_at DESC, recommendation_number ASC
      LIMIT 20;
    `);

    if (result.rows.length === 0) {
      console.log("No approved recommendations found.");
      console.log("");
      console.log("For testing, approve one locally first, for example:");
      console.log("node approve.js 1");
      return;
    }

    console.log("Approved action dry-run preview");
    console.log("========================================");

    for (const rec of result.rows) {
      console.log("");
      console.log(formatPreview(rec));
      console.log("----------------------------------------");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed to preview approved actions:");
  console.error(error.message);
  process.exit(1);
});
