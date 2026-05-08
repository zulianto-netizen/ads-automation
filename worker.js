import { neon } from "@neondatabase/serverless";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

function getPath(request) {
  return new URL(request.url).pathname;
}

function getReportDate(payload) {
  return payload.date || payload.report_date || new Date().toISOString().slice(0, 10);
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function verifySlackRequest(request, rawBody, env) {
  if (!env.SLACK_SIGNING_SECRET) {
    throw new Error("SLACK_SIGNING_SECRET is missing.");
  }

  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const slackSignature = request.headers.get("X-Slack-Signature");

  if (!timestamp || !slackSignature) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const requestAge = Math.abs(now - Number(timestamp));

  if (requestAge > 60 * 5) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(baseString)
  );

  const hex = [...new Uint8Array(signatureBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expected = `v0=${hex}`;

  return expected === slackSignature;
}

async function handleGoogleAdsSnapshot(request, env) {
  const payload = await request.json();

  const sql = neon(env.DATABASE_URL);

  const id = payload.id || makeId("google_ads_script");
  const source = payload.source || "google_ads_script";
  const reportDate = getReportDate(payload);
  const accountId = payload.account_id || null;

  await sql`
    INSERT INTO ads_metric_snapshots (
      id,
      source,
      account_id,
      report_date,
      payload
    )
    VALUES (
      ${id},
      ${source},
      ${accountId},
      ${reportDate},
      ${JSON.stringify(payload)}
    )
    ON CONFLICT (id)
    DO UPDATE SET
      payload = EXCLUDED.payload,
      created_at = now()
  `;

  return jsonResponse({
    ok: true,
    message: "Snapshot saved to Neon",
    id,
  });
}

async function handleSlackCommand(request, env) {
  const rawBody = await request.text();

  const isValid = await verifySlackRequest(request, rawBody, env);

  if (!isValid) {
    return textResponse("Invalid Slack signature.", 401);
  }

  const params = new URLSearchParams(rawBody);

  const command = params.get("command") || "";
  const text = params.get("text") || "";
  const channelId = params.get("channel_id") || "";
  const userId = params.get("user_id") || "";
  const teamId = params.get("team_id") || "";
  const responseUrl = params.get("response_url") || "";

  const id = makeId("adgroup_request");

  const sql = neon(env.DATABASE_URL);

  await sql`
    INSERT INTO adgroup_creation_requests (
      id,
      slack_channel_id,
      slack_user_id,
      slack_team_id,
      slack_response_url,
      command,
      raw_text,
      status
    )
    VALUES (
      ${id},
      ${channelId},
      ${userId},
      ${teamId},
      ${responseUrl},
      ${command},
      ${text},
      'received'
    )
  `;

  return jsonResponse({
    response_type: "ephemeral",
    text:
      `Received ad group request.\n` +
      `Request ID: ${id}\n\n` +
      `I will generate a draft preview shortly.`,
  });
}



async function postSlackMessage(env, channel, threadTs, text) {
  if (!env.SLACK_BOT_TOKEN || !channel) {
    return false;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      thread_ts: threadTs || undefined,
      text,
    }),
  });

  const data = await response.json();

  if (!data.ok) {
    console.error("chat.postMessage failed:", data.error);
    return false;
  }

  return true;
}


function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

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

function normalizeWorkerRecommendation(rec) {
  const proposed = rec.proposed_value || {};
  const current = rec.current_value || {};
  const actionType = rec.action_type;

  const action = {
    action_type: actionType,
    campaign_key: rec.campaign_key || null,
    ad_group_key:
      rec.ad_group_key ||
      current.ad_group_name ||
      proposed.ad_group_name ||
      null,
    estimated_daily_impact: Number(rec.estimated_daily_impact || 0),
  };

  if (actionType === "ADD_NEGATIVES") {
    const negativeKeywords =
      proposed.negative_keywords ||
      proposed.keywords ||
      proposed.terms ||
      [];

    return {
      ...action,
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

    return {
      ...action,
      keyword_text: keyword,
      match_type: "exact",
      final_url: proposed.final_url || proposed.landing_page || null,
    };
  }

  if (actionType === "PAUSE_KEYWORD") {
    const keyword = firstNonEmpty(
      rec.keyword_text,
      current.keyword_text,
      proposed.keyword_text,
      proposed.keyword
    );

    return {
      ...action,
      keyword_id: current.keyword_id || proposed.keyword_id || null,
      keyword_text: keyword,
      match_type: normalizeMatchType(current.match_type || proposed.match_type, ""),
      new_status: "paused",
    };
  }

  return action;
}

function formatWorkerDryRun(rec) {
  const action = normalizeWorkerRecommendation(rec);
  const lines = [];

  lines.push(`*#${rec.recommendation_number} ${action.action_type}*`);
  lines.push(`Campaign: ${action.campaign_key || "unknown"}`);

  if (action.ad_group_key) {
    lines.push(`Ad group: ${action.ad_group_key}`);
  }

  if (action.action_type === "ADD_NEGATIVES") {
    lines.push("");
    lines.push("*Would add negative keywords:*");

    if ((action.negative_keywords || []).length === 0) {
      lines.push("• No negative keywords found in recommendation payload.");
    } else {
      for (const kw of action.negative_keywords || []) {
        lines.push(`• "${kw}" (${action.match_type})`);
      }
    }

    lines.push(`Apply level: ${action.apply_level}`);
    lines.push(`Est. avoid ${money(action.estimated_daily_impact)}/day`);
  } else if (action.action_type === "ADD_KEYWORD") {
    lines.push("");
    lines.push("*Would add keyword:*");
    lines.push(`• "${action.keyword_text || "unknown"}" (${action.match_type})`);

    if (action.final_url) {
      lines.push(`Final URL: ${action.final_url}`);
    }

    lines.push(`Est. +${money(action.estimated_daily_impact)}/day cv`);
  } else if (action.action_type === "PAUSE_KEYWORD") {
    lines.push("");
    lines.push("*Would pause keyword:*");
    lines.push(
      `• "${action.keyword_text || "unknown"}"${
        action.match_type ? ` (${action.match_type})` : ""
      }`
    );

    if (action.keyword_id) {
      lines.push(`Keyword ID: ${action.keyword_id}`);
    }

    lines.push(`Est. avoid ${money(action.estimated_daily_impact)}/day`);
  } else {
    lines.push("");
    lines.push(`Dry-run preview available for ${action.action_type}.`);
  }

  lines.push("");
  lines.push("*Status:* DRY RUN ONLY — no Google Ads changes made yet.");

  return lines.join("\n");
}

async function getRecommendationForButton(sql, recommendationId, alertId, recommendationNumber) {
  if (recommendationId) {
    const rows = await sql`
      SELECT *
      FROM recommendations
      WHERE id = ${recommendationId}
      LIMIT 1
    `;

    if (rows.length > 0) return rows[0];
  }

  if (alertId && recommendationNumber) {
    const rows = await sql`
      SELECT *
      FROM recommendations
      WHERE alert_id = ${alertId}
        AND recommendation_number = ${recommendationNumber}
      LIMIT 1
    `;

    if (rows.length > 0) return rows[0];
  }

  return null;
}

async function handleSlackInteraction(request, env) {
  const rawBody = await request.text();
  let responseUrl = null;
  let channelId = null;
  let threadTs = null;

  try {
    const isValid = await verifySlackRequest(request, rawBody, env);

    if (!isValid) {
      return textResponse("Invalid Slack signature.", 401);
    }

    const params = new URLSearchParams(rawBody);
    const payloadText = params.get("payload");

    if (!payloadText) {
      return textResponse("Missing Slack interaction payload.", 400);
    }

    const payload = JSON.parse(payloadText);
    responseUrl = payload.response_url;
    channelId = payload.channel && payload.channel.id;
    threadTs =
      (payload.message && (payload.message.thread_ts || payload.message.ts)) ||
      (payload.container && payload.container.message_ts) ||
      null;

    const action = payload.actions && payload.actions[0];

    if (!action) {
      return textResponse("No Slack action found.", 400);
    }

    let actionValue = {};

    try {
      actionValue = JSON.parse(action.value || "{}");
    } catch (error) {
      actionValue = {};
    }

    const clickedAction = actionValue.action || action.action_id;
    const recommendationId = actionValue.recommendation_id || null;
    const alertId = actionValue.alert_id || null;
    const recommendationNumber = actionValue.recommendation_number || null;

    const sql = neon(env.DATABASE_URL);

    let responseText = "";

    if (clickedAction === "details") {
      responseText =
        `Details requested for recommendation #${recommendationNumber || "unknown"}.\n` +
        `Alert: ${alertId || "unknown"}\n\n` +
        `Detailed preview will be expanded in the next version.`;
    } else if (clickedAction === "approve" || clickedAction === "decline") {
      const newStatus = clickedAction === "approve" ? "approved" : "declined";

      if (recommendationId) {
        await sql`
          UPDATE recommendations
          SET status = ${newStatus}
          WHERE id = ${recommendationId}
        `;
      } else if (alertId && recommendationNumber) {
        await sql`
          UPDATE recommendations
          SET status = ${newStatus}
          WHERE alert_id = ${alertId}
            AND recommendation_number = ${recommendationNumber}
        `;
      }

      if (newStatus === "approved") {
        const rec = await getRecommendationForButton(
          sql,
          recommendationId,
          alertId,
          recommendationNumber
        );

        const preview = rec
          ? formatWorkerDryRun(rec)
          : `Could not load dry-run preview for recommendation #${recommendationNumber || "unknown"}.`;

        responseText =
          `Approved recommendation #${recommendationNumber || recommendationId || "unknown"}.\n` +
          `Status saved to Neon.\n\n` +
          preview;
      } else {
        responseText =
          `Declined recommendation #${recommendationNumber || recommendationId || "unknown"}.\n\n` +
          `Status saved to Neon.`;
      }
    } else {
      responseText = `Unknown button action: ${clickedAction}`;
    }

    const posted = await postSlackMessage(env, channelId, threadTs, responseText);

    if (!posted && responseUrl) {
      await respondToSlackInteraction(responseUrl, responseText);
    }

    return textResponse("");
  } catch (error) {
    console.error("Slack interaction failed:", error.message);

    const errorText = `Button action failed: ${error.message}`;

    const posted = await postSlackMessage(env, channelId, threadTs, errorText);

    if (!posted && responseUrl) {
      await respondToSlackInteraction(responseUrl, errorText);
    }

    return textResponse("");
  }
}


function isAuthorizedApplyRequest(request, env) {
  const provided =
    request.headers.get("x-apply-secret") ||
    new URL(request.url).searchParams.get("secret");

  return Boolean(env.APPLY_API_SECRET && provided === env.APPLY_API_SECRET);
}

function compactApprovedAction(row) {
  return {
    id: row.id,
    alert_id: row.alert_id,
    recommendation_number: row.recommendation_number,
    action_type: row.action_type,
    campaign_key: row.campaign_key,
    ad_group_key: row.ad_group_key,
    keyword_text: row.keyword_text,
    current_value: row.current_value || {},
    proposed_value: row.proposed_value || {},
    estimated_daily_impact: Number(row.estimated_daily_impact || 0),
    risk_level: row.risk_level,
    status: row.status,
    reason: row.reason,
  };
}

async function handleApprovedActions(request, env) {
  if (!isAuthorizedApplyRequest(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const sql = neon(env.DATABASE_URL);

  const rows = await sql`
    SELECT *
    FROM recommendations
    WHERE status = 'approved'
      AND requires_google_ads_mutation = true
    ORDER BY created_at ASC, recommendation_number ASC
    LIMIT 20
  `;

  return jsonResponse({
    ok: true,
    count: rows.length,
    actions: rows.map(compactApprovedAction),
  });
}

async function handleApplyResult(request, env) {
  if (!isAuthorizedApplyRequest(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const payload = await request.json();

  const recommendationId = payload.recommendation_id || payload.id;
  const status = payload.status;
  const result = payload.result || {};
  const errorMessage = payload.error_message || null;

  if (!recommendationId) {
    return jsonResponse(
      { ok: false, error: "Missing recommendation_id" },
      400
    );
  }

  if (!["applied", "failed", "skipped", "dry_run"].includes(status)) {
    return jsonResponse(
      { ok: false, error: "Invalid status" },
      400
    );
  }

  const sql = neon(env.DATABASE_URL);

  const rows = await sql`
    UPDATE recommendations
    SET
      status = ${status},
      applied_at = CASE
        WHEN ${status} = 'applied' THEN now()
        ELSE applied_at
      END,
      google_ads_result = ${JSON.stringify(result)},
      error_message = ${errorMessage}
    WHERE id = ${recommendationId}
    RETURNING *
  `;

  if (rows.length === 0) {
    return jsonResponse(
      { ok: false, error: "Recommendation not found" },
      404
    );
  }

  return jsonResponse({
    ok: true,
    recommendation: compactApprovedAction(rows[0]),
  });
}

export default {
  async fetch(request, env) {
    try {
      const path = getPath(request);

      if (request.method === "GET" && path === "/approved-actions") {
        return await handleApprovedActions(request, env);
      }

      if (request.method === "POST" && path === "/apply-result") {
        return await handleApplyResult(request, env);
      }

      if (request.method === "POST" && path === "/slack/interactions") {
        return await handleSlackInteraction(request, env);
      }

      if (request.method === "POST" && path === "/slack/commands") {
        return await handleSlackCommand(request, env);
      }

      if (request.method === "POST") {
        return await handleGoogleAdsSnapshot(request, env);
      }

      return jsonResponse({
        ok: true,
        message: "G2G Ads Worker is running",
      });
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error.message,
        },
        500
      );
    }
  },
};