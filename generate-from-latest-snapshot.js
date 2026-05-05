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
    console.log("Claude raw output:");
    console.log(text);
    throw new Error("Claude did not return JSON.");
  }

  const jsonText = text.slice(start, end + 1);

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    console.log("Claude returned invalid JSON. Raw JSON attempt:");
    console.log("----------------------------------------");
    console.log(jsonText);
    console.log("----------------------------------------");
    throw error;
  }
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


function buildSearchTermCandidates(metrics) {
  const rows = Array.isArray(metrics.search_terms) ? metrics.search_terms : [];

  const negativeGrouped = new Map();
  const keywordGrouped = new Map();

  for (const row of rows) {
    const campaignName = row.campaign_name || "";
    const searchTerm = row.search_term || "";
    const cost = Number(row.cost || 0);
    const clicks = Number(row.clicks || 0);
    const conversions = Number(row.conversions || 0);
    const conversionValue = Number(row.conversion_value || 0);
    const roas = cost > 0 ? conversionValue / cost : 0;

    if (!searchTerm) continue;
    if (campaignName.toLowerCase().includes("branding")) continue;

    // Bad search terms: spent money but no conversions.
    if (cost >= 3 && conversions === 0) {
      if (!negativeGrouped.has(campaignName)) {
        negativeGrouped.set(campaignName, {
          campaign_name: campaignName,
          campaign_id: row.campaign_id || null,
          action_type: "ADD_NEGATIVES",
          total_cost: 0,
          terms: [],
        });
      }

      const item = negativeGrouped.get(campaignName);
      item.total_cost += cost;
      item.terms.push({
        search_term: searchTerm,
        cost,
        clicks,
        conversions,
        conversion_value: conversionValue,
        roas,
        ad_group_name: row.ad_group_name || null,
      });
    }

    // Good search terms: converting with strong ROAS.
    // Search terms usually come from SEM, so use SEM threshold >= 10x.
    if (cost >= 1 && conversions > 0 && roas >= 10) {
      if (!keywordGrouped.has(campaignName)) {
        keywordGrouped.set(campaignName, {
          campaign_name: campaignName,
          campaign_id: row.campaign_id || null,
          action_type: "ADD_KEYWORD",
          total_cost: 0,
          total_conversion_value: 0,
          terms: [],
        });
      }

      const item = keywordGrouped.get(campaignName);
      item.total_cost += cost;
      item.total_conversion_value += conversionValue;
      item.terms.push({
        search_term: searchTerm,
        cost,
        clicks,
        conversions,
        conversion_value: conversionValue,
        roas,
        ad_group_name: row.ad_group_name || null,
      });
    }
  }

  const negativeKeywords = Array.from(negativeGrouped.values())
    .map((item) => ({
      ...item,
      total_cost: Math.round(item.total_cost * 100) / 100,
      terms: item.terms.sort((a, b) => b.cost - a.cost).slice(0, 5),
    }))
    .filter((item) => item.total_cost >= 3)
    .sort((a, b) => b.total_cost - a.total_cost)
    .slice(0, 20);

  const newKeywords = Array.from(keywordGrouped.values())
    .map((item) => ({
      ...item,
      total_cost: Math.round(item.total_cost * 100) / 100,
      total_conversion_value: Math.round(item.total_conversion_value * 100) / 100,
      terms: item.terms
        .sort((a, b) => b.conversion_value - a.conversion_value)
        .slice(0, 5),
    }))
    .filter((item) => item.total_conversion_value > 0)
    .sort((a, b) => b.total_conversion_value - a.total_conversion_value)
    .slice(0, 20);

  return {
    negative_keywords: negativeKeywords,
    new_keywords: newKeywords,
  };
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const snapshot = await getLatestSnapshot(client);
    const metrics = snapshot.payload;

    metrics.search_term_candidates = buildSearchTermCandidates(metrics);

    console.log(
      "Negative keyword candidate groups:",
      metrics.search_term_candidates.negative_keywords.length
    );
    console.log(
      "New keyword candidate groups:",
      metrics.search_term_candidates.new_keywords.length
    );

    const alertId = `google_ads_script_${metrics.date}_${Date.now()}`;

const prompt = `
You are an expert Google Ads performance analyst for G2G.

You are generating daily Google Ads recommendations from a Google Ads Script metrics snapshot.

Return ONLY valid JSON. No markdown. No explanation outside JSON.

Context:
- G2G has two market groups: Main Market and Secondary Market.
- Campaign names identify the market. Use campaign names containing "Main Market" or "Main" for Main Market. Use campaign names containing "Secondary Market" or "Secondary" for Secondary Market.
- Exclude any campaign with "Branding" in the name from recommendations.
- SEM/Search healthy ROAS threshold: 10x.
- DG/Demand Gen healthy ROAS threshold: 20x.
- Yesterday's conversion value can lag. Do not overreact to one day of weak ROAS.

Allowed action_type values:
- RAISE_BUDGET
- DECREASE_BUDGET
- ADD_NEGATIVES
- ADD_KEYWORD
- PAUSE_KEYWORD
- ADJUST_TROAS
- REVIEW_POLICY
- EXPAND_REMARKETING
- ADD_AUDIENCE_SIGNAL
- REVIEW_SEARCH_TERMS
- REVIEW_CAMPAIGN
- MONITOR

Important:
- Do NOT use INVESTIGATE_TRACKING as a numbered recommendation.
- If attribution lag or tracking anomaly is suspected, include it only inside tracking_warning.
- Do not classify every zero-conversion campaign as a tracking issue.

Search term rules:
- The snapshot may include a search_terms array. If search_terms exists and contains rows, use it.
- For SEM/Search campaigns, prefer ADD_NEGATIVES over REVIEW_SEARCH_TERMS when actual poor search terms are present.
- Use ADD_NEGATIVES when one or more actual search terms in the same campaign have cost >= $3 and conversions = 0.
- For ADD_NEGATIVES, proposed_value must include negative_keywords as the exact search terms from the snapshot and match_type: "phrase".
- estimated_daily_impact for ADD_NEGATIVES should be the sum of cost from the zero-conversion search terms.
- Mention the exact search terms and their spend in the reason.
- Do not invent search terms. Only use search terms from snapshot.search_terms.
- Use REVIEW_SEARCH_TERMS only when search_terms are missing or insufficient.

Keyword and budget rules:
- Use PAUSE_KEYWORD only when actual keyword_text or keyword-level data is present in the snapshot.
- Use RAISE_BUDGET only when 7-day ROAS, current budget, and budget-limited or Lost IS Budget data are present.
- Use DECREASE_BUDGET only when 7-day ROAS data is present and the campaign is clearly below threshold.
- Do not invent keywords, ad groups, budgets, Lost IS, policy status, or 7-day metrics.

Recommendation quality rules:
- If the data is not deep enough for a direct mutation, use REVIEW_CAMPAIGN, REVIEW_SEARCH_TERMS, or MONITOR.
- estimated_daily_impact must be a number.
- If impact is uncertain but campaign spend is known, use the campaign cost as estimated_daily_impact instead of 0.
- Sort recommendations by estimated_daily_impact descending.
- Limit recommendations to the top 8 total. Prioritize direct ADD_NEGATIVES and ADD_KEYWORD actions from search_term_candidates.
- Try to include recommendations for both Main Market and Secondary Market when evidence exists.
- Recommendations should be practical, operational, concise, and not repetitive.
- Keep each reason under 180 characters.
- Prefer fewer high-confidence recommendations over many weak recommendations.

Budget recommendation rules:
- RAISE_BUDGET requires 7-day trailing ROAS at or above the threshold:
  - SEM/Search: 7-day ROAS >= 10x
  - DG/Demand Gen: 7-day ROAS >= 20x
- RAISE_BUDGET also requires Lost IS Budget > 15% or clear budget-limited evidence.
- Suggested budget increase must be between +10% and +20%.
- Never raise budget based only on yesterday's ROAS.
- DECREASE_BUDGET requires 7-day ROAS below 50% of the threshold and meaningful spend.
- Suggested budget decrease must be between -10% and -20%.
- Never cut budget based only on one bad day.

Classification guide:
- REVIEW_SEARCH_TERMS:
  Use when a SEM/Search campaign has spend, clicks, and weak or zero conversions, but search term data is not available.
- REVIEW_CAMPAIGN:
  Use when a campaign has low ROAS or poor efficiency but there is not enough evidence to recommend a direct mutation.
- MONITOR:
  Use when a campaign has unclear intent, possible attribution delay, or insufficient data to act.
- ADD_NEGATIVES:
  Use only when actual poor-performing search terms are present.
- PAUSE_KEYWORD:
  Use only when actual keyword-level data is present.
- REVIEW_POLICY:
  Use only when policy-limited or disapproval information is present.
- ADJUST_TROAS:
  Use only when bidding strategy or tROAS data is present.
- EXPAND_REMARKETING:
  Use only when audience or converter volume data is present.
- ADD_AUDIENCE_SIGNAL:
  Use only when ad group or audience performance data is present.

Required JSON shape:
{
  "alert_id": "string",
  "date": "YYYY-MM-DD",
  "market": "main_market",
  "account_id": "string",
  "summary": "string",
  "tracking_warning": {
    "detected": true or false,
    "severity": "none" or "low" or "medium" or "high",
    "reason": "string"
  },
  "recommendations": [
    {
      "id": "string",
      "number": 1,
      "action_type": "one of the allowed action_type values",
      "campaign_key": "string or null",
      "ad_group_key": "string or null",
      "keyword_text": "string or null",
      "current_value": {},
      "proposed_value": {},
      "reason": "string",
      "estimated_daily_impact": 0,
      "requires_google_ads_mutation": true or false,
      "risk_level": "low or medium or high"
    }
  ]
}

Output rules:
- Include alert_id, date, market, account_id, summary, tracking_warning, recommendations.
- Use alert_id exactly: "${alertId}".
- Use date exactly: "${metrics.date}".
- Use market exactly: "${metrics.market || "main_market"}".
- Use account_id exactly: "${metrics.account_id || ""}".
- Recommendation numbers should start at 1.
- Every recommendation id must be unique and should include the alert_id and recommendation number.
- REVIEW_CAMPAIGN, REVIEW_SEARCH_TERMS, MONITOR, and REVIEW_POLICY should usually have requires_google_ads_mutation set to false.
- DECREASE_BUDGET, RAISE_BUDGET, ADD_NEGATIVES, PAUSE_KEYWORD, ADJUST_TROAS, EXPAND_REMARKETING, and ADD_AUDIENCE_SIGNAL may require mutation only if enough evidence is present.
- Exclude Branding campaigns.
- Do not output recommendations for Branding campaigns.

Metrics snapshot:
${JSON.stringify(metrics, null, 2)}
`;

    const message = await anthropic.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 8000,
  system:
    "You return only strict valid JSON. Do not include markdown, comments, trailing commas, explanations, or text outside the JSON object. All string values must be properly escaped.",
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