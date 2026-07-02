import { describe, it, expect } from "vitest";
import {
  extractPresetBucket,
  aggregateByAccountBucket,
  bucketKey,
  evaluateRule,
  getMetricDef,
  type InsightRow,
} from "./meta-insights";

describe("extractPresetBucket", () => {
  it("FASE 1/2/3: preset no 1º colchete", () => {
    expect(extractPresetBucket("[FASE 1] [GERENCIADOR] [2026-07-01] [publico] [R$50]")).toBe("FASE 1");
    expect(extractPresetBucket("[FASE 3] [GERENCIADOR] [2026-07-01] [publico] [R$50]")).toBe("FASE 3");
  });

  it("L.T: preset no 2º colchete (bug motivador — não pode virar Outros)", () => {
    // [PRODUTO] [L.T] [dd/mm] [ABO] [TESTE] [CRIATIVO] -
    expect(extractPresetBucket("[Produto X] [L.T] [01/07] [ABO] [TESTE] [CRIATIVO] -")).toBe("L.T");
  });

  it("FASE 2 ADAPTADO normaliza para FASE 2", () => {
    expect(extractPresetBucket("[FASE 2 ADAPTADO] [GERENCIADOR] [2026-07-01] [pub] [R$50]")).toBe("FASE 2");
  });

  it("campanha sem preset conhecido cai em Outros", () => {
    expect(extractPresetBucket("[Campanha manual do Gerenciador]")).toBe("Outros");
    expect(extractPresetBucket("Sem colchete nenhum")).toBe("Outros");
    expect(extractPresetBucket("")).toBe("Outros");
    expect(extractPresetBucket(undefined)).toBe("Outros");
  });
});

describe("aggregateByAccountBucket", () => {
  const rows: InsightRow[] = [
    // conta A, FASE 1 — duas campanhas somam juntas
    { ad_account_id: "act_A", campaign_name: "[FASE 1] [G] [d] [p] [R$]", spend: "100", impressions: "1000", clicks: "50" },
    { ad_account_id: "act_A", campaign_name: "[FASE 1] [G] [d] [p2] [R$]", spend: "50", impressions: "500", clicks: "10" },
    // conta B, FASE 1 — MESMO bucket, conta diferente: NÃO pode misturar com A
    { ad_account_id: "act_B", campaign_name: "[FASE 1] [G] [d] [p] [R$]", spend: "999", impressions: "10", clicks: "1" },
    // conta A, L.T
    { ad_account_id: "act_A", campaign_name: "[Prod] [L.T] [01/07] [ABO] [TESTE] [CRIATIVO] -", spend: "30", impressions: "300", clicks: "6" },
  ];

  it("soma componentes brutos dentro do mesmo (conta, bucket)", () => {
    const agg = aggregateByAccountBucket(rows);
    const a1 = agg.get(bucketKey("act_A", "FASE 1"))!;
    expect(a1.spend).toBe(150);
    expect(a1.impressions).toBe(1500);
    expect(a1.clicks).toBe(60);
    expect(a1.campaignCount).toBe(2);
  });

  it("NUNCA cruza contas diferentes no mesmo bucket (correção #2)", () => {
    const agg = aggregateByAccountBucket(rows);
    const a = agg.get(bucketKey("act_A", "FASE 1"))!;
    const b = agg.get(bucketKey("act_B", "FASE 1"))!;
    expect(a.spend).toBe(150);
    expect(b.spend).toBe(999); // isolado, não somado com A
    expect(a).not.toBe(b);
  });

  it("L.T da conta A é bucketizada corretamente (não some em Outros)", () => {
    const agg = aggregateByAccountBucket(rows);
    expect(agg.has(bucketKey("act_A", "L.T"))).toBe(true);
    expect(agg.get(bucketKey("act_A", "L.T"))!.spend).toBe(30);
  });

  it("soma contagens de actions por action_type", () => {
    const agg = aggregateByAccountBucket([
      { ad_account_id: "act_A", campaign_name: "[FASE 3] [G] [d] [p] [R$]", spend: "10", actions: [{ action_type: "x", value: "3" }] },
      { ad_account_id: "act_A", campaign_name: "[FASE 3] [G] [d] [p] [R$]", spend: "10", actions: [{ action_type: "x", value: "2" }] },
    ]);
    expect(agg.get(bucketKey("act_A", "FASE 3"))!.actionCounts["x"]).toBe(5);
  });
});

describe("métricas derivadas (razão sobre somas)", () => {
  const agg = aggregateByAccountBucket([
    { ad_account_id: "act_A", campaign_name: "[FASE 1] [G]", spend: "100", impressions: "2000", clicks: "40" },
  ]).get(bucketKey("act_A", "FASE 1"))!;

  it("cpm = spend/impressions*1000", () => {
    expect(getMetricDef("cpm")!.compute(agg)).toBeCloseTo(50);
  });
  it("ctr = clicks/impressions*100", () => {
    expect(getMetricDef("ctr")!.compute(agg)).toBeCloseTo(2);
  });
  it("cpc = spend/clicks", () => {
    expect(getMetricDef("cpc")!.compute(agg)).toBeCloseTo(2.5);
  });
  it("spend é o total bruto", () => {
    expect(getMetricDef("spend")!.compute(agg)).toBe(100);
  });
});

describe("bucket vazio / divisão por zero (sem crash)", () => {
  const empty = { adAccountId: "act_A", bucket: "FASE 1" as const, spend: 0, impressions: 0, clicks: 0, actionCounts: {}, campaignCount: 0 };

  it("razões devolvem null quando denominador é 0", () => {
    expect(getMetricDef("cpm")!.compute(empty)).toBeNull();
    expect(getMetricDef("ctr")!.compute(empty)).toBeNull();
    expect(getMetricDef("cpc")!.compute(empty)).toBeNull();
    expect(getMetricDef("cost_per_whatsapp_conversation")!.compute(empty)).toBeNull();
  });

  it("evaluateRule marca computable=false (não avalia, não crasha)", () => {
    const r = evaluateRule({ metric_key: "cpm", comparator: ">", threshold_value: 10 }, empty);
    expect(r.computable).toBe(false);
    expect(r.triggered).toBe(false);
    expect(r.value).toBeNull();
  });
});

describe("evaluateRule", () => {
  const agg = { adAccountId: "act_A", bucket: "FASE 1" as const, spend: 100, impressions: 2000, clicks: 40, actionCounts: {}, campaignCount: 1 };

  it("comparator > dispara quando valor acima do threshold", () => {
    // cpm = 50
    expect(evaluateRule({ metric_key: "cpm", comparator: ">", threshold_value: 40 }, agg).triggered).toBe(true);
    expect(evaluateRule({ metric_key: "cpm", comparator: ">", threshold_value: 60 }, agg).triggered).toBe(false);
  });

  it("comparator < dispara quando valor abaixo do threshold", () => {
    // ctr = 2
    expect(evaluateRule({ metric_key: "ctr", comparator: "<", threshold_value: 3 }, agg).triggered).toBe(true);
    expect(evaluateRule({ metric_key: "ctr", comparator: "<", threshold_value: 1 }, agg).triggered).toBe(false);
  });

  it("agg ausente ou métrica desconhecida => não computável", () => {
    expect(evaluateRule({ metric_key: "cpm", comparator: ">", threshold_value: 1 }, undefined).computable).toBe(false);
    expect(evaluateRule({ metric_key: "inexistente", comparator: ">", threshold_value: 1 }, agg).computable).toBe(false);
  });
});
