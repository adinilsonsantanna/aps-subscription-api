import crypto from "crypto";

export class ShopifyOAuthService {
  generateInstallUrl(shop: string) {
    const clientId = process.env.SHOPIFY_API_KEY!;
    const redirectUri = process.env.SHOPIFY_REDIRECT_URI!;
    const scopes = process.env.SHOPIFY_SCOPES!;

    const state = crypto.randomUUID();

    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes,
      redirect_uri: redirectUri,
      state,
    });

    return {
      state,
      url: `https://${shop}/admin/oauth/authorize?${params.toString()}`
    };
  }
}