function normalizeMatchType(value, fallback = "phrase") {
  const raw = String(value || fallback).toLowerCase();

  if (raw.includes("exact")) return "exact";
  if (raw.includes("phrase")) return "phrase";
  if (raw.includes("broad")) return "broad";

  return fallback;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return null;
}

function normalizeRecommendation(rec) {
  const proposed = rec.proposed_value || {};
  const current = rec.current_value || {};
  const actionType = rec.action_type;

  const normalized = {
    ...rec,
    action_type: actionType,
    current_value: current,
    proposed_value: proposed,
    normalized_action: {
      action_type: actionType,
      campaign_key: rec.campaign_key || null,
      ad_group_key: rec.ad_group_key || current.ad_group_name || proposed.ad_group_name || null,
      estimated_daily_impact: Number(rec.estimated_daily_impact || 0),
      risk_level: rec.risk_level || "medium",
      requires_google_ads_mutation: Boolean(rec.requires_google_ads_mutation),
    },
  };

  if (actionType === "ADD_NEGATIVES") {
    const negativeKeywords =
      proposed.negative_keywords ||
      proposed.keywords ||
      proposed.terms ||
      [];

    normalized.normalized_action = {
      ...normalized.normalized_action,
      negative_keywords: Array.isArray(negativeKeywords)
        ? negativeKeywords.map(String).filter(Boolean)
        : [],
      match_type: normalizeMatchType(proposed.match_type, "phrase"),
      apply_level: proposed.apply_level || "campaign",
    };
  }

  if (actionType === "ADD_KEYWORD") {
    const keyword = firstNonEmpty(
      proposed.keyword,
      proposed.keyword_text,
      Array.isArray(proposed.keywords) ? proposed.keywords[0] : null,
      Array.isArray(proposed.new_keywords) ? proposed.new_keywords[0] : null,
      rec.keyword_text
    );

    normalized.keyword_text = keyword || rec.keyword_text || null;

    normalized.normalized_action = {
      ...normalized.normalized_action,
      keyword_text: keyword,
      match_type: "exact",
      final_url: proposed.final_url || proposed.landing_page || null,
    };

    normalized.proposed_value = {
      ...proposed,
      keyword,
      match_type: "exact",
    };
  }

  if (actionType === "PAUSE_KEYWORD") {
    const keyword = firstNonEmpty(
      rec.keyword_text,
      current.keyword_text,
      proposed.keyword_text,
      proposed.keyword
    );

    normalized.keyword_text = keyword || rec.keyword_text || null;

    normalized.normalized_action = {
      ...normalized.normalized_action,
      keyword_id: current.keyword_id || proposed.keyword_id || null,
      keyword_text: keyword,
      match_type: normalizeMatchType(current.match_type || proposed.match_type, ""),
      new_status: "paused",
    };

    normalized.proposed_value = {
      ...proposed,
      status: "paused",
    };
  }

  return normalized;
}

module.exports = {
  normalizeRecommendation,
};
