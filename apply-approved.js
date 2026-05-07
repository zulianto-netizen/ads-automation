require("dotenv").config({ override: true });

const { Client } = require("pg");
const { normalizeRecommendation } = require("./normalize-recommendations");

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatApplyPreview(rec) {
  const normalized = normalizeRecommendation(rec);
  const action = normalized.normalized_action;

  const lines = [];

  lines.push(`*DRY-RUN APPLY — #${rec.recommendation_number} ${action.action_type}*`);
  lines.push(`Campaign: ${action.campaign_key || "unknown"}`);

  if (action.ad_group_key) {
    lines.push(`Ad group: ${action.ad_group_key}`);
  }

  if (action.action_type === "ADD_NEGATIVES") {
    lines.push("");
    lines.push("*Would add negative keywords:*");

    if (!action.negative_keywords || action.negative_keywords.length === 0) {
      lines.push("• No negative keywords found.");
    } else {
      action.negative_keywords.forEach((kw) => {
        lines.push(`• "${kw}" (${action.match_type || "phrase"})`);
      });
    }

    lines.push(`Apply level: ${action.apply_level || "campaign"}`);
    lines.push(`Estimated avoided waste: ${money(action.estimated_daily_impact)}/day`);
  } else if (action.action_type === "ADD_KEYWORD") {
    lines.push("");
    lines.push("*Would add keyword:*");
    lines.push(`• "${action.keyword_text || "unknown"}" (${action.match_type || "exact"})`);

    if (action.final_url) {
      lines.push(`Final URL: ${action.final_url}`);
    }

    lines.push(`Estimated conversion value upside: ${money(action.estimated_daily_impact)}/day`);
  } else if (action.action_type === "PAUSE_KEYWORD") {
    lines.push("");
    lines.push("*Would pause keyword:*");
    lines.push(`• "${action.keyword_text || "unknown"}"${action.match_type ? ` (${action.match_type})` : ""}`);

    if (action.keyword_id) {
      lines.push(`Keyword ID: ${action.keyword_id}`);
    }

    lines.push(`Estimated avoided waste: ${money(action.estimated_daily_impact)}/day`);
  } else {
    lines.push("");
    lines.push(`No dry-run handler yet for action type: ${action.action_type}`);
  }

  lines.push("");
  lines.push("*Result:* No Google Ads changes made. This is dry-run only.");

  return lines.join("\n");
}

async function slackApi(method, body) {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_CHANNEL_ID) {
    console.log("Slack token/channel missing. Skipping Slack confirmation.");
    return null;
  }

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`${method} failed: ${data.error}`);
  }

  return data;
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
      return;
    }

    console.log("Approved recommendations dry-run apply");
    console.log("========================================");

    const previews = [];

    for (const rec of result.rows) {
      const preview = formatApplyPreview(rec);
      previews.push(preview);

      console.log("");
      console.log(preview);
      console.log("----------------------------------------");
    }

    const slackText =
      `:white_check_mark: *Approved recommendations dry-run apply*\n\n` +
      previews.join("\n\n────────────────────\n\n");

    await slackApi("chat.postMessage", {
      channel: process.env.SLACK_CHANNEL_ID,
      text: slackText,
      unfurl_links: false,
      unfurl_media: false,
    });

    console.log("Dry-run apply preview completed.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed to apply approved recommendations:");
  console.error(error.message);
  process.exit(1);
});
