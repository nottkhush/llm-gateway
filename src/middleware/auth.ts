import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { pool } from "../db";

export const hashKey = (k: string) =>
  crypto.createHash("sha256").update(k).digest("hex");

export async function auth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const raw = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!raw) return res.status(401).json({ error: "missing api key" });

  const { rows } = await pool.query(
    "SELECT id, name, budget_micros, spent_micros FROM api_keys WHERE key_hash = $1",
    [hashKey(raw)]
  );
  if (!rows[0]) return res.status(401).json({ error: "invalid api key" });

  res.locals.apiKey = rows[0];
  next();
}