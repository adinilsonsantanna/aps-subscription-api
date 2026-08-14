import dotenv from "dotenv";

dotenv.config();

const requiredEnvNames = [
  "DATABASE_URL",
  "API_KEY",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_WEBHOOK_SECRET",
  "SHOPIFY_APP_URL",
  "SHOPIFY_APP_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

type RequiredEnvName = (typeof requiredEnvNames)[number];

function requireEnv(name: RequiredEnvName): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`[ENV] Missing required environment variable: ${name}`);
  }

  return value;
}

export const env = Object.fromEntries(
  requiredEnvNames.map((name) => [name, requireEnv(name)])
) as Record<RequiredEnvName, string>;
