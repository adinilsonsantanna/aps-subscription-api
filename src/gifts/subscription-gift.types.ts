// src/gifts/subscription-gift.types.ts
// Tipos e constantes do recurso CONFIGURAR BRINDES.

export const SUBSCRIPTION_GIFTS_MAX_POOL_SIZE = 50;
export const SUBSCRIPTION_GIFTS_FEATURE_FLAG = "ENABLE_SUBSCRIPTION_GIFTS";
// Janela máxima de idade do pedido para aceitar a criação de um job de brinde.
// Replays de eventos antigos além dessa janela NÃO criam job (impede brinde retroativo).
export const SUBSCRIPTION_GIFTS_ORDER_AGE_ACCEPT_HOURS = 168;
// Duração padrão da concessão (lease) de processamento de um job.
export const SUBSCRIPTION_GIFTS_LEASE_MS = 45_000;
export const SUBSCRIPTION_GIFTS_PROCESS_DEADLINE_MS = 12_000;
export const SUBSCRIPTION_GIFTS_MAX_ATTEMPTS = 3;

export type SubscriptionGiftSchedule = "FIRST_ORDER" | "RENEWALS" | "BOTH";
export type SubscriptionGiftSelectionMode = "FIXED_VARIANT" | "RANDOM_GROUP";
export type SubscriptionGiftJobStatus =
  | "PENDING"
  | "COMMIT_PENDING"
  | "COMMITTED"
  | "SKIPPED"
  | "FAILED"
  | "UNCERTAIN";

export interface GiftVariantEntry {
  variantId: string;
  productId?: string;
  title: string;
  sku?: string | null;
}

export interface SubscriptionGiftSettingsInput {
  enabled: boolean;
  schedule: SubscriptionGiftSchedule;
  selectionMode: SubscriptionGiftSelectionMode;
  fixedVariantId?: string | null;
  variantPool: GiftVariantEntry[];
}

export interface SubscriptionGiftSettingsView {
  enabled: boolean;
  enabledAt: string | null;
  schedule: SubscriptionGiftSchedule;
  selectionMode: SubscriptionGiftSelectionMode;
  fixedVariantId: string | null;
  fixedProductId: string | null;
  fixedTitle: string | null;
  fixedSku: string | null;
  variantPool: GiftVariantEntry[];
  maxPoolSize: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export type GiftResultCode =
  | "gift_added"
  | "gift_confirmed"
  | "disabled"
  | "feature_disabled"
  | "schedule_no_match"
  | "predates_gift_enablement"
  | "order_cancelled"
  | "order_fulfilled"
  | "order_not_paid"
  | "order_not_editable"
  | "no_stock"
  | "invalid_pool"
  | "fixed_variant_unavailable"
  | "would_increase_total"
  | "commit_uncertain"
  | "commit_charged"
  | "commit_rejected"
  | "scope_missing"
  | "installation_blocked"
  | "installation_changed"
  | "order_missing"
  | "internal_error";

export const GIFTS_RESULT_LABELS: Partial<Record<GiftResultCode, string>> = {
  gift_added: "Brinde adicionado ao pedido",
  gift_confirmed: "Brinde confirmado no pedido",
  disabled: "Brindes desativados",
  feature_disabled: "Funcionalidade desativada na instalação",
  schedule_no_match: "Regra de brinde não se aplica a este pedido",
  predates_gift_enablement: "Pedido anterior à ativação dos brindes",
  order_cancelled: "Pedido cancelado",
  order_fulfilled: "Pedido já atendido (separado)",
  order_not_paid: "Pedido ainda não pago",
  order_not_editable: "Pedido não editável",
  no_stock: "Nenhum candidato com estoque disponível",
  invalid_pool: "Grupo de variantes inválido",
  fixed_variant_unavailable: "Variante fixa sem estoque ou indisponível",
  would_increase_total: "Edição aumentaria o total/frete",
  commit_uncertain: "Resultado do commit incerto (revisão)",
  commit_charged: "Linha gratuita cobrada (revisão)",
  commit_rejected: "Commit rejeitado pela Shopify",
  scope_missing: "Permissão write_order_edits ausente",
  installation_blocked: "Instalação bloqueada",
  installation_changed: "Instalação da loja alterada",
  order_missing: "Pedido não encontrado",
  internal_error: "Erro interno",
};

export const GIFT_SCHEDULES: SubscriptionGiftSchedule[] = ["FIRST_ORDER", "RENEWALS", "BOTH"];
export const GIFT_SELECTION_MODES: SubscriptionGiftSelectionMode[] = ["FIXED_VARIANT", "RANDOM_GROUP"];
export const GIFT_JOB_STATUSES: SubscriptionGiftJobStatus[] = [
  "PENDING",
  "COMMIT_PENDING",
  "COMMITTED",
  "SKIPPED",
  "FAILED",
  "UNCERTAIN",
];

export function isGiftSchedule(value: unknown): value is SubscriptionGiftSchedule {
  return typeof value === "string" && GIFT_SCHEDULES.includes(value as SubscriptionGiftSchedule);
}

export function isGiftSelectionMode(value: unknown): value is SubscriptionGiftSelectionMode {
  return typeof value === "string" && GIFT_SELECTION_MODES.includes(value as SubscriptionGiftSelectionMode);
}

export function subscriptionGiftsFeatureEnabled(): boolean {
  return process.env[SUBSCRIPTION_GIFTS_FEATURE_FLAG] === "true";
}