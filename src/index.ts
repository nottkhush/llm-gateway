import express from "express";
import { config } from "./config";
import { admin } from "./routes/admin";
import { chat } from "./routes/chat";
import { usage } from "./routes/usage";
import { auth } from "./middleware/auth";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/admin", admin);
app.use("/v1", chat);
app.use(usage);

app.get("/v1/whoami", auth, (_req, res) => res.json(res.locals.apiKey));

app.listen(config.port, () => console.log(`gateway on :${config.port}`));