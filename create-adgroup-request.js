require("dotenv").config({ override: true });

const readline = require("readline");
const { Client } = require("pg");

function ask(question, rl) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("Create Google Ads ad group draft request");
    console.log("----------------------------------------");

    const campaign = await ask("Campaign: ", rl);
    const url = await ask("URL: ", rl);
    const budget = await ask("Budget note, e.g. $3/day: ", rl);
    const product = await ask("Product: ", rl);

    const rawText = [
      `Campaign: ${campaign}`,
      `URL: ${url}`,
      `Budget: ${budget}`,
      `Product: ${product}`,
    ].join("\n");

    const id = makeId("adgroup_request");

    const client = new Client({
      connectionString: process.env.DATABASE_URL,
    });

    await client.connect();

    await client.query(
      `
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
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        'received'
      )
      `,
      [
        id,
        "local",
        "local",
        "local",
        null,
        "local-create-adgroup",
        rawText,
      ]
    );

    await client.end();

    console.log("");
    console.log("Saved ad group request.");
    console.log(`Request ID: ${id}`);
    console.log("");
    console.log("Next run:");
    console.log("node generate-adgroup-draft.js");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("Failed to create ad group request:");
  console.error(error.message);
  process.exit(1);
});
