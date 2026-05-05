require("dotenv").config({ override: true });
const { Client } = require("pg");

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const result = await client.query(
      `
      SELECT
        im.id,
        im.recommendation_id,
        ac.change_type,
        ac.campaign_key,
        im.cost_before,
        im.cost_after,
        im.conversion_value_before,
        im.conversion_value_after,
        ROUND(im.roas_before, 2) AS roas_before,
        ROUND(im.roas_after, 2) AS roas_after,
        im.verdict,
        im.summary
      FROM impact_measurements im
      JOIN applied_changes ac
        ON ac.id = im.applied_change_id
      ORDER BY im.measured_at DESC;
      `
    );

    if (result.rows.length === 0) {
      console.log("No impact measurements found.");
      return;
    }

    console.table(result.rows);
  } catch (error) {
    console.error("Failed to view impact:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();