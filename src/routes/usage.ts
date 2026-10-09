import { Router } from "express";
import { pool } from "../db";
import { config } from "../config";

export const usage = Router();

usage.get("/usage", async (req, res) => {
  if (req.headers["x-admin-token"] !== config.adminToken)
    return res.status(403).json({ error: "forbidden" });

  const keyId = Number(req.query.key_id);
  if (!keyId) return res.status(400).json({ error: "key_id required" });

  const k = await pool.query(
    "SELECT name, budget_micros, spent_micros FROM api_keys WHERE id = $1", [keyId]);
  if (!k.rows[0]) return res.status(404).json({ error: "no such key" });

  const t = await pool.query(
    `SELECT COUNT(*)::int AS requests,
            COALESCE(SUM(tokens_in),0)::int AS tokens_in,
            COALESCE(SUM(tokens_out),0)::int AS tokens_out,
            COALESCE(SUM(cost_micros),0)::bigint AS cost_micros
     FROM usage_logs WHERE key_id = $1`, [keyId]);

  res.json({ key: k.rows[0], totals: t.rows[0] });
});