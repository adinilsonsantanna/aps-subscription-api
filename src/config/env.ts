import dotenv from "dotenv";

dotenv.config();

export const env = {
  DATABASE_URL: process.env.DATABASE_URL || "",
  SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY || "",
  SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET || "",
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET || "",
  API_SECRET_KEY: process.env.API_SECRET_KEY || "",
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || "",
  SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL || "",
  SHOPIFY_APP_API_KEY: process.env.SHOPIFY_APP_API_KEY || "",
};

if (!env.STRIPE_SECRET_KEY) {
  console.warn("[ENV] STRIPE_SECRET_KEY não configurada!");
}