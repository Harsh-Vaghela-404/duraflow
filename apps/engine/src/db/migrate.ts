import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

const TAG = "[migrate]";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://duraflow:duraflow@localhost:5432/duraflow",
});

async function migrate() {
  const sqlPath = join(__dirname, "init.sql");
  const sql = readFileSync(sqlPath, "utf8");

  const client = await pool.connect();
  try {
    console.log(`${TAG} applying schema from ${sqlPath}`);
    await client.query(sql);
    console.log(`${TAG} schema applied`);
  } catch (err) {
    console.error(`${TAG} migration failed:`, err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
