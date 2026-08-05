import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import "dotenv/config";

export const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  scopes: (process.env.SCOPES || "").split(","),
  hostName: process.env.HOST!.replace(/^https?:\/\//, ""),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});