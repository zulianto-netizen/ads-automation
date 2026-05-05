require("dotenv").config({ override: true });
const Anthropic = require("@anthropic-ai/sdk");
const { Client } = require("pg");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Claude did not return JSON.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function getLatestSnapshot(client) {
  const result = await client.query(
    `
    SELECT id, payload
    FROM ads_metric_snapshots
    WHERE source = 'google_ads_script'
    ORDER BY created_at DESC
    LIMIT 1;
    `
  );

  if (result.rows.length === 0) {
    throw new Error("No google_ads_script snapshot found.");
  }

  return result.rows[0];
}

async function saveClaudeRecommendations(client, data) {
  await client.query(
    `
    INSERT INTO alerts (
      id,
      alert_date,
      market,
      account_id,
      raw_report_text,
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET
      raw_report_text = EXCLUDED.raw_report_text,
      status = EXCLUDED.status;
    `,
    [
      data.alert_id,
      data.date,
      data.market,
      data.account_id || "google-ads-script-account",
      data.summary || "Claude generated alert from Google Ads Script snapshot",
      "created",
    ]
  );

  for (const rec of data.recommendations || []) {
    await client.query(
      `
      INSERT INTO recommendations (
        id,
        alert_id,
        recommendation_number,
        action_type,
        campaign_key,
        ad_group_key,
        keyword_text,
        current_value,
        proposed_value,
        reason,
        estimated_daily_impact,
        requires_google_ads_mutation,
        risk_level,
        status
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14
      )
      ON CONFLICT (id) DO UPDATE SET
        action_type = EXCLUDED.action_type,
        campaign_key = EXCLUDED.campaign_key,
        ad_group_key = EXCLUDED.ad_group_key,
        keyword_text = EXCLUDED.keyword_text,
        current_value = EXCLUDED.current_value,
        proposed_value = EXCLUDED.proposed_value,
        reason = EXCLUDED.reason,
        estimated_daily_impact = EXCLUDED.estimated_daily_impact,
        requires_google_ads_mutation = EXCLUDED.requires_google_ads_mutation,
        risk_level = EXCLUDED.risk_level,
        status = EXCLUDED.status;
      `,
      [
        rec.id,
        data.alert_id,
        rec.number,
        rec.action_type,
        rec.campaign_key || null,
        rec.ad_group_key || null,
        rec.keyword_text || null,
        JSON.stringify(rec.current_value || {}),
        JSON.stringify(rec.proposed_value || {}),
        rec.reason || "",
        typeof rec.estimated_daily_impact === "number"
          ? rec.estimated_daily_impact
          : Number(
              rec.estimated_daily_impact?.conversion_value ||
                rec.estimated_daily_impact?.cost ||
                0
            ),
        rec.requires_google_ads_mutation === false ? false : true,
        rec.risk_level || "medium",
        "pending_approval",
      ]
    );
  }
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const snapshot = await getLatestSnapshot(client);
    const metrics = snapshot.payload;

    const alertId = `google_ads_script_${metrics.date}_${Date.now()}`;

    const prompt = `
You are an expert Google Ads performance analyst for G2G.

Given this Google Ads Script metrics snapshot, generate a recommendation manifest.

Return ONLY valid JSON. No markdown. No explanation outside JSON.

Allowed action_type values:
- INVESTIGATE_TRACKING
- RAISE_BUDGET
- ADD_NEGATIVES
- PAUSE_KEYWORD

Rules:
- Include alert_id, date, market, account_id, summary, tracking_warning, recommendations.
- Use alert_id exactly: "${alertId}".
- Use date exactly: "${metrics.date}".
- Use market exactly: "${metrics.market || "main_market"}".
- Use account_id exactly: "${metrics.account_id || ""}".
- Recommendation numbers should start at 1.
- If conversion value looks suspiciously low compared to spend, include INVESTIGATE_TRACKING.
- For RAISE_BUDGET, proposed_value must include budget.
- If you do not know the current budget, do not recommend RAISE_BUDGET.
- For ADD_NEGATIVES, proposed_value must include negative_keywords and match_type.
- Only recommend ADD_NEGATIVES if search term data exists. If no search term data exists, do not invent search terms.
- For PAUSE_KEYWORD, proposed_value must include status: "paused".
- Only recommend PAUSE_KEYWORD if keyword_text exists. If no keyword data exists, do not invent keywords.
- Every recommendation must include:
  id, number, action_type, campaign_key, current_value, proposed_value, reason,
  estimated_daily_impact, requires_google_ads_mutation, risk_level.

Metrics snapshot:
${JSON.stringify(metrics, null, 2)}
`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2500,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text = message.content[0].text;
    const data = extractJson(text);

    await saveClaudeRecommendations(client, data);

    console.log("Claude generated recommendations from latest Google Ads Script snapshot.");
    console.log("Snapshot ID:", snapshot.id);
    console.log("Alert ID:", data.alert_id);
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Failed:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();