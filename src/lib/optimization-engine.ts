import type { ClientKpiConfig } from "./client-kpi-contract";
import { extractPresetBucket, aggregateByAccountBucket, evaluateRule, bucketKey, type InsightRow } from "./meta-insights";

export type Campaign = { id: string; name: string; daily_budget?: string; lifetime_budget?: string };

// Insight cru da Meta pra uma campanha, ou null quando ainda não há veiculação suficiente
// pra avaliar. `error` aparece quando a Meta recusou aquele campaign_id específico.
export type CampaignInsight = Record<string, unknown> & { error?: string };
export type InsightsMap = Record<string, CampaignInsight | null>;

// Margem de erro: violação até 3% acima (ou abaixo, se operator "<") do limite cai em "atenção"
// (amarelo), não "ruim" (vermelho) — 1 real a mais no CPA não é a mesma urgência que 30% acima.
export const YELLOW_ZONE_MARGIN = 0.03;

export type ViolationSeverity = "yellow" | "red";

export type OptimizationViolation = {
  campaignId: string;
  campaignName: string;
  clientName: string;
  adAccountId: string;
  metric: string;
  operator: ">" | "<";
  actual: number;
  limit: number;
  severity: ViolationSeverity;
  // CBO (orçamento na campanha) tem N adsets/criativos competindo pelo mesmo budget — pausar
  // deve mirar o adset ou o criativo específico, não a campanha inteira. ABO (orçamento por
  // adset) idem: só o conjunto ruim deve ser pausado. Ver handleDesligar em OtimizacoesPage.tsx.
  isCbo: boolean;
};

// Mesma regra de PublishForm.tsx: campanha com daily_budget/lifetime_budget = CBO (orçamento no
// nível da campanha); sem nenhum dos dois = ABO (orçamento no nível do adset).
export function isCboCampaign(campaign: Pick<Campaign, "daily_budget" | "lifetime_budget">): boolean {
  return !!(campaign.daily_budget || campaign.lifetime_budget);
}

function computeSeverity(operator: ">" | "<", actual: number, limit: number): ViolationSeverity {
  if (limit === 0) return "red"; // sem base pra calcular desvio percentual — trata como pior caso
  const deviation = operator === ">" ? (actual - limit) / limit : (limit - actual) / limit;
  return deviation <= YELLOW_ZONE_MARGIN ? "yellow" : "red";
}

// Snapshot da métrica no momento em que o gestor agiu (manter/desligar), guardado em
// optimization_actions.metric_snapshot. Tudo opcional: linhas legadas têm `{}` (sem baseline).
// rangeKey = período em que o snapshot foi capturado (ver rangeKey() em meta-insights); ausente
// em linhas legadas → comparação com o valor atual não é confiável e é marcada como não-comparável.
export type MetricSnapshot = {
  metric?: string;
  actual?: number;
  limit?: number;
  operator?: ">" | "<";
  rangeKey?: string;
  // O QUE foi desligado. Ausente/"campaign" = ação na campanha inteira (handleDesligarCampanha /
  // handleManter, e linhas legadas). "adset"/"ad" = pausa de um NÓ específico via drill-in — vira
  // um registro SEPARADO no Histórico ("Conjunto X desligado"), sem marcar a campanha como Desligada.
  nodeLevel?: "campaign" | "adset" | "ad";
  nodeId?: string;
  nodeName?: string;
};

// "Piorou?" desde que o gestor agiu: direção-consciente. Pra operator ">" (limite máximo) pior =
// valor MAIOR; pra "<" (limite mínimo) pior = valor MENOR. Sem baseline (snapshot legado) -> chamador
// trata como não-piorou (não dá pra afirmar). Usado no Histórico pra sinalizar campanha mantida que
// voltou a degradar — aí o gestor pode desligar direto dali.
export function hasWorsened(operator: ">" | "<", current: number, snapshot: number): boolean {
  return operator === ">" ? current > snapshot : current < snapshot;
}

// Ação registrada pelo gestor sobre uma campanha (última por campanha), no shape do engine
// (camelCase). A página mapeia a linha de optimization_actions pra isto.
export type OptimizationActionRecord = {
  campaignId: string;
  campaignName: string | null;
  clientName: string | null;
  action: "dismissed" | "paused";
  snapshot: MetricSnapshot;
  createdAt: string; // ISO — comparável por ordenação de string
};

export type OptimizationHistoryEntry = {
  action: OptimizationActionRecord;
  live: OptimizationViolation | null; // violação ao vivo da mesma campanha, se ainda fora do KPI
  comparable: boolean;                // snapshot capturado no MESMO período da avaliação atual
  worsened: boolean;                  // só true quando comparable && piorou vs o snapshot
};

// Divide as violações ao vivo (`found`) em Pendentes (campanhas NUNCA tratadas) e Histórico (toda
// campanha já mantida/desligada, reavaliada ao vivo). `actions` são TODAS as ações do gestor; a
// função deduplica pra a mais recente por campanha (por createdAt). `currentRangeKey` = período
// atual da tela — "piorou" só é calculado quando o snapshot foi tirado nesse mesmo período.
// Chave de ação por NÍVEL do que foi desligado:
//  - CAMPANHA (nodeLevel "campaign"/ausente): campanha + MÉTRICA. Uma ação trata UMA métrica, não a
//    campanha inteira: estourou CPC e o gestor manteve, um estouro NOVO de CTR depois segue em Pendentes.
//  - NÓ (adset/ad): campanha + NÓ + métrica. Cada conjunto/criativo desligado é um registro SEPARADO
//    no Histórico — pausar 2 conjuntos gera 2 entradas, não sobrescreve.
const actionKey = (campaignId: string, metric?: string) => `${campaignId}::${metric ?? ""}`;
const nodeActionKey = (campaignId: string, nodeId?: string, metric?: string) =>
  `${campaignId}::${nodeId ?? ""}::${metric ?? ""}`;
const isNodeLevel = (a: OptimizationActionRecord) =>
  a.snapshot?.nodeLevel === "adset" || a.snapshot?.nodeLevel === "ad";

export function buildOptimizationView(
  found: OptimizationViolation[],
  actions: OptimizationActionRecord[],
  currentRangeKey: string,
  // IDs das campanhas ATIVAS agora (fetchCampaigns já filtra effective_status=ACTIVE). Uma pausa de
  // CAMPANHA cuja campanha está ativa = desfeita (religada ou reativada por fora) → sai do Histórico.
  activeCampaignIds: Set<string>,
): { pendentes: OptimizationViolation[]; history: OptimizationHistoryEntry[] } {
  // Última ação por chave (campanha-nível ou nó-nível), robusto à ordem de entrada (compara createdAt).
  const latest = new Map<string, OptimizationActionRecord>();
  for (const a of actions) {
    const k = isNodeLevel(a)
      ? nodeActionKey(a.campaignId, a.snapshot?.nodeId, a.snapshot?.metric)
      : actionKey(a.campaignId, a.snapshot?.metric);
    const prev = latest.get(k);
    if (!prev || a.createdAt > prev.createdAt) latest.set(k, a);
  }

  // Exclusão por status live — SÓ registros de CAMPANHA: uma pausa de CAMPANHA cuja campanha está
  // ATIVA agora foi desfeita (Religar ou reativação por fora, no Gerenciador). Sai do Histórico e
  // deixa de suprimir a campanha de Pendentes. Registros de NÓ NÃO passam por aqui (pausar um
  // conjunto não desliga a campanha — fica de log). `dismissed` (Mantida) nunca é excluído.
  for (const [k, a] of latest) {
    if (!isNodeLevel(a) && a.action === "paused" && activeCampaignIds.has(a.campaignId)) latest.delete(k);
  }

  // Pendentes: uma violação (campanha, métrica) sai de Pendentes só se há ação de CAMPANHA sobre ela
  // (dismissed, ou paused não-excluído). Registros de NÓ NÃO suprimem — pausar um conjunto ruim não
  // trata a campanha como um todo; se a campanha segue fora do KPI, continua em Pendentes.
  const campaignActioned = new Set<string>();
  for (const a of latest.values()) {
    if (!isNodeLevel(a)) campaignActioned.add(actionKey(a.campaignId, a.snapshot?.metric));
  }
  const pendentes = found.filter((v) => !campaignActioned.has(actionKey(v.campaignId, v.metric)));

  // Uma campanha pode ter >1 métrica fora ao mesmo tempo — guardamos todas por campanha.
  const liveByCampaign = new Map<string, OptimizationViolation[]>();
  for (const v of found) {
    const arr = liveByCampaign.get(v.campaignId);
    if (arr) arr.push(v);
    else liveByCampaign.set(v.campaignId, [v]);
  }

  const history: OptimizationHistoryEntry[] = [];
  for (const action of latest.values()) {
    // Registro de NÓ = log puro ("você desligou ESTE conjunto/criativo"): sem violação viva, sem
    // "piorou". Só registros de CAMPANHA casam com a violação viva da mesma métrica.
    if (isNodeLevel(action)) {
      history.push({ action, live: null, comparable: false, worsened: false });
      continue;
    }
    const snap = action.snapshot ?? {};
    const lvs = liveByCampaign.get(action.campaignId) ?? [];
    // SÓ a violação da MESMA métrica do snapshot — sem fallback pra outra métrica (comparar CPC
    // com CPM daria "estava em 3 → agora 25" e um "Piorou" falso). Sem match = live null (métrica
    // já dentro do limite / inativa).
    const live = lvs.find((v) => v.metric === snap.metric) ?? null;
    const comparable =
      live != null && typeof snap.actual === "number" && snap.rangeKey != null && snap.rangeKey === currentRangeKey;
    const worsened = comparable ? hasWorsened(live!.operator, live!.actual, snap.actual as number) : false;
    history.push({ action, live, comparable, worsened });
  }
  // Piorou primeiro (mais urgente), depois ainda-fora, depois resolvidas/logs; cada grupo por data desc.
  history.sort((a, b) => {
    const rank = (h: OptimizationHistoryEntry) => (h.worsened ? 0 : h.live ? 1 : 2);
    return rank(a) - rank(b) || b.action.createdAt.localeCompare(a.action.createdAt);
  });

  return { pendentes, history };
}

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
      // Sem isso agg.vv95 fica 0 e a métrica cpv95 (CPV95%, KPI de FASE 2) devolve null sempre —
      // regra jamais dispara. meta-campaign-insights já traz o campo em INSIGHTS_FIELDS.
      video_p95_watched_actions: insight.video_p95_watched_actions as InsightRow["video_p95_watched_actions"],
    };
    const agg = aggregateByAccountBucket([row]).get(bucketKey(config.adAccountId, campaignBucket));

    for (const kpi of config.kpi) {
      if (kpi.presetBucket !== campaignBucket) continue;

      // L.T não tem string fixa (o nome carrega o PRODUTO, que varia por cliente/conta — ver
      // generateLtCampaignName em naming.ts, formato "[PRODUTO] [L.T] ..."). Por isso, além do
      // bucket, exigimos que o nome contenha o produto salvo como TOKEN entre colchetes ([PRODUTO]).
      // Casar por token (e não substring livre) evita que a regra de "DDX" vaze pra campanha
      // "[DDXPRO]" ou pra outro produto na mesma conta. Regra sem filtro salvo (legado, criada
      // antes desse campo existir) cai no comportamento antigo: bucket-only.
      if (
        kpi.presetBucket === "L.T" &&
        kpi.campaignNameFilter &&
        !campaign.name.toLowerCase().includes(`[${kpi.campaignNameFilter.toLowerCase()}]`)
      ) {
        continue;
      }

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
        severity: computeSeverity(kpi.operator, evalResult.value as number, kpi.value),
        isCbo: isCboCampaign(campaign),
      });
    }
  }

  return violations;
}
