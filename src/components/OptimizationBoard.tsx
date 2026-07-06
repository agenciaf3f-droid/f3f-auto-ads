import { useEffect, useState } from "react";
import { Gauge, Loader2, AlertTriangle, CheckCircle2, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fetchMetaStatus, fetchCampaigns, fetchCampaignInsights, fetchNodeInsights, pauseCampaign, type MetaNodeInsight } from "@/lib/meta-api";
import { fetchClientKpiConfigs } from "@/lib/client-kpi-contract";
import {
  compareKpis,
  buildOptimizationView,
  type MetricSnapshot,
  type OptimizationViolation,
  type OptimizationActionRecord,
  type OptimizationHistoryEntry,
} from "@/lib/optimization-engine";
import { getMetricDef, rangeKey, type AggregatedBucket, type DateRangeSelection, type MetricDef } from "@/lib/meta-insights";
import DateRangeSelector from "@/components/clients/DateRangeSelector";

type NodeLevel = "adset" | "ad";
type ActionKind = "dismissed" | "paused";

// Linha crua de optimization_actions (snake_case, como vem do supabase). Mapeada pra
// OptimizationActionRecord antes de entrar no engine. campaign_name/client_name ficam gravados na
// ação pra o histórico exibir campanhas que já saíram da avaliação ao vivo (sararam/pausadas).
type ActionRow = {
  campaign_id: string;
  campaign_name: string | null;
  client_name: string | null;
  action: ActionKind;
  metric_snapshot: MetricSnapshot;
  created_at: string;
};

const actionVerb = (a: ActionKind) => (a === "dismissed" ? "Mantida" : "Desligada");
const fmtActionDate = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Reaproveita a MESMA fórmula de cada métrica (METRIC_REGISTRY) montando um AggregatedBucket
// sintético de 1 nó só (adset ou ad) — não reinventa cálculo de CTR/CPM/CCP/CPV95%/etc.
function computeNodeMetricValue(violation: OptimizationViolation, node: MetaNodeInsight): number | null {
  const def = getMetricDef(violation.metric);
  if (!def) return null;
  const agg: AggregatedBucket = {
    adAccountId: violation.adAccountId,
    bucket: "Outros",
    spend: node.spend,
    impressions: node.impressions,
    clicks: node.clicks,
    vv95: node.vv95,
    actionCounts: node.actionCounts,
    campaignCount: 1,
  };
  return def.compute(agg);
}

function formatMetricValue(value: number | null, unit?: MetricDef["unit"]): string {
  if (value === null || value === undefined) return "sem dados suficientes";
  const formatted = value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (unit === "currency") return `R$ ${formatted}`;
  if (unit === "percent") return `${formatted}%`;
  return formatted;
}

// Cap de concorrência do fan-out por conta ao carregar otimizações. Antes era serial (1 conta por vez).
// Baixo de propósito: cada conta ainda dispara N fetches paralelos na edge, no mesmo token compartilhado.
const ACCOUNTS_CONCURRENCY = 5;

// Pool de workers: roda `fn` sobre `items` com no máx `limit` execuções simultâneas.
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

// Mesma engrenagem (load + avaliação ao vivo + dialog de Desligar) serve as duas telas; `variant`
// só decide qual fatia renderizar: "pendentes" (Otimizações) ou "historico" (aba Histórico).
export type BoardVariant = "pendentes" | "historico";

export default function OptimizationBoard({ variant }: { variant: BoardVariant }) {
  const isHistorico = variant === "historico";
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [violations, setViolations] = useState<OptimizationViolation[]>([]);
  const [history, setHistory] = useState<OptimizationHistoryEntry[]>([]);
  const [accountErrors, setAccountErrors] = useState<string[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [confirmCampaign, setConfirmCampaign] = useState<OptimizationViolation | null>(null);
  const [range, setRange] = useState<DateRangeSelection>({ mode: "preset", preset: "last_7d" });

  // Estado do dialog de "Desligar": qual granularidade foi decidida (adset pra ABO/CBO com
  // >1 conjunto, ad pra CBO com exatamente 1 conjunto), os nós carregados e a seleção do gestor.
  const [nodeLevel, setNodeLevel] = useState<NodeLevel>("adset");
  const [nodes, setNodes] = useState<MetaNodeInsight[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [nodesLoading, setNodesLoading] = useState(false);
  const [confirmingPause, setConfirmingPause] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const status = await fetchMetaStatus();
        if (!status.connected || !status.access_token) {
          if (!cancelled) { setViolations([]); setHistory([]); }
          return;
        }
        if (!cancelled) setAccessToken(status.access_token);

        const configs = await fetchClientKpiConfigs();
        if (configs.length === 0) {
          if (!cancelled) { setViolations([]); setHistory([]); }
          return;
        }

        const { data: { user } } = await supabase.auth.getUser();
        const { data: actioned } = await supabase
          .from("optimization_actions")
          .select("campaign_id, campaign_name, client_name, action, metric_snapshot, created_at")
          .eq("user_id", user?.id ?? "")
          .order("created_at", { ascending: false })
          .limit(200); // teto do Histórico: as 200 ações mais recentes (evita render sem limite ao longo dos meses)
        // Ações do gestor no shape do engine. NÃO escondem mais a campanha pra sempre: campanha já
        // tratada vai pro Histórico, reavaliada ao vivo — se piorar, o gestor desliga direto de lá.
        const actionRecords: OptimizationActionRecord[] = ((actioned ?? []) as ActionRow[]).map((r) => ({
          campaignId: r.campaign_id,
          campaignName: r.campaign_name,
          clientName: r.client_name,
          action: r.action,
          snapshot: (r.metric_snapshot ?? {}) as MetricSnapshot,
          createdAt: r.created_at,
        }));

        // Contas avaliadas em paralelo com teto de concorrência (antes: uma de cada vez). O try/catch
        // é isolado por conta — uma conta que falha vai pra failedAccounts sem derrubar as outras.
        // Ordem final de `found`/`failedAccounts` não é garantida (lista sem ordenação, como antes).
        const found: OptimizationViolation[] = [];
        const failedAccounts: string[] = [];
        await mapWithConcurrency(configs, ACCOUNTS_CONCURRENCY, async (config) => {
          try {
            const campaigns = await fetchCampaigns(status.access_token, config.adAccountId);
            if (campaigns.length === 0) return;

            const insights = await fetchCampaignInsights(status.access_token, campaigns.map((c: { id: string }) => c.id), range);

            // Uma campanha isolada pode falhar (rate-limit transiente) sem que a chamada inteira
            // lance erro — a edge function retorna 200 com só aquela campanha marcada com `error`.
            // Se TODAS as campanhas da conta vieram com erro, trata como falha de avaliação, não
            // como "tudo dentro do limite" (null = sem veiculação ainda, isso é normal e não conta).
            const allErrored = campaigns.every((c: { id: string }) => {
              const insight = insights[c.id];
              return insight && insight.error;
            });
            if (allErrored) {
              console.error(`Falha ao avaliar otimizações da conta ${config.adAccountId} (${config.clientName}): todas as campanhas retornaram erro`);
              failedAccounts.push(config.clientName);
              return;
            }

            found.push(...compareKpis(campaigns, insights, config));
          } catch (e) {
            console.error(`Falha ao avaliar otimizações da conta ${config.adAccountId} (${config.clientName})`, e);
            failedAccounts.push(config.clientName);
          }
        });

        // Pendentes (nunca tratadas) vs Histórico (já mantidas/desligadas, reavaliadas ao vivo).
        // "piorou" só é calculado quando o snapshot foi tirado no MESMO período da tela atual.
        const { pendentes, history: historyEntries } = buildOptimizationView(found, actionRecords, rangeKey(range));

        if (!cancelled) {
          setViolations(pendentes);
          setHistory(historyEntries);
          setAccountErrors(failedAccounts);
        }
      } catch (e) {
        if (!cancelled) {
          toast({ variant: "destructive", title: "Erro ao carregar otimizações", description: (e as Error).message });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [toast, range]);

  // Ao abrir o dialog de "Desligar" (confirmCampaign setado pelo card), busca a estrutura real
  // da campanha e decide a granularidade: ABO ou CBO com >1 adset -> pausa por CONJUNTO; CBO
  // com exatamente 1 adset -> pausa por CRIATIVO (ads daquele conjunto único competindo pelo
  // mesmo budget). Fechar o dialog (confirmCampaign = null) limpa tudo.
  useEffect(() => {
    if (!confirmCampaign || !accessToken) {
      setNodes([]);
      setSelectedNodeIds(new Set());
      return;
    }

    let cancelled = false;
    async function loadNodes() {
      setNodesLoading(true);
      setNodeLevel("adset");
      setNodes([]);
      setSelectedNodeIds(new Set());
      try {
        const adsetNodes = await fetchNodeInsights(accessToken!, confirmCampaign!.campaignId, "adset", range);
        let level: NodeLevel = "adset";
        let result = adsetNodes;
        if (confirmCampaign!.isCbo && adsetNodes.length === 1) {
          level = "ad";
          result = await fetchNodeInsights(accessToken!, confirmCampaign!.campaignId, "ad", range);
        }
        if (!cancelled) {
          setNodeLevel(level);
          setNodes(result);
        }
      } catch (e) {
        // Falha ao buscar a estrutura real (conjuntos/criativos) — sem isso não dá pra decidir o
        // que pausar com segurança. Avisa e fecha o dialog em vez de deixar uma lista vazia/quebrada.
        if (!cancelled) {
          toast({ variant: "destructive", title: "Erro ao carregar estrutura da campanha", description: (e as Error).message });
          setConfirmCampaign(null);
        }
      } finally {
        if (!cancelled) setNodesLoading(false);
      }
    }

    loadNodes();
    return () => { cancelled = true; };
  }, [confirmCampaign, accessToken, range, toast]);

  function toggleNode(nodeId: string) {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  async function recordAction(violation: OptimizationViolation, action: ActionKind) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // rangeKey grava o período em que o snapshot foi tirado — o "piorou" no Histórico só compara
    // valores do mesmo período (7d vs 30d seria maçã com laranja).
    const snapshot: MetricSnapshot = {
      metric: violation.metric, actual: violation.actual, limit: violation.limit, operator: violation.operator,
      rangeKey: rangeKey(range),
    };
    // supabase-js insert NÃO lança em erro de DB/PostgREST — devolve { error }. Se não checar,
    // uma falha (RLS, rede, coluna ausente) passa despercebida e o UI otimista mente "salvo".
    const { error } = await supabase.from("optimization_actions").insert({
      user_id: user.id,
      campaign_id: violation.campaignId,
      ad_account_id: violation.adAccountId,
      campaign_name: violation.campaignName,
      client_name: violation.clientName,
      action,
      metric_snapshot: snapshot,
    });
    if (error) throw new Error(error.message);
    // Sai de Pendentes e entra/atualiza no Histórico. Chave por (campanha, MÉTRICA): manter/desligar
    // trata só a métrica agida — outra métrica fora do KPI segue em Pendentes. Re-baselina contra o
    // valor atual → worsened=false; se piorar depois, o próximo load marca "piorou".
    const sameCell = (campaignId: string, metric: string) =>
      campaignId === violation.campaignId && metric === violation.metric;
    setViolations((prev) => prev.filter((v) => !sameCell(v.campaignId, v.metric)));
    const entry: OptimizationHistoryEntry = {
      action: {
        campaignId: violation.campaignId,
        campaignName: violation.campaignName,
        clientName: violation.clientName,
        action,
        snapshot,
        createdAt: new Date().toISOString(),
      },
      live: violation,
      comparable: true,
      worsened: false,
    };
    setHistory((prev) => [entry, ...prev.filter((h) => !sameCell(h.action.campaignId, h.action.snapshot.metric ?? ""))]);
  }

  async function handleManter(violation: OptimizationViolation) {
    try {
      await recordAction(violation, "dismissed");
    } catch (e) {
      toast({ variant: "destructive", title: "Erro ao manter", description: (e as Error).message });
      return;
    }
    toast({ title: "Campanha mantida", description: violation.campaignName });
  }

  // Pausa só os nós SELECIONADOS (conjuntos ou criativos, conforme nodeLevel) — nunca a campanha
  // inteira. pauseCampaign aceita qualquer node id (Graph API: POST /{id}?status=PAUSED é
  // idêntico pra campaign/adset/ad), então serve sem alteração pra esse fluxo.
  async function handleDesligar() {
    if (!accessToken || !confirmCampaign || selectedNodeIds.size === 0) return;
    const violation = confirmCampaign;
    const idsToPause = Array.from(selectedNodeIds);
    setPausingId(violation.campaignId);
    setConfirmingPause(true);
    // allSettled (não Promise.all): se pausar 3 e o 2º falhar (rate-limit transiente), os que já
    // pausaram de verdade na Meta NÃO podem virar "nada aconteceu". Conta sucessos/falhas.
    const results = await Promise.allSettled(idsToPause.map((id) => pauseCampaign(accessToken, id)));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const succeeded = idsToPause.length - failures.length;

    if (succeeded === 0) {
      toast({ variant: "destructive", title: "Erro ao pausar", description: (failures[0]?.reason as Error)?.message ?? "Falha desconhecida" });
      setPausingId(null);
      setConfirmingPause(false);
      return;
    }

    // Pelo menos 1 nó foi pausado de verdade na Meta — o resto é bookkeeping local. Uma falha
    // parcial avisa quais faltaram (reabrir em Desligar mostra os que continuam ATIVOS pra tentar de novo).
    const label = nodeLevel === "adset" ? "Conjunto(s)" : "Criativo(s)";
    toast(
      failures.length > 0
        ? {
            variant: "destructive",
            title: "Pausa parcial",
            description: `${violation.campaignName} — ${succeeded} pausado(s), ${failures.length} falhou(aram). Reabra em Desligar pra tentar os restantes.`,
          }
        : { title: `${label} pausado(s)`, description: violation.campaignName },
    );
    setPausingId(null);
    setConfirmingPause(false);
    setConfirmCampaign(null);

    try {
      await recordAction(violation, "paused");
    } catch (e) {
      console.error("Falha ao registrar pausa em optimization_actions (nós já pausados na Meta)", e);
    }
  }

  // Card de violação, reusado por Pendentes e Histórico. `meta` presente = card do Histórico:
  // acrescenta a linha "Mantida/Desligada em <data> · estava em X → agora Y" + badge "Piorou".
  const renderViolationCard = (
    v: OptimizationViolation,
    i: number,
    meta?: { action: OptimizationActionRecord; comparable: boolean; worsened: boolean },
  ) => {
    const isYellow = v.severity === "yellow";
    const emphasizeRed = meta?.worsened || !isYellow; // piorou sempre em vermelho, independente da severidade
    const snapActual = meta?.action.snapshot?.actual;
    return (
      <Card
        key={`${v.campaignId}:${v.metric}`}
        className={`border-l-[3px] fade-in-up ${
          emphasizeRed ? "border-l-destructive/70 bg-destructive/[0.015]" : "border-l-warning/70 bg-warning/[0.03]"
        }`}
        style={{ animationDelay: `${i * 60}ms` }}
      >
        <CardHeader className="p-4 pb-2">
          <div className="flex items-center gap-2.5">
            <div
              className={`w-7 h-7 rounded-md border flex items-center justify-center shrink-0 ${
                emphasizeRed ? "bg-destructive/10 border-destructive/20" : "bg-warning/10 border-warning/20"
              }`}
            >
              <AlertTriangle className={`w-3.5 h-3.5 ${emphasizeRed ? "text-destructive" : "text-warning"}`} />
            </div>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-sm truncate">{v.campaignName}</CardTitle>
              <p className="text-xs text-muted-foreground truncate">{v.clientName}</p>
            </div>
            {meta && (
              <span
                className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${
                  meta.worsened ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground"
                }`}
              >
                {meta.worsened ? "Piorou" : actionVerb(meta.action.action)}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {meta && (
            <p className="text-[11px] text-muted-foreground mb-2">
              {actionVerb(meta.action.action)} em {fmtActionDate(meta.action.createdAt)}
              {meta.comparable && typeof snapActual === "number" && (
                <> · estava em <strong className="text-foreground">{snapActual.toFixed(2)}</strong> → agora{" "}
                  <strong className="text-foreground">{v.actual.toFixed(2)}</strong></>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground mb-3">
            <strong className="text-foreground">{getMetricDef(v.metric)?.label ?? v.metric}</strong> em{" "}
            <strong className="text-foreground">{v.actual.toFixed(2)}</strong>,{" "}
            {v.operator === ">" ? "acima" : "abaixo"} do limite de{" "}
            <strong className="text-foreground">{v.limit}</strong>
            {meta?.worsened
              ? " — piorou desde que você tratou."
              : isYellow
                ? " — em atenção, dentro de uma margem pequena."
                : " — performando fora do esperado."}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => handleManter(v)}>
              {meta ? "Manter mais" : "Manter"}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pausingId === v.campaignId}
              onClick={() => setConfirmCampaign(v)}
            >
              {pausingId === v.campaignId ? "Desligando..." : "Desligar"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <div className="mb-8 fade-in-up">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/20 flex items-center justify-center">
            {isHistorico ? <History className="w-3.5 h-3.5 text-accent" /> : <Gauge className="w-3.5 h-3.5 text-accent" />}
          </div>
          <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            {isHistorico ? "Histórico" : "Otimizações"}
          </span>
        </div>
        <h1 className="font-display text-2xl font-bold tracking-tight mb-1.5">
          {isHistorico
            ? <>Campanhas já <span className="text-gradient">tratadas</span></>
            : <>Campanhas fora do <span className="text-gradient">limite</span></>}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isHistorico
            ? "Campanhas que você já manteve ou desligou. Continuam sendo reavaliadas — se uma voltar a piorar, aparece marcada e você pode desligar aqui mesmo."
            : "Campanhas que estouraram um limite de KPI configurado na aba Clientes aparecem aqui."}
        </p>
      </div>

      <div className="mb-6 fade-in-up">
        <DateRangeSelector value={range} onChange={setRange} />
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando...
        </div>
      )}

      {!loading && accountErrors.length > 0 && (
        <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/[0.04] px-4 py-3 text-sm text-destructive fade-in-up">
          Não foi possível avaliar {accountErrors.length === 1 ? "o cliente" : "os clientes"}:{" "}
          <strong>{accountErrors.join(", ")}</strong>. Tente novamente mais tarde.
        </div>
      )}

      {/* ── PENDENTES (aba Otimizações) ── */}
      {!isHistorico && !loading && (
        <>
          {violations.length === 0 && accountErrors.length === 0 && (
            <div className="text-center py-16 fade-in-up">
              <div className="w-12 h-12 rounded-xl bg-success/10 border border-success/20 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-6 h-6 text-success" />
              </div>
              <p className="text-sm font-medium mb-1">Tudo dentro do limite</p>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Nenhuma otimização pendente. Isso acontece quando não há campanhas fora do limite, ou quando
                nenhum limite de KPI foi configurado ainda na aba Clientes.
              </p>
            </div>
          )}
          <div className="space-y-2">
            {violations.map((v, i) => renderViolationCard(v, i))}
          </div>
        </>
      )}

      {/* ── HISTÓRICO (aba própria) ── */}
      {isHistorico && !loading && (
        <>
          {history.length === 0 && accountErrors.length === 0 && (
            <div className="text-center py-16 fade-in-up">
              <div className="w-12 h-12 rounded-xl bg-muted border border-border flex items-center justify-center mx-auto mb-4">
                <History className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium mb-1">Nenhuma campanha tratada ainda</p>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Quando você mantiver ou desligar uma campanha na aba Otimizações, ela aparece aqui —
                reavaliada ao vivo, pra você agir de novo se piorar.
              </p>
            </div>
          )}
          <div className="space-y-2">
            {history.map((h, i) =>
              h.live ? (
                renderViolationCard(h.live, i, { action: h.action, comparable: h.comparable, worsened: h.worsened })
              ) : (
                <Card
                  key={h.action.campaignId}
                  className="border-l-[3px] border-l-muted-foreground/25 fade-in-up opacity-80"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <CardContent className="p-4">
                    <p className="text-sm truncate">{h.action.campaignName ?? h.action.campaignId}</p>
                    {h.action.clientName && (
                      <p className="text-xs text-muted-foreground truncate">{h.action.clientName}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-1.5">
                      {actionVerb(h.action.action)} em {fmtActionDate(h.action.createdAt)} · dentro do limite ou inativa agora
                    </p>
                  </CardContent>
                </Card>
              )
            )}
          </div>
        </>
      )}

      <Dialog open={!!confirmCampaign} onOpenChange={(open) => !open && setConfirmCampaign(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Pausar {nodeLevel === "adset" ? "conjunto(s)" : "criativo(s)"}
            </DialogTitle>
            <DialogDescription>
              "{confirmCampaign?.campaignName}" continua ativa — só o que você marcar abaixo é pausado de
              verdade na Meta.{" "}
              {confirmCampaign?.isCbo
                ? "CBO com mais de um conjunto pausa por conjunto; com um conjunto só, pausa por criativo."
                : "ABO pausa por conjunto."}
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0">
            {nodesLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="w-4 h-4 animate-spin" />
                Carregando {nodeLevel === "adset" ? "conjuntos" : "criativos"}...
              </div>
            )}

            {!nodesLoading && nodes.length === 0 && (
              <p className="text-sm text-muted-foreground py-2">
                Nenhum {nodeLevel === "adset" ? "conjunto" : "criativo"} encontrado nessa campanha.
              </p>
            )}

            {!nodesLoading && nodes.length > 0 && (
              <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
                {nodes.map((node) => {
                  const isPaused = node.effective_status === "PAUSED";
                  const def = confirmCampaign ? getMetricDef(confirmCampaign.metric) : undefined;
                  const value = confirmCampaign ? computeNodeMetricValue(confirmCampaign, node) : null;
                  return (
                    <label
                      key={node.id}
                      className={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm ${
                        isPaused ? "opacity-50" : "cursor-pointer hover:bg-muted/50"
                      }`}
                    >
                      <Checkbox
                        checked={selectedNodeIds.has(node.id)}
                        disabled={isPaused}
                        onCheckedChange={() => toggleNode(node.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{node.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {isPaused ? "Já pausado" : node.effective_status} ·{" "}
                          {def?.label ?? confirmCampaign?.metric}: {formatMetricValue(value, def?.unit)}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCampaign(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={selectedNodeIds.size === 0 || confirmingPause || nodesLoading}
              onClick={handleDesligar}
            >
              {confirmingPause
                ? "Pausando..."
                : `Pausar ${selectedNodeIds.size > 0 ? selectedNodeIds.size : ""} selecionado(s)`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
