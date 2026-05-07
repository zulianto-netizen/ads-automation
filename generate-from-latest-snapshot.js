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



function pickMetricFields(row) {
  if (!row || typeof row !== "object") return row;

  return {
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name || row.campaign_key,
    ad_group_id: row.ad_group_id,
    ad_group_name: row.ad_group_name,
    keyword_id: row.keyword_id,
    keyword_text: row.keyword_text,
    match_type: row.match_type,
    search_term: row.search_term,
    status: row.status,
    cost: row.cost,
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
    conversion_value: row.conversion_value,
    roas: row.roas
  };
}

function limitRowsForClaude(rows, limit, sortField = "cost") {
  if (!Array.isArray(rows)) return [];

  return [...rows]
    .sort((a, b) => Number(b[sortField] || 0) - Number(a[sortField] || 0))
    .slice(0, limit)
    .map(pickMetricFields);
}

function compactCandidatesForClaude(rows, limit = 12) {
  if (!Array.isArray(rows)) return [];

  return rows.slice(0, limit).map((item) => {
    if (!item || typeof item !== "object") return item;

    const compact = pickMetricFields(item);

    // Preserve common candidate fields without carrying huge nested objects.
    compact.campaign_key = item.campaign_key || item.campaign_name;
    compact.ad_group_key = item.ad_group_key || item.ad_group_name;
    compact.keyword_text = item.keyword_text;
    compact.search_term = item.search_term;
    compact.wasted_spend = item.wasted_spend;
    compact.estimated_daily_impact = item.estimated_daily_impact;
    compact.reason = item.reason;

    if (Array.isArray(item.keywords)) {
      compact.keywords = item.keywords.slice(0, 6);
    }

    if (Array.isArray(item.terms)) {
      compact.terms = item.terms.slice(0, 6);
    }

    if (Array.isArray(item.search_terms)) {
      compact.search_terms = item.search_terms.slice(0, 6).map(pickMetricFields);
    }

    if (Array.isArray(item.items)) {
      compact.items = item.items.slice(0, 6).map(pickMetricFields);
    }

    return compact;
  });
}

function compactMetricsForClaude(metrics) {
  return {
    id: metrics.id,
    source: metrics.source,
    market: metrics.market,
    account_id: metrics.account_id,
    account_name: metrics.account_name,
    date: metrics.date,

    account_totals: metrics.account_totals,
    account_totals_7d: metrics.account_totals_7d,
    account_totals_30d: metrics.account_totals_30d,

    // Smaller raw slices. Main recommendation logic should come from candidates below.
    campaigns: limitRowsForClaude(metrics.campaigns, 40),
    campaigns_7d: limitRowsForClaude(metrics.campaigns_7d, 50),
    campaigns_30d: limitRowsForClaude(metrics.campaigns_30d, 50),

    ad_groups: limitRowsForClaude(metrics.ad_groups, 40),
    ad_groups_7d: limitRowsForClaude(metrics.ad_groups_7d, 60),
    ad_groups_30d: limitRowsForClaude(metrics.ad_groups_30d, 60),

    search_terms: limitRowsForClaude(metrics.search_terms, 40),
    search_terms_7d: limitRowsForClaude(metrics.search_terms_7d, 70),
    search_terms_30d: limitRowsForClaude(metrics.search_terms_30d, 70),

    keywords: limitRowsForClaude(metrics.keywords, 50),
    keywords_7d: limitRowsForClaude(metrics.keywords_7d, 70),
    keywords_30d: limitRowsForClaude(metrics.keywords_30d, 70),

    // Pre-built candidates, also compacted.
    search_term_candidates: compactCandidatesForClaude(metrics.search_term_candidates, 12),
    new_keyword_candidates: compactCandidatesForClaude(metrics.new_keyword_candidates, 12),
    keyword_pause_candidates: compactCandidatesForClaude(metrics.keyword_pause_candidates, 12),
    negative_keyword_candidates: compactCandidatesForClaude(metrics.negative_keyword_candidates, 12)
  };
}

function normalizeTermForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function termTokens(value) {
  return new Set(
    normalizeTermForCompare(value)
      .split(" ")
      .filter((token) => token.length > 1)
  );
}

function tokenOverlapRatio(a, b) {
  const aTokens = termTokens(a);
  const bTokens = termTokens(b);

  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }

  return overlap / Math.min(aTokens.size, bTokens.size);
}

function areCloseSearchTerms(a, b) {
  const normalizedA = normalizeTermForCompare(a);
  const normalizedB = normalizeTermForCompare(b);

  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
    return true;
  }

  return tokenOverlapRatio(normalizedA, normalizedB) >= 0.65;
}

function getKeywordOpportunityTerms(recommendations) {
  const terms = [];

  for (const rec of recommendations || []) {
    if (rec.action_type !== "ADD_KEYWORD") continue;

    const proposed = rec.proposed_value || {};

    const candidates = [
      rec.keyword_text,
      proposed.keyword,
      proposed.keyword_text,
      ...(Array.isArray(proposed.keywords) ? proposed.keywords : []),
      ...(Array.isArray(proposed.new_keywords) ? proposed.new_keywords : []),
    ];

    for (const term of candidates) {
      if (term) terms.push(String(term));
    }
  }

  return terms;
}

function isProtectedCoreIntentTerm(term, campaignKey) {
  const t = normalizeTermForCompare(term);
  const c = normalizeTermForCompare(campaignKey);

  if (!t) return false;

  const protectedPatterns = [
    "wow gold",
    "buy wow gold",
    "world of warcraft gold",
    "wow tbc gold",
    "tbc gold",
    "tbc anniversary gold",
    "poe currency",
    "path of exile currency",
    "poe2 gold",
    "poe gold",
    "growtopia",
    "apex legends",
    "diablo 4",
    "d4 gold",
  ];

  for (const pattern of protectedPatterns) {
    const p = normalizeTermForCompare(pattern);

    if (t === p || t.includes(p) || p.includes(t)) {
      // Protect product-intent terms when campaign appears to sell that product/category.
      if (
        c.includes("game coin") ||
        c.includes("wow") ||
        c.includes("path of exile") ||
        c.includes("poe") ||
        c.includes("growtopia") ||
        c.includes("diablo") ||
        c.includes("apex")
      ) {
        return true;
      }
    }
  }

  return false;
}

function extractNegativeKeywords(rec) {
  const proposed = rec.proposed_value || {};
  const values =
    proposed.negative_keywords ||
    proposed.keywords ||
    proposed.terms ||
    proposed.new_negative_keywords ||
    [];

  if (!Array.isArray(values)) return [];

  return values.map(String).map((x) => x.trim()).filter(Boolean);
}

function setNegativeKeywords(rec, terms) {
  rec.proposed_value = rec.proposed_value || {};

  if (Array.isArray(rec.proposed_value.negative_keywords)) {
    rec.proposed_value.negative_keywords = terms;
  } else if (Array.isArray(rec.proposed_value.keywords)) {
    rec.proposed_value.keywords = terms;
  } else if (Array.isArray(rec.proposed_value.terms)) {
    rec.proposed_value.terms = terms;
  } else {
    rec.proposed_value.negative_keywords = terms;
  }
}

function maybeNormalizeDailyImpact(rec) {
  const action = rec.action_type;
  const proposed = rec.proposed_value || {};
  const current = rec.current_value || {};

  const impact = Number(rec.estimated_daily_impact || 0);
  if (impact <= 0) return rec;

  let sevenDayTotal = null;
  let thirtyDayTotal = null;

  if (action === "PAUSE_KEYWORD" || action === "ADD_NEGATIVES") {
    sevenDayTotal =
      Number(current.cost_7d || proposed.cost_7d || proposed.wasted_spend_7d || 0) ||
      null;

    thirtyDayTotal =
      Number(current.cost_30d || proposed.cost_30d || proposed.wasted_spend_30d || 0) ||
      null;
  }

  if (action === "ADD_KEYWORD") {
    sevenDayTotal =
      Number(
        current.conversion_value_7d ||
          proposed.conversion_value_7d ||
          proposed.value_7d ||
          0
      ) || null;

    thirtyDayTotal =
      Number(
        current.conversion_value_30d ||
          proposed.conversion_value_30d ||
          proposed.value_30d ||
          0
      ) || null;
  }

  // If Claude already returned daily impact, do not divide again.
  // Example: cost_7d = 41.61 and impact = 5.94, that is already daily.
  if (sevenDayTotal) {
    const daily = sevenDayTotal / 7;

    if (Math.abs(impact - daily) / Math.max(daily, 1) < 0.25) {
      rec.estimated_daily_impact = daily;
      return rec;
    }

    // If impact looks like the full 7d total, convert to daily.
    if (impact > daily * 2 && impact <= sevenDayTotal * 1.25) {
      rec.estimated_daily_impact = daily;
      return rec;
    }
  }

  if (thirtyDayTotal) {
    const daily = thirtyDayTotal / 30;

    if (Math.abs(impact - daily) / Math.max(daily, 1) < 0.25) {
      rec.estimated_daily_impact = daily;
      return rec;
    }

    if (impact > daily * 2 && impact <= thirtyDayTotal * 1.25) {
      rec.estimated_daily_impact = daily;
      return rec;
    }
  }

  // Fallback: do not blindly divide.
  return rec;
}

function cleanClaudeRecommendations(recommendations) {
  const original = Array.isArray(recommendations) ? recommendations : [];
  const keywordOpportunityTerms = getKeywordOpportunityTerms(original);
  const cleaned = [];

  for (const rawRec of original) {
    const rec = JSON.parse(JSON.stringify(rawRec));
    maybeNormalizeDailyImpact(rec);

    if (rec.action_type === "ADD_NEGATIVES") {
      const campaignKey = rec.campaign_key || "";
      const negativeTerms = extractNegativeKeywords(rec);

      const safeTerms = negativeTerms.filter((term) => {
        if (isProtectedCoreIntentTerm(term, campaignKey)) {
          return false;
        }

        for (const opportunity of keywordOpportunityTerms) {
          if (areCloseSearchTerms(term, opportunity)) {
            return false;
          }
        }

        return true;
      });

      if (safeTerms.length === 0) {
        continue;
      }

      setNegativeKeywords(rec, safeTerms);

      if (safeTerms.length !== negativeTerms.length) {
        rec.reason =
          String(rec.reason || "") +
          " Cleanup note: removed negative terms that conflicted with keyword opportunities or protected core product intent.";
      }
    }

    cleaned.push(rec);
  }

  cleaned.sort(
    (a, b) =>
      Number(b.estimated_daily_impact || 0) -
      Number(a.estimated_daily_impact || 0)
  );

  return cleaned.slice(0, 8).map((rec, index) => ({
    ...rec,
    recommendation_number: index + 1,
    id: `${rec.alert_id || "alert"}_${index + 1}`,
  }));
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

  const cleanedRecommendations = cleanClaudeRecommendations(data.recommendations || []);

  await client.query(
    `DELETE FROM recommendations WHERE alert_id = $1;`,
    [data.alert_id]
  );

  for (const rec of cleanedRecommendations) {
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
  const rows = Array.isArray(metrics.search_terms_7d) ? metrics.search_terms_7d : (Array.isArray(metrics.search_terms) ? metrics.search_terms : []);

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


function buildKeywordPauseCandidates(metrics) {
  const rows = Array.isArray(metrics.keywords_7d) ? metrics.keywords_7d : (Array.isArray(metrics.keywords) ? metrics.keywords : []);

  return rows
    .filter((row) => {
      const campaignName = row.campaign_name || "";
      const cost = Number(row.cost || 0);
      const conversions = Number(row.conversions || 0);

      if (campaignName.toLowerCase().includes("branding")) return false;
      if (!row.keyword_text) return false;

      return cost >= 3 && conversions === 0;
    })
    .map((row) => ({
      action_type: "PAUSE_KEYWORD",
      campaign_name: row.campaign_name,
      campaign_id: row.campaign_id || null,
      ad_group_name: row.ad_group_name || null,
      ad_group_id: row.ad_group_id || null,
      keyword_id: row.keyword_id || null,
      keyword_text: row.keyword_text,
      match_type: row.match_type || null,
      cost: Number(row.cost || 0),
      clicks: Number(row.clicks || 0),
      conversions: Number(row.conversions || 0),
      conversion_value: Number(row.conversion_value || 0),
      roas: Number(row.roas || 0),
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);
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
    metrics.keyword_pause_candidates = buildKeywordPauseCandidates(metrics);

    console.log(
      "Negative keyword candidate groups:",
      metrics.search_term_candidates.negative_keywords.length
    );
    console.log(
      "New keyword candidate groups:",
      metrics.search_term_candidates.new_keywords.length
    );
    console.log(
      "Keyword pause candidates:",
      metrics.keyword_pause_candidates.length
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

Important:
- Do not output REVIEW_CAMPAIGN, REVIEW_SEARCH_TERMS, MONITOR, REVIEW_ADGROUP, or INVESTIGATE_TRACKING as recommendations.
- Recommendations must be direct actions with enough evidence.
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

Evidence and action rules:
- The snapshot includes 1-day, 7-day, and 30-day data when available:
  campaigns/search_terms/ad_groups/keywords for yesterday,
  campaigns_7d/search_terms_7d/ad_groups_7d/keywords_7d,
  campaigns_30d/search_terms_30d/ad_groups_30d/keywords_30d.
- Prefer 7-day evidence over 1-day evidence for direct actions.
- Use 30-day evidence as historical context to avoid overreacting to short-term attribution lag.
- Do not recommend direct mutations from yesterday-only evidence when 7-day data exists.
- When a recommendation uses 7-day data, estimated_daily_impact MUST equal the 7-day value divided by 7.
- When a recommendation uses 30-day data, estimated_daily_impact MUST equal the 30-day value divided by 30.
- Do not label total 7-day conversion value or 7-day wasted spend as daily impact.
- Include data_window_used in every recommendation: "1d", "7d", "30d", or "1d+7d+30d".
- Include evidence_metrics in proposed_value or current_value when possible: cost_7d, conversions_7d, conversion_value_7d, roas_7d.

SEM rules:
- ADD_NEGATIVES: use search_terms_7d first. Recommend only when spend is meaningful and conversions are 0 or ROAS is clearly poor. Use phrase negatives by default only for clearly irrelevant terms.
- For ADD_NEGATIVES, do not add broad/core product-intent terms as negatives when they are close variants of converting search terms in the same campaign/ad group.
- For ADD_NEGATIVES, never conflict with ADD_KEYWORD recommendations in the same report. If a term is close to a keyword opportunity, do not recommend it as a negative.
- ADD_KEYWORD: use search_terms_7d first. Recommend only when the search term has conversions and strong ROAS. Use exact match by default.
- ADD_KEYWORD must include the exact search term, 7d cost, 7d conversions, 7d conversion value, and 7d ROAS.
- PAUSE_KEYWORD: use keywords_7d first. Do not pause based on 1-day data only. Recommend only when 7d spend is meaningful and conversions are 0 or ROAS is clearly poor.
- CONVERT_MATCH_TYPE is not allowed yet unless explicit existing keyword + search term evidence is present.

Demand Gen rules:
- Do not recommend ADD_NEGATIVES, ADD_KEYWORD, PAUSE_KEYWORD, or CONVERT_MATCH_TYPE for Demand Gen campaigns.
- Demand Gen recommendations should wait for placement, creative, final URL, audience, budget, or bidding data.
- Until those data sources exist, omit weak Demand Gen recommendations instead of creating generic review actions.

Budget and bidding rules:
- Do not recommend RAISE_BUDGET, DECREASE_BUDGET, or ADJUST_TROAS unless current budget, budget utilization or lost impression share/budget-limited evidence is present.
- Do not invent budgets, Lost IS, tROAS, policy status, final URLs, placement data, or creative performance.

Recommendation quality rules:
- If the data is not deep enough for a direct action, do not create a recommendation.
- estimated_daily_impact must be a number.
- If impact is uncertain but campaign spend is known, use the campaign cost as estimated_daily_impact instead of 0.
- Sort recommendations by estimated_daily_impact descending.
- Limit recommendations to the top 8 total. Prioritize direct ADD_NEGATIVES and ADD_KEYWORD actions from search_term_candidates.
- Try to include recommendations for both Main Market and Secondary Market only when direct-action evidence exists.
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
- REVIEW_POLICY should usually have requires_google_ads_mutation set to false.
- DECREASE_BUDGET, RAISE_BUDGET, ADD_NEGATIVES, PAUSE_KEYWORD, ADJUST_TROAS, EXPAND_REMARKETING, and ADD_AUDIENCE_SIGNAL may require mutation only if enough evidence is present.
- Exclude Branding campaigns.
- Do not output recommendations for Branding campaigns.

Metrics snapshot:
${JSON.stringify(compactMetricsForClaude(metrics), null, 2)}
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