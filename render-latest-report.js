require("dotenv").config({ override: true });
const { Client } = require("pg");
const { execSync } = require("child_process");

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const result = await client.query(`
      SELECT id
      FROM alerts
      ORDER BY created_at DESC
      LIMIT 1;
    `);

    if (result.rows.length === 0) {
      console.log("No alerts found.");
      return;
    }

    const latestAlertId = result.rows[0].id;

    console.log("Latest alert ID:", latestAlertId);
    console.log("");

    execSync(`node render-report.js ${latestAlertId}`, {
      stdio: "inherit",
    });
  } catch (error) {
    console.error("Failed to render latest report:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();