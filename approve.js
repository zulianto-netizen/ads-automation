require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const recommendationNumber = process.argv[2];

  if (!recommendationNumber) {
    console.error("Please provide a recommendation number.");
    console.error("Example: node approve.js 2");
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const alertId = "2026-05-03-main-market";

    const recommendationResult = await client.query(
      `
      SELECT id, recommendation_number, action_type, campaign_key, status
      FROM recommendations
      WHERE alert_id = $1
      AND recommendation_number = $2
      LIMIT 1;
      `,
      [alertId, recommendationNumber]
    );

    if (recommendationResult.rows.length === 0) {
      console.log(`No recommendation found for number ${recommendationNumber}.`);
      return;
    }

    const recommendation = recommendationResult.rows[0];

    if (recommendation.status !== "pending_approval") {
      console.log(`Recommendation ${recommendationNumber} is already ${recommendation.status}.`);
      return;
    }

    const approvalId = `approval_${recommendation.id}`;

    await client.query(
      `
      INSERT INTO approvals (
        id,
        recommendation_id,
        approved_by,
        approval_source,
        original_command,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO NOTHING;
      `,
      [
        approvalId,
        recommendation.id,
        "local_test_user",
        "local_terminal",
        `apply ${recommendationNumber}`,
        "approved",
      ]
    );

    await client.query(
      `
      UPDATE recommendations
      SET status = 'approved'
      WHERE id = $1;
      `,
      [recommendation.id]
    );

    console.log("Approved successfully.");
    console.table([
      {
        recommendation_number: recommendation.recommendation_number,
        action_type: recommendation.action_type,
        campaign_key: recommendation.campaign_key,
        new_status: "approved",
      },
    ]);
  } catch (error) {
    console.error("Approval failed:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();