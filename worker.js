import { neon } from "@neondatabase/serverless";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    let payload;

    try {
      payload = await request.json();
    } catch (error) {
      return new Response("Invalid JSON", { status: 400 });
    }

    const sql = neon(env.DATABASE_URL);

    const id = payload.id || `snapshot_${Date.now()}`;
    const source = payload.source || "google_ads_script";
    const market = payload.market || "main_market";
    const accountId = payload.account_id || null;
    const reportDate = payload.date || new Date().toISOString().slice(0, 10);

    await sql`
      INSERT INTO ads_metric_snapshots (
        id,
        source,
        market,
        account_id,
        report_date,
        payload
      )
      VALUES (
        ${id},
        ${source},
        ${market},
        ${accountId},
        ${reportDate},
        ${JSON.stringify(payload)}
      )
      ON CONFLICT (id) DO UPDATE SET
        payload = EXCLUDED.payload,
        created_at = now();
    `;

    return new Response(
      JSON.stringify({
        ok: true,
        message: "Snapshot saved to Neon",
        id,
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  },
};