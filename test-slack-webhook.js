require("dotenv").config({ override: true });

async function main() {
  try {
    const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: ":bar_chart: Daily Ads Test Alert\n\nThis is a test message using Slack Incoming Webhook.",
      }),
    });

    const text = await response.text();

    if (!response.ok) {
      console.error("Slack webhook failed:");
      console.error(text);
      return;
    }

    console.log("Slack webhook message sent successfully.");
    console.log(text);
  } catch (error) {
    console.error("Slack webhook error:");
    console.error(error.message);
  }
}

main();