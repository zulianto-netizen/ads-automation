require("dotenv").config({ override: true });
const { WebClient } = require("@slack/web-api");

async function main() {
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

  try {
    const result = await slack.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID,
      text: ":bar_chart: Daily Ads Test Alert\n\nThis is a test message from your ads automation bot."
    });

    console.log("Slack message sent successfully.");
    console.log("Message timestamp:", result.ts);
  } catch (error) {
    console.error("Slack message failed:");
    console.error(error.data || error.message);
  }
}

main();
