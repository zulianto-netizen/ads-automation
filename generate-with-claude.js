require("dotenv").config({ override: true });
const Anthropic = require("@anthropic-ai/sdk");
const { Client } = require("pg");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const sampleMetrics = {
  alert_id: "2026-05-03-main-market-claude",
  date: "2026-05-03",
  market: "main_market",
  account_totals: {
    cost: 1168.33,
    cost_change_pct: -5.7,
    clicks: 1068,
    clicks_change_pct: -6.81,
    conversions: 263.98,
    conversions_change_pct: -52.84,
    conversion_value: 5783.28,
    conversion_value_change_pct: -52.99,
    roas: 4.95,
    roas_previous: 9.93
  },
  campaigns: [
    {
      campaign_key: "007_DG_PO",
      type: "DG",
      cost: 5.35,
      conversion_value: 312.37,
      roas: 58.37,
      budget_limited: true,
      current_budget: 5.24
    },
    {
      campaign_key: "001_DG_US",
      type: "DG",
      cost: 32.44,
      conversion_value: 951.61,
      roas: 29.34,
      budget_limited: true,
      current_budget: 32.44
    },
    {
      campaign_key: "122_US2",
      type: "SEM",
      ad_group_key: "Honkai_Star_Rail",
      cost: 27.35,
      conversions: 0,
      search_terms: ["hsr account", "hsr top up"]
    },
    {
      campaign_key: "124_DE2",
      type: "SEM",
      ad_group_key: "Spotify",
      keyword_text: "spotify_broad",
      cost: 7.73,
      conversions: 0
    }
  ],
  thresholds: {
    DG_min_roas: 20,
    SEM_min_roas: 10
  }
};

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Claude did not return JSON.");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function saveToDatabase(data) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();

  try {
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
        "test-account",
        data.summary || "Claude generated alert",
        "created",
      ]
    );

    for (const rec of data.recommendations) {
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
          rec.reason,
         typeof rec.estimated_daily_impact === "number"
  ? rec.estimated_daily_impact
  : Number(rec.estimated_daily_impact?.conversion_value || rec.estimated_daily_impact?.cost || 0),
          rec.requires_google_ads_mutation,
          rec.risk_level || "medium",
          "pending_approval",
        ]
      );
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const prompt = `
You are an expert Google Ads performance analyst.

Given the metrics below, generate a daily alert recommendation manifest.

Return ONLY valid JSON. No markdown. No explanation outside JSON.

Rules:
- Include alert_id, date, market, summary, tracking_warning, and recommendations.
- Recommendation numbers should be 1, 2, 3, etc.
- Allowed action_type values:
  INVESTIGATE_TRACKING
  RAISE_BUDGET
  ADD_NEGATIVES
  PAUSE_KEYWORD
- If conversion value drops much more than cost, include INVESTIGATE_TRACKING as recommendation 1.
- If tracking warning is high severity, budget raises should still be listed but risk_level should be high.
- For RAISE_BUDGET, proposed_value must include budget.
- For ADD_NEGATIVES, proposed_value must include negative_keywords and match_type.
- For PAUSE_KEYWORD, proposed_value must include status: "paused".
- Every recommendation must include:
  id, number, action_type, campaign_key, current_value, proposed_value, reason,
  estimated_daily_impact, requires_google_ads_mutation, risk_level.

Metrics:
${JSON.stringify(sampleMetrics, null, 2)}
`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = message.content[0].text;
  const data = extractJson(text);

  await saveToDatabase(data);

  console.log("Claude generated recommendations and saved them to Neon.");
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error("Failed:");
  console.error(error.message);
});