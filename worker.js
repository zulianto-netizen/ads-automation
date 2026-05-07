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

      responseText =
        `${newStatus === "approved" ? "Approved" : "Declined"} recommendation ` +
        `#${recommendationNumber || recommendationId || "unknown"}.\n\n` +
        `Status saved to Neon. Dry-run/apply confirmation will come from the next step.`;
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

export default {
  async fetch(request, env) {
    try {
      const path = getPath(request);

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