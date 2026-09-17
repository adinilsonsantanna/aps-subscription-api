// src/gifts/subscription-gift.shopify.client.ts
// Cliente Shopify Admin GraphQL (2026-07) para edição de pedidos: consulta,
// orderEditBegin/AddVariant/AddLineItemDiscount/Commit e confirmação.

export const SHOPIFY_GIFT_API_VERSION = "2026-07";

export interface GiftEligibleVariant {
  variantId: string;
  sku: string | null;
  title: string;
  productId: string;
  productTitle: string;
  requiresShipping: boolean;
  tracked: boolean;
  productActive: boolean;
  available: number;
  availableAtLocation: boolean;
}

export interface GiftOrderSnapshot {
  id: string;
  legacyResourceId: string | null;
  cancelledAt: string | null;
  closedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  processedAt: string | null;
  totalShopMoney: number;
  shippingShopMoney: number;
  currencyCode: string | null;
  servingLocationIds: string[];
}

export interface GiftShopifyCallError extends Error {
  kind: "http" | "timeout" | "graphql_error" | "network";
  status?: number;
  graphqlCodes?: string[];
}

export type ShopifyGraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

function classifyError(error: unknown, status?: number): GiftShopifyCallError {
  if (error instanceof Error && error.name === "AbortError") {
    return Object.assign(new Error(`Tempo esgotado na Shopify Admin API.`), { kind: "timeout" as const });
  }
  const message = error instanceof Error ? error.message : "Falha na chamada à Shopify Admin API";
  return Object.assign(new Error(message), { kind: status === undefined ? "network" as const : "http" as const, status });
}

function responseToJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export class GiftShopifyClient {
  constructor(
    private readonly dependencies: {
      fetchFn?: typeof fetch;
      timeoutMs?: number;
      apiVersion?: string;
    } = {},
  ) {}

  private async graphql<T>(
    shopDomain: string,
    accessToken: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<ShopifyGraphqlEnvelope<T>> {
    const fetchFn = this.dependencies.fetchFn ?? fetch;
    const timeoutMs = this.dependencies.timeoutMs ?? 8_000;
    const apiVersion = this.dependencies.apiVersion ?? SHOPIFY_GIFT_API_VERSION;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      throw classifyError(error);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const body = await responseToJson(response).catch(() => null);
      throw classifyError(new Error(`Shopify Admin API respondeu ${response.status}`), response.status);
    }
    const body = (await responseToJson(response)) as ShopifyGraphqlEnvelope<T> | null;
    if (!body) {
      throw classifyError(new Error("Resposta vazia da Shopify Admin API"), response.status);
    }
    return body;
  }

  async fetchOrderForGift(shopDomain: string, accessToken: string, orderId: string): Promise<GiftOrderSnapshot | null> {
    const query = `#graphql
      query OrderForGift($id: ID!) {
        order(id: $id) {
          id
          legacyResourceId
          cancelledAt
          closedAt
          displayFinancialStatus
          displayFulfillmentStatus
          processedAt
          currencyCode
          totalPriceSet {
            shopMoney { amount currencyCode }
          }
          shippingLines(first: 10) {
            nodes {
              id
              discountedPriceSet { shopMoney { amount currencyCode } }
            }
          }
          fulfillmentOrders(first: 5) {
            nodes {
              assignedLocation { location { id } }
            }
          }
        }
      }`;
    const envelope = await this.graphql<{ order: {
      id: string;
      legacyResourceId: string | null;
      cancelledAt: string | null;
      closedAt: string | null;
      displayFinancialStatus: string | null;
      displayFulfillmentStatus: string | null;
      processedAt: string | null;
      currencyCode: string | null;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      shippingLines: { nodes: Array<{ id: string; discountedPriceSet: { shopMoney: { amount: string; currencyCode: string } } }> };
      fulfillmentOrders: { nodes: Array<{ assignedLocation: { location: { id: string } | null } | null }> };
    } | null }>(shopDomain, accessToken, query, { id: orderId });
    if (envelope.errors?.length) {
      const error = classifyError(new Error("Shopify GraphQL retornou erro"), 200);
      error.kind = "graphql_error";
      error.graphqlCodes = [...new Set(envelope.errors.map((item) => item.extensions?.code).filter((code): code is string => Boolean(code)).slice(0, 10))];
      throw error;
    }
    const order = envelope.data?.order;
    if (!order) return null;
    const shipping = order.shippingLines.nodes.reduce((sum, line) => sum + Number(line.discountedPriceSet.shopMoney.amount), 0);
    const servingLocationIds = order.fulfillmentOrders.nodes
      .map((fulfillmentOrder) => fulfillmentOrder.assignedLocation?.location?.id)
      .filter((value): value is string => Boolean(value));
    return {
      id: order.id,
      legacyResourceId: order.legacyResourceId,
      cancelledAt: order.cancelledAt,
      closedAt: order.closedAt,
      displayFinancialStatus: order.displayFinancialStatus,
      displayFulfillmentStatus: order.displayFulfillmentStatus,
      processedAt: order.processedAt,
      totalShopMoney: Number(order.totalPriceSet.shopMoney.amount),
      shippingShopMoney: shipping,
      currencyCode: order.currencyCode,
      servingLocationIds,
    };
  }

  async fetchVariantEligibility(
    shopDomain: string,
    accessToken: string,
    variantIds: string[],
    locationIds: string[],
  ): Promise<GiftEligibleVariant[]> {
    if (!variantIds.length) return [];
    const query = `#graphql
      query GiftVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            sku
            title
            inventoryItem {
              id
              tracked
              requiresShipping
              inventoryLevels(first: 50) {
                edges {
                  node {
                    location { id }
                    quantities(names: ["available"]) { quantity }
                  }
                }
              }
            }
            product {
              id
              title
              status
            }
          }
        }
      }`;
    const envelope = await this.graphql<{ nodes: Array<{
      id: string;
      sku: string | null;
      title: string | null;
      inventoryItem: {
        id: string;
        tracked: boolean;
        requiresShipping: boolean;
        inventoryLevels: { edges: Array<{ node: { location: { id: string } | null; quantities: { quantity: number } | null } }> };
      } | null;
      product: { id: string; title: string; status: string } | null;
    } | null> }>(shopDomain, accessToken, query, { ids: variantIds });
    if (envelope.errors?.length) {
      throw classifyError(new Error(envelope.errors[0].message), 200);
    }
    const requested = new Map(variantIds.map((variantId, index) => [variantId, index]));
    const candidates: GiftEligibleVariant[] = [];
    for (const node of envelope.data?.nodes ?? []) {
      if (!node) continue;
      const hasRequestedId = requested.has(node.id);
      if (!hasRequestedId) continue;
      const inventoryLevels = node.inventoryItem?.inventoryLevels?.edges ?? [];
      const available = inventoryLevels.reduce((sum, edge) => sum + (edge?.node?.quantities?.quantity ?? 0), 0);
      const availableAtServingLocation = inventoryLevels
        .filter((edge) => !locationIds.length || !edge?.node?.location?.id || locationIds.includes(edge.node.location.id))
        .reduce((sum, edge) => sum + (edge?.node?.quantities?.quantity ?? 0), 0);
      const tracked = node.inventoryItem?.tracked === true;
      const productActive = node.product?.status === "ACTIVE";
      candidates.push({
        variantId: node.id,
        sku: node.sku,
        title: node.title ?? "",
        productId: node.product?.id ?? "",
        productTitle: node.product?.title ?? "",
        requiresShipping: node.inventoryItem?.requiresShipping === true,
        tracked,
        productActive,
        available,
        availableAtLocation: availableAtServingLocation > 0,
      });
    }
    return candidates;
  }

  async orderEditBegin(shopDomain: string, accessToken: string, orderId: string) {
    const query = `#graphql
      mutation OrderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingLines { id price { shopMoney { amount currencyCode } } }
          }
          userErrors { field message }
        }
      }`;
    return this.graphql<{
      orderEditBegin: {
        calculatedOrder: {
          id: string;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          shippingLines: Array<{ id: string; price: { shopMoney: { amount: string } } }>;
        } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(shopDomain, accessToken, query, { id: orderId });
  }

  async orderEditAddVariant(
    shopDomain: string,
    accessToken: string,
    calculatedOrderId: string,
    variantId: string,
    locationId: string | null,
  ) {
    const query = `#graphql
      mutation OrderEditAddVariant($id: ID!, $variantId: ID!, $locationId: ID) {
        orderEditAddVariant(id: $id, variantId: $variantId, quantity: 1, allowDuplicates: true, locationId: $locationId) {
          calculatedOrder {
            id
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingLines { id price { shopMoney { amount currencyCode } } }
          }
          calculatedLineItem { id quantity }
          userErrors { field message }
        }
      }`;
    return this.graphql<{
      orderEditAddVariant: {
        calculatedOrder: {
          id: string;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          shippingLines: Array<{ id: string; price: { shopMoney: { amount: string } } }>;
        } | null;
        calculatedLineItem: { id: string; quantity: number } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(shopDomain, accessToken, query, {
      id: calculatedOrderId,
      variantId,
      ...(locationId ? { locationId } : {}),
    });
  }

  async orderEditAddLineItemDiscount(
    shopDomain: string,
    accessToken: string,
    calculatedOrderId: string,
    lineItemId: string,
  ) {
    const query = `#graphql
      mutation OrderEditAddLineItemDiscount($id: ID!, $lineItemId: ID!) {
        orderEditAddLineItemDiscount(
          id: $id
          lineItemId: $lineItemId
          discount: { description: "Brinde adicionado pelo APS Subscription", percentValue: 100 }
        ) {
          calculatedOrder {
            id
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingLines { id price { shopMoney { amount currencyCode } } }
          }
          userErrors { field message }
        }
      }`;
    return this.graphql<{
      orderEditAddLineItemDiscount: {
        calculatedOrder: {
          id: string;
          totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          shippingLines: Array<{ id: string; price: { shopMoney: { amount: string } } }>;
        } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(shopDomain, accessToken, query, { id: calculatedOrderId, lineItemId });
  }

  async orderEditCommit(shopDomain: string, accessToken: string, calculatedOrderId: string, staffNote: string) {
    const query = `#graphql
      mutation OrderEditCommit($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "${staffNote.replace(/"/g, '\\"')}") {
          order { id }
          userErrors { field message }
        }
      }`;
    return this.graphql<{
      orderEditCommit: {
        order: { id: string } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(shopDomain, accessToken, query, { id: calculatedOrderId });
  }

  async queryOrderGiftLines(shopDomain: string, accessToken: string, orderId: string, variantId: string) {
    const query = `#graphql
      query OrderGiftLine($id: ID!) {
        order(id: $id) {
          id
          lineItems(first: 50) {
            nodes {
              id
              title
              discountedUnitPriceSet { shopMoney { amount currencyCode } }
              variant { id }
            }
          }
        }
      }`;
    const envelope = await this.graphql<{
      order: {
        id: string;
        lineItems: { nodes: Array<{
          id: string;
          title: string;
          discountedUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } };
          variant: { id: string } | null;
        }> };
      } | null;
    }>(shopDomain, accessToken, query, { id: orderId });
    if (envelope.errors?.length) {
      throw classifyError(new Error(envelope.errors[0].message), 200);
    }
    const lines = envelope.data?.order?.lineItems?.nodes ?? [];
    return lines
      .filter((line) => line.variant?.id === variantId)
      .map((line) => ({
        lineId: line.id,
        title: line.title,
        discountedUnitPrice: Number(line.discountedUnitPriceSet.shopMoney.amount),
      }));
  }
}
