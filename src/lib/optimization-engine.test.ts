import { describe, it, expect } from "vitest";
import { compareKpis, extractPresetBucket } from "./optimization-engine";
import type { ClientKpiConfig } from "./client-kpi-contract";

const config: ClientKpiConfig = {
  clientId: "client-1",
  clientName: "Cliente X",
  adAccountId: "act_1",
  kpi: [{ metric: "cpc", operator: ">", value: 2, presetBucket: "FASE 1" }],
};

const campaigns = [{ id: "c1", name: "[FASE 1] [GERENCIADOR] [2026-07-02] [Publico] [R$100]" }];

describe("compareKpis", () => {
  it("flags a campaign when the metric exceeds the '>' threshold", () => {
    const violations = compareKpis(campaigns, { c1: { cpc: "3.5" } }, config);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ campaignId: "c1", metric: "cpc", actual: 3.5, limit: 2 });
  });

  it("does not flag a campaign within the threshold", () => {
    const violations = compareKpis(campaigns, { c1: { cpc: "1.2" } }, config);
    expect(violations).toHaveLength(0);
  });

  it("flags a campaign when the metric is below a '<' threshold", () => {
    const belowConfig: ClientKpiConfig = {
      ...config,
      kpi: [{ metric: "ctr", operator: "<", value: 1, presetBucket: "FASE 1" }],
    };
    const violations = compareKpis(campaigns, { c1: { ctr: "0.4" } }, belowConfig);
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

  it("skips a metric that isn't present in the insight payload", () => {
    const violations = compareKpis(campaigns, { c1: { spend: "100" } }, config);
    expect(violations).toHaveLength(0);
  });

  it("does not apply a FASE 1 rule to a FASE 3 campaign in the same account", () => {
    const fase3Campaigns = [{ id: "c2", name: "[FASE 3] [GERENCIADOR] [2026-07-02] [Publico] [R$100]" }];
    const violations = compareKpis(fase3Campaigns, { c2: { cpc: "99" } }, config);
    expect(violations).toHaveLength(0);
  });

  it("matches a FASE 2 ADAPTADO campaign against the FASE 2 bucket", () => {
    const adaptadoConfig: ClientKpiConfig = {
      ...config,
      kpi: [{ metric: "cpc", operator: ">", value: 2, presetBucket: "FASE 2" }],
    };
    const adaptadoCampaigns = [{ id: "c3", name: "[FASE 2 ADAPTADO] [GERENCIADOR] [2026-07-02] [Publico] [R$100]" }];
    const violations = compareKpis(adaptadoCampaigns, { c3: { cpc: "5" } }, adaptadoConfig);
    expect(violations).toHaveLength(1);
  });

  it("skips campaigns whose bucket isn't recognized (Outros)", () => {
    const outrosCampaigns = [{ id: "c4", name: "Campanha manual sem prefixo" }];
    const violations = compareKpis(outrosCampaigns, { c4: { cpc: "99" } }, config);
    expect(violations).toHaveLength(0);
  });
});

describe("extractPresetBucket", () => {
  it("extracts FASE 1/2/3 from the first bracket group", () => {
    expect(extractPresetBucket("[FASE 1] [GERENCIADOR] [2026-07-02] [Publico] [R$100]")).toBe("FASE 1");
    expect(extractPresetBucket("[FASE 3] [GERENCIADOR] [2026-07-02] [Publico] [R$100]")).toBe("FASE 3");
  });

  it("normalizes FASE 2 ADAPTADO into the FASE 2 bucket", () => {
    expect(extractPresetBucket("[FASE 2 ADAPTADO] [GERENCIADOR] [2026-07-02] [Publico] [R$100]")).toBe("FASE 2");
  });

  it("extracts L.T from the second bracket group (naming.ts puts the product name first)", () => {
    expect(extractPresetBucket("[Produto X] [L.T] [02/07] [ABO] [TESTE] [CRIATIVO] -")).toBe("L.T");
  });

  it("returns null for campaigns without a recognized preset prefix", () => {
    expect(extractPresetBucket("Campanha manual sem prefixo")).toBeNull();
  });
});
