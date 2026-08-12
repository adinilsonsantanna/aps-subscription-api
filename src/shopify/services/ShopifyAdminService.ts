// src/shopify/services/ShopifyAdminService.ts
// Serviço para integração com a Shopify Admin API

export class ShopifyAdminService {
  /**
   * Busca informações de uma loja na Shopify
   */
  async getShopInfo(domain: string, accessToken: string) {
    const response = await fetch(
      `https://${domain}/admin/api/2026-07/shop.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Cria um contrato de assinatura na Shopify
   * https://shopify.dev/docs/api/admin-graphql/latest/mutations/subscriptionContractCreate
   */
  async createSubscriptionContract(
    domain: string,
    accessToken: string,
    input: {
      customerId: string;
      nextBillingDate: string;
      currencyCode: string;
      billingPolicy: {
        interval: string;
        intervalCount: number;
        minCycles?: number;
        maxCycles?: number;
      };
      deliveryPolicy: {
        interval: string;
        intervalCount: number;
      };
      lines: Array<{
        productVariantId: string;
        quantity: number;
        currentPrice: string;
        sellingPlanId?: string;
      }>;
    }
  ) {
    const query = `#graphql
      mutation subscriptionContractCreate($input: SubscriptionContractInput!) {
        subscriptionContractCreate(input: $input) {
          contract {
            id
            status
            nextBillingDate
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await fetch(
      `https://${domain}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables: { input } }),
      }
    );

    if (!response.ok) {
      throw new Error(`Shopify GraphQL error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Busca selling plans (planos de assinatura) de um produto
   */
  async getSellingPlans(domain: string, accessToken: string, productId: string) {
    const query = `#graphql
      query getProductSellingPlans($id: ID!) {
        product(id: $id) {
          id
          title
          sellingPlanGroups(first: 10) {
            edges {
              node {
                id
                name
                sellingPlans(first: 10) {
                  edges {
                    node {
                      id
                      name
                      options
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${domain}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables: { id: productId } }),
      }
    );

    return response.json();
  }
}