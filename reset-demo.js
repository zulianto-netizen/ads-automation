require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    await client.query(`
      DELETE FROM approvals
      WHERE recommendation_id = 'rec_2026_05_03_002';
    `);

    await client.query(`
      UPDATE recommendations
      SET status = 'pending_approval'
      WHERE id = 'rec_2026_05_03_002';
    `);

    console.log("Demo reset successfully.");
    console.log("Recommendation 2 is now pending_approval again.");
  } catch (error) {
    console.error("Reset failed:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();