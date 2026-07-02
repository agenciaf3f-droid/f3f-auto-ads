import { describe, it, expect } from "vitest";
import { compareKpis } from "./optimization-engine";
import type { ClientKpiConfig } from "./client-kpi-contract";

const config: ClientKpiConfig = {
  clientId: "client-1",
  clientName: "Cliente X",
  adAccountId: "act_1",
  kpi: [{ metric: "cpc", operator: ">", value: 2 }],
};

const campaigns = [{ id: "c1", name: "Campanha 1" }];

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
    const belowConfig: ClientKpiConfig = { ...config, kpi: [{ metric: "ctr", operator: "<", value: 1 }] };
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
});
