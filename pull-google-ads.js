require("dotenv").config({ override: true });
const { GoogleAdsApi } = require("google-ads-api");

function microsToCurrency(value) {
  return Number(value || 0) / 1_000_000;
}

async function main() {
  const client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });

  const customer = client.Customer({
    customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  });

  const query = `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date DURING YESTERDAY
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 20
  `;

  const rows = await customer.query(query);

  if (rows.length === 0) {
    console.log("Connected to Google Ads, but no campaign rows found for yesterday.");
    return;
  }

  const results = rows.map((row) => {
    const cost = microsToCurrency(row.metrics.cost_micros);
    const conversionValue = Number(row.metrics.conversions_value || 0);
    const roas = cost > 0 ? conversionValue / cost : 0;

    return {
      date: row.segments.date,
      campaign_id: row.campaign.id,
      campaign_name: row.campaign.name,
      status: row.campaign.status,
      cost: Number(cost.toFixed(2)),
      impressions: Number(row.metrics.impressions || 0),
      clicks: Number(row.metrics.clicks || 0),
      conversions: Number(row.metrics.conversions || 0),
      conversion_value: Number(conversionValue.toFixed(2)),
      roas: Number(roas.toFixed(2)),
    };
  });

  console.log("Google Ads read-only pull successful.");
  console.table(results);
}

main().catch((error) => {
  console.error("Google Ads pull failed:");

  if (error.errors) {
    console.error(JSON.stringify(error.errors, null, 2));
  } else {
    console.error(error.message || error);
  }
});