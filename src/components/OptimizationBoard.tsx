import { useEffect, useState } from "react";
import { Gauge, Loader2, AlertTriangle, CheckCircle2, History, ChevronRight, ChevronLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchMetaStatus,
  fetchCampaigns,
  fetchCampaignInsights,
  fetchNodeInsights,
  pauseCampaign,
  notifyClientPause,
  type MetaNodeInsight,
  type NotifyClientPauseParams,
} from "@/lib/meta-api";
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

type ActionKind = "dismissed" | "paused";

// Navegação drill-in: null = lista de campanhas; { campaign } = dentro da campanha vendo
// conjuntos; { campaign, adset } = dentro do conjunto vendo criativos (folha, não desce mais).
type Drill = null | { campaign: OptimizationViolation } | { campaign: OptimizationViolation; adset: MetaNodeInsight };

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

// Mesma engrenagem (load + avaliação ao vivo + drill-in de conjuntos/criativos) serve as duas telas;
// `variant` só decide qual fatia renderizar: "pendentes" (Otimizações) ou "historico" (aba Histórico).
export type BoardVariant = "pendentes" | "historico";

export default function OptimizationBoard({ variant }: { variant: BoardVariant }) {
  const isHistorico = variant === "historico";
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [violations, setViolations] = useState<OptimizationViolation[]>([]);
  const [history, setHistory] = useState<OptimizationHistoryEntry[]>([]);
  const [accountErrors, setAccountErrors] = useState<string[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  // Id do nó (adset ou ad) sendo pausado agora — desabilita só o botão daquele nó.
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [range, setRange] = useState<DateRangeSelection>({ mode: "preset", preset: "last_7d" });

  // Preview do aviso ao grupo de WhatsApp do cliente, aberto logo após uma pausa bem-sucedida.
  // `params` já vem com dry_run:false pronto pro clique em "Enviar aviso".
  const [notifyPreview, setNotifyPreview] = useState<{ text: string; groupId: string; clientName: string | null; params: NotifyClientPauseParams } | null>(null);
  const [sendingNotify, setSendingNotify] = useState(false);

  // Drill-in: null = cards de campanha; { campaign } = conjuntos da campanha; { campaign, adset } =
  // criativos do conjunto. Sem rota nova — navegação é só estado local do board.
  const [drill, setDrill] = useState<Drill>(null);
  const [drillNodes, setDrillNodes] = useState<MetaNodeInsight[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);

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

  // Carrega os nós do nível em que o drill está agora. Nível 1 (drill = { campaign }): conjuntos
  // da campanha. Nível 2 (drill = { campaign, adset }): criativos de TODA a campanha, filtrados
  // pelo adsetId do conjunto clicado (a edge não tem endpoint pra "criativos de um conjunto só").
  useEffect(() => {
    if (!drill || !accessToken) {
      setDrillNodes([]);
      return;
    }

    const d = drill;
    const token = accessToken;
    let cancelled = false;
    async function loadDrillNodes() {
      setDrillLoading(true);
      setDrillNodes([]);
      try {
        let result: MetaNodeInsight[];
        if ("adset" in d) {
          const ads = await fetchNodeInsights(token, d.campaign.campaignId, "ad", range);
          result = ads.filter((n) => n.adsetId === d.adset.id);
        } else {
          result = await fetchNodeInsights(token, d.campaign.campaignId, "adset", range);
        }
        if (!cancelled) setDrillNodes(result);
      } catch (e) {
        // Falha ao buscar a estrutura real (conjuntos/criativos) — avisa e sobe um nível em vez
        // de deixar uma lista vazia/quebrada.
        if (!cancelled) {
          toast({ variant: "destructive", title: "Erro ao carregar estrutura da campanha", description: (e as Error).message });
          setDrill("adset" in d ? { campaign: d.campaign } : null);
        }
      } finally {
        if (!cancelled) setDrillLoading(false);
      }
    }

    loadDrillNodes();
    return () => { cancelled = true; };
  }, [drill, accessToken, range, toast]);

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

  // Pausa só o NÓ clicado (conjunto ou criativo) — nunca a campanha inteira. pauseCampaign aceita
  // qualquer node id (Graph API: POST /{id}?status=PAUSED é idêntico pra campaign/adset/ad).
  async function pausarNo(node: MetaNodeInsight) {
    if (!accessToken || !drill) return;
    setPausingId(node.id);
    try {
      await pauseCampaign(accessToken, node.id);
    } catch (e) {
      toast({ variant: "destructive", title: "Erro ao pausar", description: (e as Error).message });
      setPausingId(null);
      return;
    }
    // Nó pausado de verdade na Meta — marca localmente (botão vira "Pausado" disabled).
    setDrillNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, effective_status: "PAUSED" } : n)));
    toast({ title: "Pausado", description: node.name });
    // Sai de Pendentes / entra no Histórico. Se falhar (rede/RLS), o nó já pausado na Meta não
    // vira "nada aconteceu" — só o bookkeeping local fica pra trás, sem travar a UI.
    try {
      await recordAction(drill.campaign, "paused");
    } catch (e) {
      console.error("Falha ao registrar pausa em optimization_actions (nó já pausado na Meta)", e);
    }
    setPausingId(null);

    // Best-effort: prepara o aviso pro grupo de WhatsApp do cliente. A pausa já está feita acima —
    // qualquer falha aqui (sem grupo, rede, edge fora) NUNCA desfaz/bloqueia o que já aconteceu.
    try {
      const level: "adset" | "ad" = "adset" in drill ? "ad" : "adset";
      const previewParams: NotifyClientPauseParams = {
        access_token: accessToken,
        ad_account_id: drill.campaign.adAccountId,
        level,
        node_id: node.id,
        adset_id: "adset" in drill ? drill.adset.id : undefined,
        node_name: node.name,
        metric_label: getMetricDef(drill.campaign.metric)?.label ?? drill.campaign.metric,
        dry_run: true,
      };
      const result = await notifyClientPause(previewParams);
      // `=== true`/`=== false`, não truthy: com `strict:false` (tsconfig.app.json) o TS não estreita
      // essa união discriminada por booleano em `if (result.ok)` — vira erro de tsc no `else`.
      if (result.ok === true && "text" in result) {
        setNotifyPreview({ text: result.text, groupId: result.group_id, clientName: result.client_name, params: { ...previewParams, dry_run: false } });
      } else if (result.ok === false) {
        toast({ title: "Cliente sem grupo de WhatsApp — não avisado." });
      }
    } catch (e) {
      console.error("Falha ao preparar aviso ao cliente no WhatsApp (pausa já concluída)", e);
    }
  }

  // Envio real do aviso (dry_run:false) a partir do preview aberto. Best-effort: falha aqui é só
  // toast — a pausa já aconteceu antes desse dialog existir.
  async function handleEnviarAviso() {
    if (!notifyPreview) return;
    setSendingNotify(true);
    try {
      const result = await notifyClientPause(notifyPreview.params);
      // `=== true` (não truthy) pelo mesmo motivo do preview acima — ver comentário em pausarNo.
      if (result.ok === true) {
        toast({ title: "Cliente avisado no grupo" });
      } else {
        toast({ variant: "destructive", title: "Erro ao avisar cliente", description: result.reason });
      }
    } catch (e) {
      toast({ variant: "destructive", title: "Erro ao avisar cliente", description: (e as Error).message });
    } finally {
      setSendingNotify(false);
      setNotifyPreview(null);
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
    const enterDrill = () => setDrill({ campaign: v });
    return (
      <Card
        key={`${v.campaignId}:${v.metric}`}
        className={`border-l-[3px] fade-in-up ${
          emphasizeRed ? "border-l-destructive/70 bg-destructive/[0.015]" : "border-l-warning/70 bg-warning/[0.03]"
        }`}
        style={{ animationDelay: `${i * 60}ms` }}
      >
        {/* Corpo clicável — entra no drill-in (conjuntos da campanha). "Manter" fica fora, no
            rodapé do card, pra não disparar a navegação. */}
        <div
          role="button"
          tabIndex={0}
          onClick={enterDrill}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              enterDrill();
            }
          }}
          className="cursor-pointer rounded-t-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0 pb-3">
            {meta && (
              <p className="text-[11px] text-muted-foreground mb-2">
                {actionVerb(meta.action.action)} em {fmtActionDate(meta.action.createdAt)}
                {meta.comparable && typeof snapActual === "number" && (
                  <> · estava em <strong className="text-foreground">{snapActual.toFixed(2)}</strong> → agora{" "}
                    <strong className="text-foreground">{v.actual.toFixed(2)}</strong></>
                )}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
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
          </CardContent>
        </div>
        <CardContent className="p-4 pt-0">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => handleManter(v)}>
              {meta ? "Manter mais" : "Manter"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  // Linha de um nó (conjunto ou criativo) no drill-in. `canEnter` só é true no Nível 1 (conjunto),
  // que desce pra criativos — Nível 2 é folha, sem chevron nem clique de navegação na linha.
  const renderNodeRow = (node: MetaNodeInsight, campaign: OptimizationViolation, canEnter: boolean) => {
    const isPaused = node.effective_status === "PAUSED";
    const def = getMetricDef(campaign.metric);
    const value = computeNodeMetricValue(campaign, node);
    // Cor pela violação DO PRÓPRIO nó (não a da campanha): vermelho se ESTE conjunto/criativo estoura
    // o limite, verde se está dentro. É o que faz o culpado saltar no meio dos saudáveis.
    const breaches = value != null && (campaign.operator === ">" ? value > campaign.limit : value < campaign.limit);
    const enter = () => setDrill({ campaign, adset: node });
    return (
      <Card key={node.id} className="fade-in-up">
        <CardContent className="p-3 flex items-center gap-3">
          <div
            className={`min-w-0 flex-1 ${canEnter ? "cursor-pointer" : ""}`}
            role={canEnter ? "button" : undefined}
            tabIndex={canEnter ? 0 : undefined}
            onClick={canEnter ? enter : undefined}
            onKeyDown={
              canEnter
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      enter();
                    }
                  }
                : undefined
            }
          >
            <p className="text-sm truncate font-medium">{node.name}</p>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <Badge
                variant={isPaused ? "outline" : "secondary"}
                className={`text-[10px] px-1.5 py-0 font-normal ${isPaused ? "text-muted-foreground" : ""}`}
              >
                {isPaused ? "Pausado" : node.effective_status}
              </Badge>
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 font-normal ${
                  value == null
                    ? "border-border text-muted-foreground"
                    : breaches
                      ? "border-destructive/30 text-destructive"
                      : "border-success/30 text-success"
                }`}
              >
                {def?.label ?? campaign.metric}: {formatMetricValue(value, def?.unit)}
              </Badge>
              {value != null && (
                <span className="text-[10px] text-muted-foreground">
                  limite {campaign.operator === ">" ? "≤" : "≥"} {formatMetricValue(campaign.limit, def?.unit)}
                </span>
              )}
            </div>
          </div>
          <Button
            variant={isPaused ? "outline" : "destructive"}
            size="sm"
            disabled={isPaused || pausingId === node.id}
            onClick={(e) => {
              e.stopPropagation();
              pausarNo(node);
            }}
          >
            {isPaused ? "Pausado" : pausingId === node.id ? "Pausando..." : "Pausar"}
          </Button>
          {canEnter && <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 cursor-pointer" onClick={enter} />}
        </CardContent>
      </Card>
    );
  };

  // View do drill-in — Nível 1 (conjuntos) ou Nível 2 (criativos), decidido por "adset" in drill.
  // `key` no wrapper reinicia a animação fade-in-up a cada transição de nível/campanha.
  const renderDrillView = () => {
    if (!drill) return null;
    const { campaign } = drill;
    const isLevel2 = "adset" in drill;
    const goBack = () => setDrill(isLevel2 ? { campaign } : null);
    const emptyLabel = isLevel2 ? "criativo" : "conjunto";

    return (
      <div key={isLevel2 ? `ad:${drill.adset.id}` : `adset:${campaign.campaignId}`} className="fade-in-up">
        <Button variant="ghost" size="sm" className="-ml-2 mb-3 gap-1 text-muted-foreground hover:text-foreground" onClick={goBack}>
          <ChevronLeft className="w-4 h-4" /> Voltar
        </Button>

        <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <button type="button" className="hover:text-foreground hover:underline" onClick={() => setDrill(null)}>
            {campaign.clientName}
          </button>
          <span>/</span>
          {isLevel2 ? (
            <button type="button" className="hover:text-foreground hover:underline truncate max-w-[10rem]" onClick={() => setDrill({ campaign })}>
              {campaign.campaignName}
            </button>
          ) : (
            <span className="text-foreground font-medium truncate max-w-[14rem]">{campaign.campaignName}</span>
          )}
          {isLevel2 && (
            <>
              <span>/</span>
              <span className="text-foreground font-medium truncate max-w-[10rem]">{drill.adset.name}</span>
            </>
          )}
        </div>

        <h2 className="font-display text-xl font-bold tracking-tight mb-4">{isLevel2 ? "Criativos" : "Conjuntos"}</h2>

        {drillLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando {isLevel2 ? "criativos" : "conjuntos"}...
          </div>
        )}

        {!drillLoading && drillNodes.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-10">
            Nenhum {emptyLabel} encontrado {isLevel2 ? "nesse conjunto" : "nessa campanha"}.
          </p>
        )}

        {!drillLoading && drillNodes.length > 0 && (
          <div className="space-y-2">{drillNodes.map((node) => renderNodeRow(node, campaign, !isLevel2))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      {!drill && (
      <>
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
      </>
      )}

      {drill && renderDrillView()}

      <Dialog open={!!notifyPreview} onOpenChange={(o) => !o && setNotifyPreview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Avisar o cliente no grupo?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Enviando para{" "}
            <strong className="text-foreground">{notifyPreview?.clientName ?? "cliente"}</strong>
            {notifyPreview?.groupId ? <> · grupo <span className="font-mono">{notifyPreview.groupId}</span></> : null}. Confira antes de enviar.
          </p>
          <p className="min-w-0 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
            {notifyPreview?.text}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNotifyPreview(null)}>
              Agora não
            </Button>
            <Button onClick={handleEnviarAviso} disabled={sendingNotify}>
              {sendingNotify ? "Enviando..." : "Enviar aviso"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
