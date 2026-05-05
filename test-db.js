require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const result = await client.query(
      "SELECT * FROM alerts ORDER BY created_at DESC LIMIT 5;"
    );

    console.log("Connected to Neon successfully.");
    console.table(result.rows);
  } catch (error) {
    console.error("Database connection failed:");
    console.error(error.message);
  } finally {
    await client.end();
  }
}

main();
