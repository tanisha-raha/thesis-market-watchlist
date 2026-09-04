import type { Config } from "drizzle-kit";

// drizzle-kit runs as its own binary and does not read .env.local the way the
// npm scripts do, so a clean clone would otherwise fail here with an unset
// DATABASE_URL. Node loads the file if it is present; deployed environments
// supply the variable directly and have no such file.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local — expected in CI and in production.
}

export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
