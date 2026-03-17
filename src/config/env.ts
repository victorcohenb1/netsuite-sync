import { z } from "zod";
import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

if (existsSync(resolve(process.cwd(), ".env"))) {
  dotenv.config();
}

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  DATABASE_URL: z.string().min(1),

  NETSUITE_ACCOUNT_ID: z.string().min(1),
  NETSUITE_CONSUMER_KEY: z.string().min(1),
  NETSUITE_CONSUMER_SECRET: z.string().min(1),
  NETSUITE_TOKEN_ID: z.string().min(1),
  NETSUITE_TOKEN_SECRET: z.string().min(1),
  NETSUITE_REST_BASE_URL: z.string().url(),
  NETSUITE_CSV_FOLDER_ID: z.string().min(1),

  SYNC_RETRY_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  SYNC_RETRY_DELAY_MS: z.coerce.number().int().min(100).default(2000),
  SYNC_DEFAULT_CRON: z.string().default("0 */4 * * *"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment variables:");
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
