import crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { config } from "../config";
import { hashKey } from "../middleware/auth";

export const admin = Router();

function adminOnly(req: Request, res: Response, next: NextFunction) {
  if (req.headers["x-admin-token"] !== config.adminToken) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

admin.post("/keys", adminOnly, async (req, res) => {
  const { name, budgetUsd } = req.body || {};
  if (!name || typeof budgetUsd !== "number" || budgetUsd <= 0) {
    return res.status(400).json({ error: "need name and budgetUsd > 0" });
  }
  const raw = "gw_" + crypto.randomBytes(24).toString("hex");
  const budgetMicros = Math.round(budgetUsd * 1_000_000);

  const { rows } = await pool.query(
    `INSERT INTO api_keys (name, key_hash, key_prefix, budget_micros)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, hashKey(raw), raw.slice(0, 7), budgetMicros]
  );
  // raw key is shown once and never stored
  res.status(201).json({ id: rows[0].id, key: raw, budgetUsd });
});