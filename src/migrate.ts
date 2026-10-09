import fs from "fs";
import path from "path";
import { pool } from "./db";

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("migrated");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });