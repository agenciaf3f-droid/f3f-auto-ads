import { describe, it, expect } from "vitest";
import {
  compareKpis,
  hasWorsened,
  buildOptimizationView,
  type OptimizationViolation,
  type OptimizationActionRecord,
} from "./optimization-engine";
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

  it("does not apply an L.T rule to a campaign whose product token merely starts with the filter (prefix collision)", () => {
    const ltConfig: ClientKpiConfig = {
      ...config,
      kpi: [{ metric: "cpc", operator: ">", value: 2, presetBucket: "L.T", campaignNameFilter: "DDX" }],
    };
    // "[DDXPRO]" contém "ddx" como substring, mas NÃO como token [ddx] — não deve casar.
    const prefixCampaigns = [{ id: "c8", name: "[DDXPRO] [L.T] [02/07] [ABO] [TESTE] [CRIATIVO] -" }];
    const violations = compareKpis(prefixCampaigns, { c8: { spend: "50", clicks: "10" } }, ltConfig);
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

describe("buildOptimizationView", () => {
  const RK = "preset:last_7d"; // rangeKey atual em todos os testes salvo indicação
  const viol = (over: Partial<OptimizationViolation> = {}): OptimizationViolation => ({
    campaignId: "c1", campaignName: "Camp 1", clientName: "Cli", adAccountId: "act_1",
    metric: "cpc", operator: ">", actual: 3, limit: 2, severity: "red", isCbo: false, ...over,
  });
  const act = (over: Partial<OptimizationActionRecord> = {}): OptimizationActionRecord => ({
    campaignId: "c1", campaignName: "Camp 1", clientName: "Cli", action: "dismissed",
    snapshot: { metric: "cpc", actual: 3, limit: 2, operator: ">", rangeKey: RK },
    createdAt: "2026-07-05T10:00:00Z", ...over,
  });

  it("campanha nunca tratada vai pra Pendentes, não pro Histórico", () => {
    const { pendentes, history } = buildOptimizationView([viol()], [], RK, new Set());
    expect(pendentes).toHaveLength(1);
    expect(history).toHaveLength(0);
  });

  it("campanha tratada sai de Pendentes e vai pro Histórico (reavaliada ao vivo)", () => {
    const { pendentes, history } = buildOptimizationView([viol()], [act()], RK, new Set());
    expect(pendentes).toHaveLength(0);
    expect(history).toHaveLength(1);
    expect(history[0].live).not.toBeNull();
  });

  it("deduplica pra a ação mais recente por campanha (por createdAt)", () => {
    const older = act({ action: "dismissed", createdAt: "2026-07-01T00:00:00Z" });
    const newer = act({ action: "paused", createdAt: "2026-07-05T00:00:00Z" });
    const { history } = buildOptimizationView([viol()], [older, newer], RK, new Set());
    expect(history).toHaveLength(1);
    expect(history[0].action.action).toBe("paused");
  });

  it("pausa de CAMPANHA cuja campanha voltou a ficar ATIVA (religada/reativada) some do Histórico e volta pra Pendentes", () => {
    const paused = act({ action: "paused" });
    const { pendentes, history } = buildOptimizationView([viol()], [paused], RK, new Set(["c1"]));
    expect(history).toHaveLength(0);   // campanha ativa de novo → some do Histórico
    expect(pendentes).toHaveLength(1); // e volta pra Pendentes (ainda fura KPI)
  });

  it("só pausa de CAMPANHA passa pelo active-status: 'dismissed' (Mantida) de campanha ATIVA continua no Histórico", () => {
    const kept = act({ action: "dismissed" });
    const { pendentes, history } = buildOptimizationView([viol()], [kept], RK, new Set(["c1"]));
    expect(history).toHaveLength(1);   // Mantida ativa é o estado normal — não sai
    expect(pendentes).toHaveLength(0);
  });

  it("pausa de NÓ (adset/ad): fica no Histórico como log mesmo com a campanha ATIVA e NÃO suprime a campanha de Pendentes", () => {
    const nodePause = act({
      action: "paused",
      snapshot: { metric: "cpc", actual: 3, operator: ">", rangeKey: RK, nodeLevel: "adset", nodeId: "as1", nodeName: "Conjunto A" },
    });
    const { pendentes, history } = buildOptimizationView([viol()], [nodePause], RK, new Set(["c1"]));
    expect(history).toHaveLength(1);              // log do nó não passa pelo active-status → fica
    expect(history[0].live).toBeNull();           // nó é log puro, sem violação viva
    expect(history[0].action.snapshot.nodeLevel).toBe("adset");
    expect(pendentes).toHaveLength(1);            // campanha segue em Pendentes (nó não trata a campanha)
  });

  it("pausas de NÓS diferentes na mesma campanha viram entradas SEPARADAS no Histórico", () => {
    const nodeA = act({ createdAt: "2026-07-05T10:00:00Z", action: "paused", snapshot: { metric: "cpc", rangeKey: RK, nodeLevel: "adset", nodeId: "as1", nodeName: "A" } });
    const nodeB = act({ createdAt: "2026-07-05T11:00:00Z", action: "paused", snapshot: { metric: "cpc", rangeKey: RK, nodeLevel: "ad", nodeId: "ad9", nodeName: "B" } });
    const { history } = buildOptimizationView([], [nodeA, nodeB], RK, new Set());
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.action.snapshot.nodeId).sort()).toEqual(["ad9", "as1"]);
  });

  it("marca 'piorou' quando o valor atual degrada vs o snapshot (mesmo período)", () => {
    const { history } = buildOptimizationView([viol({ actual: 4 })], [act({ snapshot: { metric: "cpc", actual: 3, operator: ">", rangeKey: RK } })], RK, new Set());
    expect(history[0].comparable).toBe(true);
    expect(history[0].worsened).toBe(true);
  });

  it("NÃO marca 'piorou' quando o snapshot foi tirado em período diferente do atual", () => {
    const snap = { metric: "cpc", actual: 3, operator: ">" as const, rangeKey: "preset:last_30d" };
    const { history } = buildOptimizationView([viol({ actual: 999 })], [act({ snapshot: snap })], RK, new Set());
    expect(history[0].comparable).toBe(false);
    expect(history[0].worsened).toBe(false);
  });

  it("snapshot legado (sem métrica/actual/rangeKey) não é comparável, não crasha, e não engole a violação viva", () => {
    // Ação sem métrica não casa com nenhuma violação viva → a violação de cpc segue em Pendentes
    // (não sumiu) e a entrada de histórico fica sem live.
    const { pendentes, history } = buildOptimizationView([viol({ actual: 999 })], [act({ snapshot: {} })], RK, new Set());
    expect(pendentes).toHaveLength(1);
    expect(history[0].comparable).toBe(false);
    expect(history[0].worsened).toBe(false);
    expect(history[0].live).toBeNull();
  });

  it("2ª métrica que estoura depois NÃO é engolida: fica em Pendentes mesmo com a 1ª já tratada", () => {
    const found = [viol({ metric: "cpc", actual: 3 }), viol({ metric: "ctr", operator: "<", actual: 0.5 })];
    const actions = [act({ snapshot: { metric: "cpc", actual: 3, operator: ">", rangeKey: RK } })]; // manteve só cpc
    const { pendentes, history } = buildOptimizationView(found, actions, RK, new Set());
    expect(pendentes.map((v) => v.metric)).toEqual(["ctr"]); // ctr novo continua alertando
    expect(history).toHaveLength(1);
    expect(history[0].action.snapshot.metric).toBe("cpc");
    expect(history[0].live?.metric).toBe("cpc");
  });

  it("não faz comparação cross-métrica: ação de cpc + violação viva só de cpm → live null, sem 'piorou' falso", () => {
    const found = [viol({ metric: "cpm", actual: 25 })];
    const actions = [act({ snapshot: { metric: "cpc", actual: 3, operator: ">", rangeKey: RK } })];
    const { pendentes, history } = buildOptimizationView(found, actions, RK, new Set());
    expect(pendentes.map((v) => v.metric)).toEqual(["cpm"]); // cpm nunca tratado → pendente
    expect(history[0].live).toBeNull();                       // cpc sem violação viva → resolvido
    expect(history[0].worsened).toBe(false);
  });

  it("campanha tratada que sarou/foi pausada (fora da avaliação ao vivo) fica no Histórico com live=null", () => {
    const { pendentes, history } = buildOptimizationView([], [act()], RK, new Set());
    expect(pendentes).toHaveLength(0);
    expect(history).toHaveLength(1);
    expect(history[0].live).toBeNull();
  });

  it("ordena: piorou → ainda-fora → resolvida", () => {
    const found = [viol({ campaignId: "worse", actual: 5 }), viol({ campaignId: "same", actual: 3 })];
    const actions = [
      act({ campaignId: "worse", snapshot: { metric: "cpc", actual: 3, operator: ">", rangeKey: RK } }),   // piorou
      act({ campaignId: "same", snapshot: { metric: "cpc", actual: 3, operator: ">", rangeKey: RK } }),    // ainda-fora, igual
      act({ campaignId: "healed" }),                                                                        // resolvida (não está em found)
    ];
    const { history } = buildOptimizationView(found, actions, RK, new Set());
    expect(history.map((h) => h.action.campaignId)).toEqual(["worse", "same", "healed"]);
  });
});

describe("hasWorsened", () => {
  it("'>' (limite máximo): pior quando o valor atual sobe acima do snapshot", () => {
    expect(hasWorsened(">", 3.5, 3.0)).toBe(true);
    expect(hasWorsened(">", 2.5, 3.0)).toBe(false); // melhorou
    expect(hasWorsened(">", 3.0, 3.0)).toBe(false); // igual não é piorar
  });

  it("'<' (limite mínimo): pior quando o valor atual cai abaixo do snapshot", () => {
    expect(hasWorsened("<", 0.4, 0.8)).toBe(true);
    expect(hasWorsened("<", 1.2, 0.8)).toBe(false); // melhorou
    expect(hasWorsened("<", 0.8, 0.8)).toBe(false); // igual não é piorar
  });
});
