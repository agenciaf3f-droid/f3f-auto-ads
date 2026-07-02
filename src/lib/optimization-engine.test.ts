import { describe, it, expect } from "vitest";
import { compareKpis, isDismissalActive } from "./optimization-engine";
import type { ClientKpiConfig } from "./client-kpi-contract";

// extractPresetBucket itself is exercised by meta-insights.test.ts — compareKpis now delegates
// bucket extraction and metric math to that module, so fixtures here use raw Meta insight fields
// (spend/impressions/clicks) rather than pre-computed ratios, matching how METRIC_REGISTRY computes them.

const config: ClientKpiConfig = {
  clientId: "client-1",
  clientName: "Cliente X",
  adAccountId: "act_1",
  kpi: [{ metric: "cpc", operator: ">", value: 2, presetBucket: "FASE 1", campaignNameFilter: null }],
};

const campaigns = [{ id: "c1", name: "[FASE 1] [GERENCIADOR] [2026-07-02] [Publico] [R$100]" }];

describe("compareKpis", () => {
  it("flags a campaign when the metric exceeds the '>' threshold", () => {
    // cpc = spend / clicks = 35 / 10 = 3.5
    const violations = compareKpis(campaigns, { c1: { spend: "35", clicks: "10" } }, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ campaignId: "c1", metric: "cpc", actual: 3.5, limit: 2 });
  });

  it("does not flag a campaign within the threshold", () => {
    // cpc = 12 / 10 = 1.2
    const violations = compareKpis(campaigns, { c1: { spend: "12", clicks: "10" } }, config);
    expect(violations).toHaveLength(0);
  });

  it("flags a campaign when the metric is below a '<' threshold", () => {
    const belowConfig: ClientKpiConfig = {
      ...config,
      kpi: [{ metric: "ctr", operator: "<", value: 1, presetBucket: "FASE 1", campaignNameFilter: null }],
    };
    // ctr = (clicks / impressions) * 100 = (4 / 1000) * 100 = 0.4
    const violations = compareKpis(campaigns, { c1: { impressions: "1000", clicks: "4" } }, belowConfig);
    expect(violations).toHaveLength(1);
  });

  it("skips campaigns with no insight data yet", () => {
    const violations = compareKpis(campaigns, { c1: null }, config);
    expect(violations).toHaveLength(0);
  });

  it("skips campaigns whose insight returned an error", () => {
    const violations = compareKpis(campaigns, { c1: { error: "no data" } }, config);
    expect(violations).toHaveLength(0);
  });

  it("skips a metric that isn't computable from the insight payload (no clicks for cpc)", () => {
    const violations = compareKpis(campaigns, { c1: { spend: "100" } }, config);
    expect(violations).toHaveLength(0);
  });

  it("does not apply a FASE 1 rule to a FASE 3 campaign in the same account", () => {
    const fase3Campaigns = [{ id: "c2", name: "[FASE 3] [GERENCIADOR] [2026-07-02] [Publico] [R$100]" }];
    const violations = compareKpis(fase3Campaigns, { c2: { spend: "990", clicks: "10" } }, config);
    expect(violations).toHaveLength(0);
  });

  it("matches a FASE 2 ADAPTADO campaign against the FASE 2 bucket", () => {
    const adaptadoConfig: ClientKpiConfig = {
      ...config,
      kpi: [{ metric: "cpc", operator: ">", value: 2, presetBucket: "FASE 2", campaignNameFilter: null }],
    };
    const adaptadoCampaigns = [{ id: "c3", name: "[FASE 2 ADAPTADO] [GERENCIADOR] [2026-07-02] [Publico] [R$100]" }];
    // cpc = 50 / 10 = 5
    const violations = compareKpis(adaptadoCampaigns, { c3: { spend: "50", clicks: "10" } }, adaptadoConfig);
    expect(violations).toHaveLength(1);
  });

  it("skips campaigns whose bucket isn't recognized (Outros)", () => {
    const outrosCampaigns = [{ id: "c4", name: "Campanha manual sem prefixo" }];
    const violations = compareKpis(outrosCampaigns, { c4: { spend: "990", clicks: "10" } }, config);
    expect(violations).toHaveLength(0);
  });

  it("applies an L.T rule to a campaign whose name contains the saved product filter", () => {
    const ltConfig: ClientKpiConfig = {
      ...config,
      kpi: [{ metric: "cpc", operator: ">", value: 2, presetBucket: "L.T", campaignNameFilter: "DDX" }],
    };
    const ltCampaigns = [{ id: "c5", name: "[DDX] [L.T] [02/07] [ABO] [TESTE] [CRIATIVO] -" }];
    // cpc = 50 / 10 = 5
    const violations = compareKpis(ltCampaigns, { c5: { spend: "50", clicks: "10" } }, ltConfig);
    expect(violations).toHaveLength(1);
  });

  it("does not apply an L.T rule to a same-bucket campaign of a different product", () => {
    const ltConfig: ClientKpiConfig = {
      ...config,
      kpi: [{ metric: "cpc", operator: ">", value: 2, presetBucket: "L.T", campaignNameFilter: "DDX" }],
    };
    const otherProductCampaigns = [{ id: "c6", name: "[OUTROPRODUTO] [L.T] [02/07] [ABO] [TESTE] [CRIATIVO] -" }];
    const violations = compareKpis(otherProductCampaigns, { c6: { spend: "50", clicks: "10" } }, ltConfig);
    expect(violations).toHaveLength(0);
  });

  it("falls back to bucket-only matching for legacy L.T rules with no saved filter", () => {
    const legacyLtConfig: ClientKpiConfig = {
      ...config,
      kpi: [{ metric: "cpc", operator: ">", value: 2, presetBucket: "L.T", campaignNameFilter: null }],
    };
    const ltCampaigns = [{ id: "c7", name: "[DDX] [L.T] [02/07] [ABO] [TESTE] [CRIATIVO] -" }];
    const violations = compareKpis(ltCampaigns, { c7: { spend: "50", clicks: "10" } }, legacyLtConfig);
    expect(violations).toHaveLength(1);
  });
});

describe("isDismissalActive", () => {
  const now = new Date("2026-07-02T12:00:00Z");

  it("is active right after the dismissal", () => {
    expect(isDismissalActive("2026-07-02T11:00:00Z", now)).toBe(true);
  });

  it("is still active just under 3 days later", () => {
    const almostThreeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000 + 1000).toISOString();
    expect(isDismissalActive(almostThreeDaysAgo, now)).toBe(true);
  });

  it("expires exactly 3 days after the dismissal", () => {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(isDismissalActive(threeDaysAgo, now)).toBe(false);
  });

  it("expires well past 3 days", () => {
    expect(isDismissalActive("2026-06-20T12:00:00Z", now)).toBe(false);
  });
});
