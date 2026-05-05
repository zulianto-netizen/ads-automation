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
        risk_level,
        status
      FROM recommendations
      WHERE alert_id = '2026-05-03-main-market-claude'
      ORDER BY recommendation_number;
      `
    );

    console.table(result.rows);
  } catch (error) {
    console.error("Failed:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();