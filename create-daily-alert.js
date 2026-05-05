require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  const alertId = "2026-05-03-main-market";

  try {
    await client.connect();

    await client.query(
      `
      INSERT INTO alerts (
        id,
        alert_date,
        market,
        account_id,
        raw_report_text,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        raw_report_text = EXCLUDED.raw_report_text,
        status = EXCLUDED.status;
      `,
      [
        alertId,
        "2026-05-03",
        "main_market",
        "test-account",
        "Fake Main Market Daily Alert for local testing",
        "created",
      ]
    );

    const recommendations = [
      {
        id: "rec_2026_05_03_001",
        number: 1,
        action_type: "INVESTIGATE_TRACKING",
        campaign_key: "all",
        current_value: {},
        proposed_value: {
          task: "Check GA4, pixel, and offline conversion import",
        },
        reason: "Conversion value dropped 52.99% while cost dropped only 5.70%",
        estimated_daily_impact: 6519,
        risk_level: "high",
        requires_google_ads_mutation: false,
      },
      {
        id: "rec_2026_05_03_002",
        number: 2,
        action_type: "RAISE_BUDGET",
        campaign_key: "007_DG_PO",
        current_value: {
          budget: 5.24,
        },
        proposed_value: {
          budget: 20,
        },
        reason: "58.37x ROAS and budget limited",
        estimated_daily_impact: 156,
        risk_level: "medium",
        requires_google_ads_mutation: true,
      },
      {
        id: "rec_2026_05_03_004",
        number: 4,
        action_type: "ADD_NEGATIVES",
        campaign_key: "122_US2",
        ad_group_key: "Honkai_Star_Rail",
        current_value: {},
        proposed_value: {
          negative_keywords: ["hsr account", "hsr top up"],
          match_type: "phrase",
        },
        reason: "Honkai Star Rail ad group spent $27.35 with 0 conversions",
        estimated_daily_impact: 27,
        risk_level: "low",
        requires_google_ads_mutation: true,
      },
      {
        id: "rec_2026_05_03_007",
        number: 7,
        action_type: "PAUSE_KEYWORD",
        campaign_key: "124_DE2",
        ad_group_key: "Spotify",
        keyword_text: "spotify_broad",
        current_value: {
          status: "enabled",
          spend: 7.73,
          conversions: 0,
        },
        proposed_value: {
          status: "paused",
        },
        reason: "Spotify ad group spent $7.73 with 0 conversions",
        estimated_daily_impact: 7.73,
        risk_level: "low",
        requires_google_ads_mutation: true,
      },
    ];

    for (const rec of recommendations) {
      await client.query(
        `
        INSERT INTO recommendations (
          id,
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
          requires_google_ads_mutation,
          risk_level,
          status
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14
        )
        ON CONFLICT (id) DO UPDATE SET
          action_type = EXCLUDED.action_type,
          campaign_key = EXCLUDED.campaign_key,
          ad_group_key = EXCLUDED.ad_group_key,
          keyword_text = EXCLUDED.keyword_text,
          current_value = EXCLUDED.current_value,
          proposed_value = EXCLUDED.proposed_value,
          reason = EXCLUDED.reason,
          estimated_daily_impact = EXCLUDED.estimated_daily_impact,
          requires_google_ads_mutation = EXCLUDED.requires_google_ads_mutation,
          risk_level = EXCLUDED.risk_level,
          status = EXCLUDED.status;
        `,
        [
          rec.id,
          alertId,
          rec.number,
          rec.action_type,
          rec.campaign_key,
          rec.ad_group_key || null,
          rec.keyword_text || null,
          JSON.stringify(rec.current_value),
          JSON.stringify(rec.proposed_value),
          rec.reason,
          rec.estimated_daily_impact,
          rec.requires_google_ads_mutation,
          rec.risk_level,
          "pending_approval",
        ]
      );
    }

    const result = await client.query(
      `
      SELECT
        recommendation_number,
        action_type,
        campaign_key,
        ad_group_key,
        keyword_text,
        status
      FROM recommendations
      WHERE alert_id = $1
      ORDER BY recommendation_number;
      `,
      [alertId]
    );

    console.log("Daily alert created successfully.");
    console.table(result.rows);
  } catch (error) {
    console.error("Failed to create daily alert:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();