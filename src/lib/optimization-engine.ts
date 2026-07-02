import type { ClientKpiConfig } from "./client-kpi-contract";
import { extractPresetBucket, aggregateByAccountBucket, evaluateRule, bucketKey, type InsightRow } from "./meta-insights";

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

    const campaignBucket = extractPresetBucket(campaign.name);
    if (campaignBucket === "Outros") continue; // fora dos 4 presets conhecidos — sem regra de KPI aplicável

    // Linha sintética no shape que o motor genérico de meta-insights.ts espera. ad_account_id e
    // campaign_name NÃO vêm do insight bruto da Meta (não estão em INSIGHTS_FIELDS) — vêm daqui.
    // Omitir/errar esses dois campos faz aggregateByAccountBucket descartar a linha silenciosamente
    // (row sem ad_account_id é ignorada) e nenhuma violação jamais dispara.
    const row: InsightRow = {
      ad_account_id: config.adAccountId,
      campaign_name: campaign.name,
      spend: insight.spend as string,
      impressions: insight.impressions as string,
      clicks: insight.clicks as string,
      actions: insight.actions as InsightRow["actions"],
    };
    const agg = aggregateByAccountBucket([row]).get(bucketKey(config.adAccountId, campaignBucket));

    for (const kpi of config.kpi) {
      if (kpi.presetBucket !== campaignBucket) continue;

      const evalResult = evaluateRule(
        { metric_key: kpi.metric, comparator: kpi.operator, threshold_value: kpi.value },
        agg
      );
      if (!evalResult.computable || !evalResult.triggered) continue;

      violations.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        clientName: config.clientName,
        adAccountId: config.adAccountId,
        metric: kpi.metric,
        operator: kpi.operator,
        actual: evalResult.value as number,
        limit: kpi.value,
      });
    }
  }

  return violations;
}
