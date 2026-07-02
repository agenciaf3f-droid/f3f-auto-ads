import type { ClientKpiConfig, PresetBucket } from "./client-kpi-contract";

export type Campaign = { id: string; name: string };

const KNOWN_BUCKETS: PresetBucket[] = ["FASE 1", "FASE 2", "FASE 3", "L.T"];

// Nome de campanha carrega o preset entre colchetes, mas a posição varia:
// FASE 1/2/3 usam `[FASE N] [GERENCIADOR] ...` (preset no 1º colchete);
// L.T usa `[PRODUTO] [L.T] [dd/mm] ...` (preset no 2º colchete) — ver naming.ts.
// Por isso varremos todos os grupos `[...]` em vez de assumir posição fixa.
// "FASE 2 ADAPTADO" cai no bucket "FASE 2" (mesmo preset, nome de público difere).
export function extractPresetBucket(campaignName: string): PresetBucket | null {
  const groups = campaignName.match(/\[([^\]]+)\]/g) ?? [];
  for (const group of groups) {
    const label = group.slice(1, -1);
    if (label === "FASE 2 ADAPTADO") return "FASE 2";
    if ((KNOWN_BUCKETS as string[]).includes(label)) return label as PresetBucket;
  }
  return null;
}

// Insight cru da Meta pra uma campanha, ou null quando ainda não há veiculação suficiente
// pra avaliar. `error` aparece quando a Meta recusou aquele campaign_id específico.
export type CampaignInsight = Record<string, unknown> & { error?: string };
export type InsightsMap = Record<string, CampaignInsight | null>;

export type OptimizationViolation = {
  campaignId: string;
  campaignName: string;
  clientName: string;
  adAccountId: string;
  metric: string;
  operator: ">" | "<";
  actual: number;
  limit: number;
};

export function compareKpis(
  campaigns: Campaign[],
  insights: InsightsMap,
  config: ClientKpiConfig
): OptimizationViolation[] {
  const violations: OptimizationViolation[] = [];

  for (const campaign of campaigns) {
    const insight = insights[campaign.id];
    if (!insight || insight.error) continue;

    const campaignBucket = extractPresetBucket(campaign.name);
    if (!campaignBucket) continue; // fora dos 4 presets conhecidos ("Outros") — sem regra de KPI aplicável

    for (const kpi of config.kpi) {
      if (kpi.presetBucket !== campaignBucket) continue;

      const actual = Number(insight[kpi.metric]);
      if (Number.isNaN(actual)) continue;

      const violated = kpi.operator === ">" ? actual > kpi.value : actual < kpi.value;
      if (!violated) continue;

      violations.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        clientName: config.clientName,
        adAccountId: config.adAccountId,
        metric: kpi.metric,
        operator: kpi.operator,
        actual,
        limit: kpi.value,
      });
    }
  }

  return violations;
}
