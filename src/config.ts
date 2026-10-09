import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: req("DATABASE_URL"),
  adminToken: req("ADMIN_TOKEN"),
  groqKey: req("GROQ_API_KEY"),
};