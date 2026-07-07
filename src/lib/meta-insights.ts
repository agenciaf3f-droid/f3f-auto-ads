import { supabase } from "@/integrations/supabase/client";

// ── Buckets de preset ────────────────────────────────────────────────────────
export type PresetBucket = "FASE 1" | "FASE 2" | "FASE 3" | "L.T";
export const PRESET_BUCKETS: PresetBucket[] = ["FASE 1", "FASE 2", "FASE 3", "L.T"];
export const OTHER_BUCKET = "Outros" as const;
export type BucketKey = PresetBucket | typeof OTHER_BUCKET;

// Extrai o preset do nome da campanha. A posição do colchete NÃO é fixa:
//   FASE 1/2/3 (generateCampaignName):  [FASE N] [GERENCIADOR] ...  -> preset no 1º colchete
//   L.T (generateLtCampaignName):       [PRODUTO] [L.T] [dd/mm] ... -> preset no 2º colchete
// Por isso varremos TODOS os grupos [...] e pegamos o 1º que bate um bucket conhecido.
// Normaliza pelo PREFIXO ("FASE 1 - TRÁFEGO", "FASE 3 - LEADS | ZAP", "FASE 2 ADAPTADO" -> "FASE N"):
// campanhas nomeadas com o label descritivo do preset (em vez do `.fase` limpo) senão caem
// em "Outros" e nunca disparam violação — mesmo bug do L.T, só que pras 3 fases. Usar posição
// fixa jogaria toda L.T em "Outros".
// (Mesma lógica de extractPresetBucket() do branch de Otimizações — manter em sincronia.)
export function extractPresetBucket(campaignName?: string | null): BucketKey {
  if (!campaignName) return OTHER_BUCKET;
  const groups = campaignName.match(/\[([^\]]+)\]/g) || [];
  for (const g of groups) {
    const inner = g.slice(1, -1).trim().toUpperCase();
    const normalized = ["FASE 1", "FASE 2", "FASE 3"].find((p) => inner.startsWith(p)) || inner;
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
  video_p95_watched_actions?: { action_type: string; value: string }[];
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
  vv95: number;
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
        vv95: 0,
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
    for (const v of row.video_p95_watched_actions || []) {
      agg.vv95 += num(v.value);
    }
  }
  return map;
}

export const bucketKey = (adAccountId: string, bucket: BucketKey) => `${adAccountId}::${bucket}`;

// ── Registry de métricas ─────────────────────────────────────────────────────
// compute() devolve null quando não é computável (denominador 0) — evita NaN/Infinity
// e divisão por zero em bucket vazio. `verified` = action_type confirmado contra um
// payload REAL de /insights. Escalares (spend/ctr/cpm/cpc) são certos.
export interface MetricDef {
  key: string;
  label: string;
  unit: "currency" | "percent" | "count";
  verified: boolean;
  compute: (agg: AggregatedBucket) => number | null;
  // Buckets em que a métrica aparece no dropdown de KPI. Omitido = todos (comportamento
  // pré-existente das genéricas: spend/ctr/cpm/cpc/whatsapp/purchase).
  buckets?: PresetBucket[];
}

// action_type confirmado contra o catálogo oficial de campos da Meta (ads_get_field_context):
// "actions:omni_purchase" é o tipo unificado de compra retornado pela Graph API atual.
// "offsite_conversion.fb_pixel_purchase" (usado antes) é o tipo legado do Pixel antigo e
// não aparece mais no catálogo — trocado.
//
// "onsite_conversion.messaging_conversation_started_7d" confirmado em 2026-07-04 via MCP
// Meta-ADS (oráculo) contra 3 campanhas FASE 3 reais e ativas na conta 611479810596612:
// spend/contagem de "Messaging conversations started" reconcilia ao centavo com o
// cost_per_result que a própria Meta exibe (ex.: R$13.875,43 / 664 = R$20,90).
export const CONFIRMED_ACTION_TYPES = {
  purchase: "omni_purchase",
  whatsappConversation: "onsite_conversion.messaging_conversation_started_7d",
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
    verified: true,
    compute: (a) => {
      const c = a.actionCounts[CONFIRMED_ACTION_TYPES.whatsappConversation] || 0;
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
  {
    key: "ccp",
    label: "CCP",
    unit: "currency",
    verified: true,
    buckets: ["FASE 2"],
    // Valor usado ÷ (Cliques (todos) − Cliques no link) — fórmula confirmada com o usuário
    // (mesmo cálculo usado no Stract). "link_click" é action_type padrão da Meta.
    compute: (a) => {
      const nonLinkClicks = a.clicks - (a.actionCounts["link_click"] || 0);
      return nonLinkClicks > 0 ? a.spend / nonLinkClicks : null;
    },
  },
  {
    key: "cpv95",
    label: "CPV95%",
    unit: "currency",
    verified: true,
    buckets: ["FASE 2"],
    // Valor usado ÷ VV95% (video_p95_watched_actions — campo padrão da Meta, fora do array
    // genérico de actions).
    compute: (a) => (a.vv95 > 0 ? a.spend / a.vv95 : null),
  },
];

export const getMetricDef = (key: string): MetricDef | undefined =>
  METRIC_REGISTRY.find((m) => m.key === key);

// Formata um valor de métrica conforme a unidade: moeda (R$ pt-BR), percentual (%) ou contagem.
// Fonte única compartilhada entre a aba Otimizações (exibição do valor atual/limite) e a aba
// Clientes (exibição do limite de KPI definido) — evita o número cru "20.9" no lugar de "R$ 20,90".
export function formatMetricValue(value: number | null, unit?: MetricDef["unit"]): string {
  if (value === null || value === undefined) return "sem dados suficientes";
  const formatted = value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (unit === "currency") return `R$ ${formatted}`;
  if (unit === "percent") return `${formatted}%`;
  return formatted;
}

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

// Chave estável do período pra guardar junto do snapshot de KPI. Comparar "estava em X → agora Y"
// só faz sentido dentro do MESMO período — snapshot 7d vs valor atual 30d é maçã com laranja.
export function rangeKey(range: DateRangeSelection): string {
  return range.mode === "custom" ? `custom:${range.since}:${range.until}` : `preset:${range.preset}`;
}

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
