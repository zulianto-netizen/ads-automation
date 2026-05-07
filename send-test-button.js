require("dotenv").config({ override: true });

async function main() {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is missing.");
  }

  if (!process.env.SLACK_CHANNEL_ID) {
    throw new Error("SLACK_CHANNEL_ID is missing.");
  }

  const payload = {
    channel: process.env.SLACK_CHANNEL_ID,
    text: "Button test",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Slack button test*\nClick approve to test Cloudflare interactivity.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Approve test",
            },
            style: "primary",
            action_id: "approve",
            value: JSON.stringify({
              action: "approve",
              recommendation_number: 999,
              alert_id: "test_alert",
            }),
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Decline test",
            },
            style: "danger",
            action_id: "decline",
            value: JSON.stringify({
              action: "decline",
              recommendation_number: 999,
              alert_id: "test_alert",
            }),
          },
        ],
      },
    ],
  };

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`chat.postMessage failed: ${data.error}`);
  }

  console.log("Test button message sent.");
  console.log(`ts: ${data.ts}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
