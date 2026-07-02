import { supabase } from "@/integrations/supabase/client";

// ── Buckets de preset ────────────────────────────────────────────────────────
export type PresetBucket = "FASE 1" | "FASE 2" | "FASE 3" | "L.T";
export const PRESET_BUCKETS: PresetBucket[] = ["FASE 1", "FASE 2", "FASE 3", "L.T"];
export const OTHER_BUCKET = "Outros" as const;
export type BucketKey = PresetBucket | typeof OTHER_BUCKET;

// Extrai o preset do nome da campanha. A posição do colchete NÃO é fixa:
//   FASE 1/2/3 (generateCampaignName):  [FASE N] [GERENCIADOR] ...  -> preset no 1º colchete
//   L.T (generateLtCampaignName):       [PRODUTO] [L.T] [dd/mm] ... -> preset no 2º colchete
// Por isso varremos TODOS os grupos [...] e pegamos o 1º que bate um bucket conhecido,
// normalizando "FASE 2 ADAPTADO" -> "FASE 2". Usar posição fixa jogaria toda L.T em "Outros".
// (Mesma lógica de extractPresetBucket() do branch de Otimizações — manter em sincronia.)
export function extractPresetBucket(campaignName?: string | null): BucketKey {
  if (!campaignName) return OTHER_BUCKET;
  const groups = campaignName.match(/\[([^\]]+)\]/g) || [];
  for (const g of groups) {
    const inner = g.slice(1, -1).trim().toUpperCase();
    const normalized = inner.startsWith("FASE 2") ? "FASE 2" : inner;
    if ((PRESET_BUCKETS as string[]).includes(normalized)) return normalized as PresetBucket;
  }
  return OTHER_BUCKET;
}

// ── Linha crua de insight (como vem da edge meta-client-insights) ────────────
// Meta devolve números como string; ad_account_id é injetado pela edge por linha.
export interface InsightRow {
  ad_account_id: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpm?: string;
  frequency?: string;
  reach?: string;
  actions?: { action_type: string; value: string }[];
  cost_per_action_type?: { action_type: string; value: string }[];
}

const num = (v?: string | number): number => {
  const n = typeof v === "number" ? v : parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};

// ── Agregado por (conta, bucket) ─────────────────────────────────────────────
// Soma componentes BRUTOS (spend/impressions/clicks/contagens de actions) apenas entre
// campanhas do MESMO bucket DENTRO da MESMA conta — nunca cruza contas (chave composta).
// Razões (ctr/cpm/cpc/custo-por-ação) são derivadas depois, sobre as somas.
export interface AggregatedBucket {
  adAccountId: string;
  bucket: BucketKey;
  spend: number;
  impressions: number;
  clicks: number;
  actionCounts: Record<string, number>;
  campaignCount: number;
}

export function aggregateByAccountBucket(insights: InsightRow[]): Map<string, AggregatedBucket> {
  const map = new Map<string, AggregatedBucket>();
  for (const row of insights) {
    if (!row.ad_account_id) continue;
    const bucket = extractPresetBucket(row.campaign_name);
    const key = `${row.ad_account_id}::${bucket}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        adAccountId: row.ad_account_id,
        bucket,
        spend: 0,
        impressions: 0,
        clicks: 0,
        actionCounts: {},
        campaignCount: 0,
      };
      map.set(key, agg);
    }
    agg.spend += num(row.spend);
    agg.impressions += num(row.impressions);
    agg.clicks += num(row.clicks);
    agg.campaignCount += 1;
    for (const a of row.actions || []) {
      agg.actionCounts[a.action_type] = (agg.actionCounts[a.action_type] || 0) + num(a.value);
    }
  }
  return map;
}

export const bucketKey = (adAccountId: string, bucket: BucketKey) => `${adAccountId}::${bucket}`;

// ── Registry de métricas ─────────────────────────────────────────────────────
// compute() devolve null quando não é computável (denominador 0) — evita NaN/Infinity
// e divisão por zero em bucket vazio. `verified` = action_type confirmado contra um
// payload REAL de /insights. Os cost-per-action ainda são PENDENTES: as strings de
// action_type abaixo são candidatas e precisam ser confirmadas antes de virarem
// load-bearing (decisão #6 do plano). Escalares (spend/ctr/cpm/cpc) são certos.
export interface MetricDef {
  key: string;
  label: string;
  unit: "currency" | "percent" | "count";
  verified: boolean;
  compute: (agg: AggregatedBucket) => number | null;
}

// action_type candidato — NÃO confirmado contra payload real ainda.
export const PENDING_ACTION_TYPES = {
  whatsappConversation: "onsite_conversion.messaging_conversation_started_7d",
} as const;

// action_type confirmado contra o catálogo oficial de campos da Meta (ads_get_field_context):
// "actions:omni_purchase" é o tipo unificado de compra retornado pela Graph API atual.
// "offsite_conversion.fb_pixel_purchase" (usado antes) é o tipo legado do Pixel antigo e
// não aparece mais no catálogo — trocado.
export const CONFIRMED_ACTION_TYPES = {
  purchase: "omni_purchase",
} as const;

export const METRIC_REGISTRY: MetricDef[] = [
  {
    key: "spend",
    label: "Gasto total",
    unit: "currency",
    verified: true,
    compute: (a) => a.spend,
  },
  {
    key: "ctr",
    label: "CTR",
    unit: "percent",
    verified: true,
    compute: (a) => (a.impressions > 0 ? (a.clicks / a.impressions) * 100 : null),
  },
  {
    key: "cpm",
    label: "CPM",
    unit: "currency",
    verified: true,
    compute: (a) => (a.impressions > 0 ? (a.spend / a.impressions) * 1000 : null),
  },
  {
    key: "cpc",
    label: "CPC",
    unit: "currency",
    verified: true,
    compute: (a) => (a.clicks > 0 ? a.spend / a.clicks : null),
  },
  {
    key: "cost_per_whatsapp_conversation",
    label: "Custo por conversa (WhatsApp)",
    unit: "currency",
    verified: false,
    compute: (a) => {
      const c = a.actionCounts[PENDING_ACTION_TYPES.whatsappConversation] || 0;
      return c > 0 ? a.spend / c : null;
    },
  },
  {
    key: "cost_per_purchase",
    label: "Custo por venda",
    unit: "currency",
    verified: true,
    compute: (a) => {
      const c = a.actionCounts[CONFIRMED_ACTION_TYPES.purchase] || 0;
      return c > 0 ? a.spend / c : null;
    },
  },
];

export const getMetricDef = (key: string): MetricDef | undefined =>
  METRIC_REGISTRY.find((m) => m.key === key);

// ── Avaliação de regra ───────────────────────────────────────────────────────
export interface KpiRule {
  metric_key: string;
  comparator: ">" | "<";
  threshold_value: number;
}
export interface RuleEvaluation {
  value: number | null;
  triggered: boolean; // true = "ruim" (threshold cruzado)
  computable: boolean;
}

export function evaluateRule(rule: KpiRule, agg: AggregatedBucket | undefined): RuleEvaluation {
  const def = getMetricDef(rule.metric_key);
  if (!def || !agg) return { value: null, triggered: false, computable: false };
  const value = def.compute(agg);
  if (value === null) return { value: null, triggered: false, computable: false };
  const triggered = rule.comparator === ">" ? value > rule.threshold_value : value < rule.threshold_value;
  return { value, triggered, computable: true };
}

// ── Range de datas ───────────────────────────────────────────────────────────
export type DateRangeSelection =
  | { mode: "preset"; preset: string }
  | { mode: "custom"; since: string; until: string };

export const DATE_PRESETS: { value: string; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "last_7d", label: "Últimos 7 dias" },
  { value: "last_14d", label: "Últimos 14 dias" },
  { value: "last_30d", label: "Últimos 30 dias" },
  { value: "this_month", label: "Este mês" },
  { value: "last_month", label: "Mês passado" },
  { value: "last_90d", label: "Últimos 90 dias" },
];

// ── Chamada à edge ───────────────────────────────────────────────────────────
export async function fetchClientInsights(
  accessToken: string,
  adAccountIds: string[],
  range: DateRangeSelection,
): Promise<{ insights: InsightRow[]; errors: { ad_account_id: string; message: string }[] }> {
  const body: Record<string, unknown> = { access_token: accessToken, ad_account_ids: adAccountIds };
  if (range.mode === "custom") {
    body.since = range.since;
    body.until = range.until;
  } else {
    body.date_preset = range.preset;
  }
  const { data, error } = await supabase.functions.invoke("meta-client-insights", { body });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return { insights: data?.insights || [], errors: data?.errors || [] };
}
