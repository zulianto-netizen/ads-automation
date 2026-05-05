require("dotenv").config({ override: true });
const { Client } = require("pg");

function printDryRun(rec) {
  console.log("----------------------------------------");
  console.log(`Recommendation ${rec.recommendation_number}`);
  console.log(`Action: ${rec.action_type}`);
  console.log(`Campaign: ${rec.campaign_key || "-"}`);
  console.log(`Ad group: ${rec.ad_group_key || "-"}`);
  console.log(`Keyword: ${rec.keyword_text || "-"}`);
  console.log(`Reason: ${rec.reason}`);

  if (rec.action_type === "INVESTIGATE_TRACKING") {
    console.log("DRY RUN: Would create a tracking investigation task.");
    console.log(`Task: ${rec.proposed_value.task || "Check tracking setup"}`);
    return;
  }

  if (rec.action_type === "RAISE_BUDGET") {
    console.log(
      `DRY RUN: Would raise budget from $${rec.current_value.budget} to $${rec.proposed_value.budget}`
    );
    return;
  }

  if (rec.action_type === "ADD_NEGATIVES") {
    console.log(
      `DRY RUN: Would add negative keywords: ${rec.proposed_value.negative_keywords.join(", ")}`
    );
    console.log(`Match type: ${rec.proposed_value.match_type}`);
    return;
  }

  if (rec.action_type === "PAUSE_KEYWORD") {
    console.log(
      `DRY RUN: Would pause keyword "${rec.keyword_text}" because it spent $${rec.current_value.spend} with ${rec.current_value.conversions} conversions`
    );
    return;
  }

  console.log(`DRY RUN: Would apply action type ${rec.action_type}`);
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const result = await client.query(
      `
      SELECT
        id,
        recommendation_number,
        action_type,
        campaign_key,
        ad_group_key,
        keyword_text,
        current_value,
        proposed_value,
        reason,
        status
      FROM recommendations
      WHERE status = 'approved'
      ORDER BY recommendation_number ASC;
      `
    );

    if (result.rows.length === 0) {
      console.log("No approved recommendations to apply.");
      return;
    }

    for (const rec of result.rows) {
      printDryRun(rec);

      const appliedChangeId = `change_${rec.id}`;

      await client.query(
        `
        INSERT INTO applied_changes (
          id,
          recommendation_id,
          change_type,
          entity_type,
          campaign_key,
          ad_group_key,
          keyword_text,
          before_value,
          after_value,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          before_value = EXCLUDED.before_value,
          after_value = EXCLUDED.after_value,
          status = EXCLUDED.status;
        `,
        [
          appliedChangeId,
          rec.id,
          rec.action_type,
          rec.action_type === "INVESTIGATE_TRACKING" ? "account" : "campaign",
          rec.campaign_key || null,
          rec.ad_group_key || null,
          rec.keyword_text || null,
          JSON.stringify(rec.current_value || {}),
          JSON.stringify(rec.proposed_value || {}),
          "dry_run_applied",
        ]
      );

      await client.query(
        `
        UPDATE recommendations
        SET status = 'dry_run_applied'
        WHERE id = $1;
        `,
        [rec.id]
      );

      console.log("Applied change recorded in applied_changes.");
      console.log("Status updated to dry_run_applied.");
    }
  } catch (error) {
    console.error("Apply failed:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();