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

  it("label descritivo (preset.label, não preset.fase) normaliza pro bucket certo", () => {
    // Campanhas reais nomeadas com o label completo do preset (ex.: publicadas antes do
    // campo `.fase` existir) não podem cair em Outros — mesmo bug do L.T, agora pra FASE 1/3.
    expect(extractPresetBucket("[FASE 1 - TRÁFEGO] [GERENCIADOR] [2026-07-01] [pub] [R$50]")).toBe("FASE 1");
    expect(extractPresetBucket("[FASE 3 - LEADS | ZAP] [GERENCIADOR] [2026-07-01] [pub] [R$50]")).toBe("FASE 3");
    expect(extractPresetBucket("[FASE 3 - VENDAS | ZAP] [GERENCIADOR] [2026-07-01] [pub] [R$50]")).toBe("FASE 3");
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

  it("soma vv95 (video_p95_watched_actions), campo separado de actions", () => {
    const agg = aggregateByAccountBucket([
      { ad_account_id: "act_A", campaign_name: "[FASE 2] [G] [d] [p] [R$]", spend: "10", video_p95_watched_actions: [{ action_type: "video_view", value: "7" }] },
      { ad_account_id: "act_A", campaign_name: "[FASE 2] [G] [d] [p] [R$]", spend: "10", video_p95_watched_actions: [{ action_type: "video_view", value: "3" }] },
    ]);
    expect(agg.get(bucketKey("act_A", "FASE 2"))!.vv95).toBe(10);
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

describe("CCP e CPV95% (FASE 2)", () => {
  it("ccp = spend / (clicks - link_click)", () => {
    const agg = aggregateByAccountBucket([
      { ad_account_id: "act_A", campaign_name: "[FASE 2] [G]", spend: "1012.40", clicks: "1236", actions: [{ action_type: "link_click", value: "61" }] },
    ]).get(bucketKey("act_A", "FASE 2"))!;
    expect(getMetricDef("ccp")!.compute(agg)).toBeCloseTo(1012.40 / 1175);
  });

  it("ccp null quando cliques não-link é 0 (evita divisão por zero)", () => {
    const agg = aggregateByAccountBucket([
      { ad_account_id: "act_A", campaign_name: "[FASE 2] [G]", spend: "10", clicks: "5", actions: [{ action_type: "link_click", value: "5" }] },
    ]).get(bucketKey("act_A", "FASE 2"))!;
    expect(getMetricDef("ccp")!.compute(agg)).toBeNull();
  });

  it("cpv95 = spend / vv95", () => {
    const agg = aggregateByAccountBucket([
      { ad_account_id: "act_A", campaign_name: "[FASE 2] [G]", spend: "1012.40", video_p95_watched_actions: [{ action_type: "video_view", value: "5872" }] },
    ]).get(bucketKey("act_A", "FASE 2"))!;
    expect(getMetricDef("cpv95")!.compute(agg)).toBeCloseTo(1012.40 / 5872);
  });

  it("cpv95 null quando vv95 é 0", () => {
    const agg = aggregateByAccountBucket([
      { ad_account_id: "act_A", campaign_name: "[FASE 2] [G]", spend: "10" },
    ]).get(bucketKey("act_A", "FASE 2"))!;
    expect(getMetricDef("cpv95")!.compute(agg)).toBeNull();
  });
});

describe("bucket vazio / divisão por zero (sem crash)", () => {
  const empty = { adAccountId: "act_A", bucket: "FASE 1" as const, spend: 0, impressions: 0, clicks: 0, vv95: 0, actionCounts: {}, campaignCount: 0 };

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
  const agg = { adAccountId: "act_A", bucket: "FASE 1" as const, spend: 100, impressions: 2000, clicks: 40, vv95: 0, actionCounts: {}, campaignCount: 1 };

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
