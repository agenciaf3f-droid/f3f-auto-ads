import type { ClientKpiConfig } from "./client-kpi-contract";

export type Campaign = { id: string; name: string };

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

    for (const kpi of config.kpi) {
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
