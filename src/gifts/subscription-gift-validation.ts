// src/gifts/subscription-gift-validation.ts
// Validação no servidor dos dados de configuração de brindes.
// Nenhum ID oua preço enviado pelo navegador é aceito sem validação estrutural.

import {
  SUBSCRIPTION_GIFTS_MAX_POOL_SIZE,
  SubscriptionGiftSchedule,
  SubscriptionGiftSelectionMode,
  SubscriptionGiftSettingsInput,
  isGiftSchedule,
  isGiftSelectionMode,
} from "./subscription-gift.types";

const VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;

export class SubscriptionGiftValidationError extends Error {}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SubscriptionGiftValidationError(`Campo ${field} é obrigatório.`);
  }
  return value.trim();
}

function optionalGid(value: unknown, pattern: RegExp, field: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const text = requiredString(value, field);
  if (!pattern.test(text)) {
    throw new SubscriptionGiftValidationError(`Campo ${field} com identificador inválido.`);
  }
  return text;
}

export function validateGiftSettingsInput(value: unknown): SubscriptionGiftSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubscriptionGiftValidationError("Payload de configuração inválido.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") {
    throw new SubscriptionGiftValidationError("Campo enabled deve ser booleano.");
  }
  if (!isGiftSchedule(body.schedule)) {
    throw new SubscriptionGiftValidationError("Campo schedule inválido.");
  }
  if (!isGiftSelectionMode(body.selectionMode)) {
    throw new SubscriptionGiftValidationError("Campo selectionMode inválido.");
  }

  const fixedVariantId = optionalGid(body.fixedVariantId, VARIANT_GID_PATTERN, "fixedVariantId");
  let fixedProductId: string | undefined;
  if (body.fixedProductId !== undefined && body.fixedProductId !== null && body.fixedProductId !== "") {
    fixedProductId = optionalGid(body.fixedProductId, PRODUCT_GID_PATTERN, "fixedProductId");
  }
  const fixedTitle = typeof body.fixedTitle === "string" && body.fixedTitle.trim()
    ? body.fixedTitle.trim().slice(0, 300)
    : undefined;
  const fixedSku = typeof body.fixedSku === "string" && body.fixedSku.trim()
    ? body.fixedSku.trim().slice(0, 100)
    : undefined;

  if (!Array.isArray(body.variantPool)) {
    throw new SubscriptionGiftValidationError("Campo variantPool deve ser uma lista.");
  }
  if (body.variantPool.length > SUBSCRIPTION_GIFTS_MAX_POOL_SIZE) {
    throw new SubscriptionGiftValidationError(
      `O grupo de brindes aceita até ${SUBSCRIPTION_GIFTS_MAX_POOL_SIZE} variantes.`,
    );
  }
  const variantPool = body.variantPool.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SubscriptionGiftValidationError("Entrada do grupo de brindes inválida.");
    }
    const item = entry as Record<string, unknown>;
    const variantId = optionalGid(item.variantId, VARIANT_GID_PATTERN, "variantId") ?? "";
    if (!variantId) throw new SubscriptionGiftValidationError("Entrada do grupo sem variantId.");
    const title = requiredString(item.title, "title").slice(0, 300);
    const productId = optionalGid(item.productId, PRODUCT_GID_PATTERN, "productId");
    const sku = typeof item.sku === "string" && item.sku.trim() ? item.sku.trim().slice(0, 100) : undefined;
    return {
      variantId,
      ...(productId ? { productId } : {}),
      title,
      ...(sku ? { sku } : {}),
    };
  });

  const enabled = body.enabled;
  if (enabled) {
    if (body.selectionMode === "FIXED_VARIANT" && !fixedVariantId) {
      throw new SubscriptionGiftValidationError(
        "Informe a variante fixa para ativar brindes com seleção fixa.",
      );
    }
    if (body.selectionMode === "RANDOM_GROUP") {
      if (variantPool.length < 2) {
        throw new SubscriptionGiftValidationError(
          "O sorteio precisa de pelo menos 2 variantes no grupo.",
        );
      }
    }
  }

  return {
    enabled,
    schedule: body.schedule as SubscriptionGiftSchedule,
    selectionMode: body.selectionMode as SubscriptionGiftSelectionMode,
    ...(fixedVariantId ? { fixedVariantId } : {}),
    ...(fixedProductId ? { fixedProductId } : {}),
    ...(fixedTitle ? { fixedTitle } : {}),
    ...(fixedSku ? { fixedSku } : {}),
    variantPool,
  };
}