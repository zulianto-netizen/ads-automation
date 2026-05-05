require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const alertId = "2026-05-03-main-market";

    await client.query(
      `
      INSERT INTO recommendations (
        id,
        alert_id,
        recommendation_number,
        action_type,
        campaign_key,
        current_value,
        proposed_value,
        reason,
        estimated_daily_impact,
        risk_level,
        status
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
      ON CONFLICT (id) DO NOTHING;
      `,
      [
        "rec_2026_05_03_002",
        alertId,
        2,
        "RAISE_BUDGET",
        "007_DG_PO",
        JSON.stringify({ budget: 5.24 }),
        JSON.stringify({ budget: 20 }),
        "58x ROAS and budget limited",
        156,
        "medium",
        "pending_approval",
      ]
    );

    const result = await client.query(
      `
      SELECT
        r.id,
        r.recommendation_number,
        r.action_type,
        r.campaign_key,
        r.current_value,
        r.proposed_value,
        r.reason,
        r.status
      FROM recommendations r
      WHERE r.alert_id = $1
      ORDER BY r.recommendation_number;
      `,
      [alertId]
    );

    console.log("Recommendation saved successfully.");
    console.table(result.rows);
  } catch (error) {
    console.error("Failed:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();