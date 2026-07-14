import { useEffect, useState, useRef } from "react";
import { Gauge, Loader2, AlertTriangle, CheckCircle2, History, ChevronRight, ChevronLeft, Copy } from "lucide-react";
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
  activateCampaign,
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
import { getMetricDef, formatMetricValue, rangeKey, type AggregatedBucket, type DateRangeSelection, type MetricComponent } from "@/lib/meta-insights";
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

// true = registro de pausa de um NÓ (conjunto/criativo) via drill-in; false = ação na campanha inteira.
const isNodeAction = (a: OptimizationActionRecord) =>
  a.snapshot?.nodeLevel === "adset" || a.snapshot?.nodeLevel === "ad";

// Frase do Histórico por nível: campanha ("Mantida"/"Desligada") vs nó ("Conjunto/Criativo X desligado").
const historyActionPhrase = (a: OptimizationActionRecord): string => {
  if (a.snapshot?.nodeLevel === "adset") return `Conjunto ${a.snapshot.nodeName ?? ""} desligado`.trimEnd();
  if (a.snapshot?.nodeLevel === "ad") return `Criativo ${a.snapshot.nodeName ?? ""} desligado`.trimEnd();
  return actionVerb(a.action);
};

// Chave React estável por entrada do Histórico: nó → campanha:nó:métrica; campanha → campanha:métrica.
const historyEntryKey = (a: OptimizationActionRecord): string =>
  a.snapshot?.nodeId
    ? `${a.campaignId}:${a.snapshot.nodeId}:${a.snapshot?.metric ?? ""}`
    : `${a.campaignId}:${a.snapshot?.metric ?? ""}`;

const fmtActionDate = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Contagem crua (impressões/cliques) — sem métrica no METRIC_REGISTRY pra isso (registry só tem
// razões/moeda, não dimensões brutas). Mesmo locale pt-BR de formatMetricValue.
const fmtCount = (n: number) => n.toLocaleString("pt-BR");

// Formata um componente da faixa de métricas (ver MetricDef.components em meta-insights.ts):
// "count" é dimensão crua (impressões/cliques/vendas/...) → fmtCount; currency/percent reusam
// formatMetricValue, igual ao resto do board. Não-computável (null) vira "—".
function formatComponentValue(value: number | null, unit: MetricComponent["unit"]): string {
  if (value == null) return "—";
  return unit === "count" ? fmtCount(value) : formatMetricValue(value, unit);
}

// Empacota um nó (adset/ad) como um AggregatedBucket de 1 elemento só, pra reusar os `compute()`
// do METRIC_REGISTRY (mesma fórmula usada em Clientes/Otimizações) — não reinventa cálculo de
// CTR/CPM/CCP/CPV95%/etc. adAccountId/bucket/campaignCount não entram em nenhuma fórmula do
// registry hoje, só preenchem o shape do tipo.
function nodeAsAggregatedBucket(node: MetaNodeInsight, adAccountId: string): AggregatedBucket {
  return {
    adAccountId,
    bucket: "Outros",
    spend: node.spend,
    impressions: node.impressions,
    clicks: node.clicks,
    vv95: node.vv95,
    actionCounts: node.actionCounts,
    campaignCount: 1,
  };
}

// Valor da métrica VIOLADA (a do badge de culpado).
function computeNodeMetricValue(violation: OptimizationViolation, node: MetaNodeInsight): number | null {
  const def = getMetricDef(violation.metric);
  return def ? def.compute(nodeAsAggregatedBucket(node, violation.adAccountId)) : null;
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

// Estado do dialog de aviso ao cliente. 3 estados via campos opcionais (não união estrita — property
// access numa união quebraria mesmo no strict:false): carregando (só params) / mensagem pronta
// (text+grupo) / sem-grupo (noGroup). `params` já vem com dry_run:false pronto pro envio.
type NotifyPreviewState = {
  loading: boolean;
  noGroup?: boolean;
  text?: string;
  groupId?: string;
  clientName?: string | null;
  params?: NotifyClientPauseParams;
};

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

  // Preview do aviso ao grupo de WhatsApp do cliente. Abre IMEDIATO após a pausa (com spinner) e é
  // preenchido quando o Graph resolve os links — sem dead time. Ver NotifyPreviewState.
  const [notifyPreview, setNotifyPreview] = useState<NotifyPreviewState | null>(null);
  const [sendingNotify, setSendingNotify] = useState(false);
  // Invalida um preview em voo: bumpa a cada nova pausa E ao fechar o dialog. Se o await do
  // notifyClientPause resolver com reqId != atual, o resultado é dropado — não reabre um dialog
  // que o gestor já dispensou (a janela do loading = latência do Graph, dá tempo de fechar).
  const notifyReqRef = useRef(0);

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
        // IDs de todas as campanhas ATIVAS agora (fetchCampaigns já filtra effective_status=ACTIVE).
        // O engine usa isso pra sumir com pausa de CAMPANHA cuja campanha voltou a ficar ativa
        // (Religar ou reativação por fora). Set compartilhado — cada .add é síncrono, sem corrida.
        const activeCampaignIds = new Set<string>();
        await mapWithConcurrency(configs, ACCOUNTS_CONCURRENCY, async (config) => {
          try {
            const campaigns = await fetchCampaigns(status.access_token, config.adAccountId);
            if (campaigns.length === 0) return;
            for (const c of campaigns as { id: string }[]) activeCampaignIds.add(c.id);

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
        const { pendentes, history: historyEntries } = buildOptimizationView(found, actionRecords, rangeKey(range), activeCampaignIds);

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

  // Registra manter/desligar. `node` presente = pausa de um NÓ (conjunto/criativo): grava nível+id+nome
  // no snapshot → vira registro SEPARADO no Histórico ("Conjunto X desligado"), NÃO marca a campanha
  // como Desligada nem a tira de Pendentes. Ausente = ação na campanha inteira (Manter/Desligar campanha).
  async function recordAction(
    violation: OptimizationViolation,
    action: ActionKind,
    node?: { level: "adset" | "ad"; id: string; name: string },
  ) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    // rangeKey grava o período em que o snapshot foi tirado — o "piorou" no Histórico só compara
    // valores do mesmo período (7d vs 30d seria maçã com laranja).
    const snapshot: MetricSnapshot = {
      metric: violation.metric, actual: violation.actual, limit: violation.limit, operator: violation.operator,
      rangeKey: rangeKey(range),
      nodeLevel: node ? node.level : "campaign",
      ...(node ? { nodeId: node.id, nodeName: node.name } : {}),
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

    const entry: OptimizationHistoryEntry = {
      action: {
        campaignId: violation.campaignId,
        campaignName: violation.campaignName,
        clientName: violation.clientName,
        action,
        snapshot,
        createdAt: new Date().toISOString(),
      },
      live: node ? null : violation, // registro de nó = log puro, sem violação viva
      comparable: !node,             // campanha: snapshot é do período atual → "estava X→agora Y". nó: sem live.
      worsened: false,
    };

    if (node) {
      // Pausa de nó: NÃO tira a campanha de Pendentes. Só adiciona o log ao Histórico, dedup pela
      // chave (campanha, nó, métrica) — sem sobrescrever a entrada da campanha nem de outros nós.
      const sameNode = (a: OptimizationActionRecord) =>
        a.campaignId === violation.campaignId && a.snapshot?.nodeId === node.id && (a.snapshot?.metric ?? "") === violation.metric;
      setHistory((prev) => [entry, ...prev.filter((h) => !sameNode(h.action))]);
      return;
    }

    // Ação de campanha: sai de Pendentes e entra/atualiza no Histórico. Chave (campanha, MÉTRICA):
    // trata só a métrica agida — outra métrica fora do KPI segue em Pendentes. Substitui só a entrada
    // de CAMPANHA dessa célula; logs de nó (nodeId != null) da mesma campanha ficam intactos.
    const sameCell = (campaignId: string, metric: string) =>
      campaignId === violation.campaignId && metric === violation.metric;
    setViolations((prev) => prev.filter((v) => !sameCell(v.campaignId, v.metric)));
    setHistory((prev) => [
      entry,
      ...prev.filter((h) => h.action.snapshot?.nodeId != null || !sameCell(h.action.campaignId, h.action.snapshot?.metric ?? "")),
    ]);
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

  // Copia o ID COMPLETO da campanha pro clipboard — o gestor cola no Gerenciador da Meta pra achar
  // a campanha. try/catch porque navigator.clipboard pode não existir (contexto não-seguro/negado).
  async function handleCopyId(campaignId: string) {
    try {
      await navigator.clipboard.writeText(campaignId);
      toast({ title: "ID da campanha copiado" });
    } catch {
      toast({ variant: "destructive", title: "Não foi possível copiar o ID" });
    }
  }

  // Desliga a CAMPANHA inteira (PAUSED) direto do card — fallback sempre disponível, sem depender
  // do drill-in de conjuntos/criativos (que some se a edge de estrutura falhar). Reusa `pausingId`
  // como trava de clique (card da lista e nós do drill nunca aparecem juntos, sem colisão). Depois
  // da pausa, prepara o aviso WhatsApp do cliente (nível campanha), igual ao pausar-nó.
  async function handleDesligarCampanha(violation: OptimizationViolation) {
    if (!accessToken) return;
    setPausingId(violation.campaignId);
    try {
      await pauseCampaign(accessToken, violation.campaignId);
    } catch (e) {
      toast({ variant: "destructive", title: "Erro ao desligar", description: (e as Error).message });
      setPausingId(null);
      return;
    }
    // Pausa aplicada na Meta. Registra a ação (sai de Pendentes, entra no Histórico). Falha aqui
    // (RLS/rede) não desfaz a pausa já feita — só o bookkeeping local fica pra trás, sem travar a UI.
    try {
      await recordAction(violation, "paused");
    } catch (e) {
      console.error("Falha ao registrar pausa da campanha em optimization_actions (já pausada na Meta)", e);
    }
    setPausingId(null);
    toast({ title: "Campanha desligada", description: violation.campaignName });

    // Best-effort: prepara o aviso pro grupo de WhatsApp do cliente (nível campanha). A pausa já
    // está feita acima — qualquer falha aqui (sem grupo, rede, edge fora) NUNCA desfaz/bloqueia.
    try {
      const previewParams: NotifyClientPauseParams = {
        access_token: accessToken,
        ad_account_id: violation.adAccountId,
        level: "campaign",
        campaign_id: violation.campaignId,
        campaign_name: violation.campaignName,
        metric_label: getMetricDef(violation.metric)?.label ?? violation.metric,
        dry_run: true,
      };
      // Abre o dialog JÁ, com spinner — resolve os links (round-trips no Graph) em background.
      const reqId = ++notifyReqRef.current;
      setNotifyPreview({ loading: true, params: { ...previewParams, dry_run: false } });
      const result = await notifyClientPause(previewParams);
      // Fechou o dialog (ou disparou outro preview) durante o loading? O ref mudou → dropa este
      // resultado em voo pra NÃO reabrir o dialog que o gestor acabou de dispensar.
      if (notifyReqRef.current !== reqId) return;
      // `=== true`/`=== false`, não truthy: com `strict:false` o TS não estreita a união por booleano.
      if (result.ok === true && "text" in result) {
        setNotifyPreview({ loading: false, text: result.text, groupId: result.group_id, clientName: result.client_name, params: { ...previewParams, dry_run: false } });
      } else if (result.ok === false) {
        setNotifyPreview({ loading: false, noGroup: true });
      }
    } catch (e) {
      console.error("Falha ao preparar aviso ao cliente no WhatsApp (campanha já desligada)", e);
      setNotifyPreview(null); // fecha o spinner em vez de deixá-lo girando pra sempre.
    }
  }

  // Religa (reativa, status ACTIVE) a campanha desligada direto do card do Histórico. Só aparece em
  // cards de campanha desligada (nível campanha, "paused"). Reusa `pausingId` como trava. SILENCIOSO —
  // NÃO avisa o cliente (só a pausa avisa). Não grava ação: no próximo load a campanha aparece em
  // activeCampaignIds e o engine já exclui a pausa de campanha do Histórico.
  async function handleReligar(action: OptimizationActionRecord) {
    if (!accessToken) return;
    setPausingId(action.campaignId);
    try {
      await activateCampaign(accessToken, action.campaignId);
    } catch (e) {
      toast({ variant: "destructive", title: "Erro ao religar", description: (e as Error).message });
      setPausingId(null);
      return;
    }
    // Reativada na Meta. Some do Histórico local na hora — só a entrada de CAMPANHA dessa célula
    // (campanha + métrica, sem nó); logs de nó da mesma campanha ficam.
    const metric = action.snapshot?.metric ?? "";
    setHistory((prev) => prev.filter((h) =>
      !(h.action.campaignId === action.campaignId && h.action.snapshot?.nodeId == null && (h.action.snapshot?.metric ?? "") === metric)
    ));
    setPausingId(null);
    toast({ title: "Campanha religada", description: action.campaignName ?? action.campaignId });
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
    // Registra no Histórico O NÓ desligado (nível adset/ad) — não a campanha. Se falhar (rede/RLS),
    // o nó já pausado na Meta não vira "nada aconteceu" — só o bookkeeping local fica pra trás.
    const nodeLevel: "adset" | "ad" = "adset" in drill ? "ad" : "adset";
    try {
      await recordAction(drill.campaign, "paused", { level: nodeLevel, id: node.id, name: node.name });
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
      // Abre o dialog JÁ, com spinner — resolve os links (round-trips no Graph) em background.
      const reqId = ++notifyReqRef.current;
      setNotifyPreview({ loading: true, params: { ...previewParams, dry_run: false } });
      const result = await notifyClientPause(previewParams);
      // Fechou o dialog (ou disparou outro preview) durante o loading? O ref mudou → dropa este
      // resultado em voo pra NÃO reabrir o dialog que o gestor acabou de dispensar.
      if (notifyReqRef.current !== reqId) return;
      // `=== true`/`=== false`, não truthy: com `strict:false` (tsconfig.app.json) o TS não estreita
      // essa união discriminada por booleano em `if (result.ok)` — vira erro de tsc no `else`.
      if (result.ok === true && "text" in result) {
        setNotifyPreview({ loading: false, text: result.text, groupId: result.group_id, clientName: result.client_name, params: { ...previewParams, dry_run: false } });
      } else if (result.ok === false) {
        setNotifyPreview({ loading: false, noGroup: true });
      }
    } catch (e) {
      console.error("Falha ao preparar aviso ao cliente no WhatsApp (pausa já concluída)", e);
      setNotifyPreview(null); // fecha o spinner em vez de deixá-lo girando pra sempre.
    }
  }

  // Fecha o dialog de aviso E invalida qualquer preview em voo (senão um await tardio reabriria o
  // dialog dispensado). TODOS os caminhos de fechar passam por aqui: Escape/click-fora, "Agora não"
  // e "Fechar" — o botão "Agora não" também fica visível durante o loading, então tem a mesma corrida.
  function dismissNotify() {
    notifyReqRef.current++;
    setNotifyPreview(null);
  }

  // Envio real do aviso (dry_run:false) a partir do preview aberto. Best-effort: falha aqui é só
  // toast — a pausa já aconteceu antes desse dialog existir.
  async function handleEnviarAviso() {
    // Só dispara no estado "mensagem" (tem text + params). Guarda contra loading / sem-grupo.
    if (!notifyPreview?.text || !notifyPreview.params) return;
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
    // Faixa com só os componentes relevantes ao KPI violado (mesma faixa do drill-in, ver
    // renderNodeRow) — só existe quando compareKpis() conseguiu montar o agregado; sem ele, não
    // renderiza (sem "0" enganoso).
    const agg = v.agg;
    const components = getMetricDef(v.metric)?.components ?? [];
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
              {/* Copiar ID da campanha. stopPropagation (click E keydown) pra não disparar o drill-in
                  do card ao clicar/teclar no botão. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyId(v.campaignId);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                aria-label="Copiar ID da campanha"
                title="Copiar ID da campanha"
              >
                <Copy className="w-3.5 h-3.5" />
              </Button>
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
            {agg && (
              <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 flex-wrap text-[10px] text-muted-foreground">
                {components.map((c) => (
                  <span key={c.label}>{c.label}: {formatComponentValue(c.compute(agg), c.unit)}</span>
                ))}
              </div>
            )}
          </CardContent>
        </div>
        <CardContent className="p-4 pt-0">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => handleManter(v)}>
              {meta ? "Manter mais" : "Manter"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={pausingId === v.campaignId}
              onClick={() => handleDesligarCampanha(v)}
            >
              {pausingId === v.campaignId ? "Desligando..." : "Desligar"}
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
    const nodeAgg = nodeAsAggregatedBucket(node, "");
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
            {/* Faixa compacta com só os componentes relevantes ao KPI violado neste nó — mesma lista
                de components() do METRIC_REGISTRY usada no card de campanha (ver renderViolationCard). */}
            <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 flex-wrap text-[10px] text-muted-foreground">
              {(def?.components ?? []).map((c) => (
                <span key={c.label}>{c.label}: {formatComponentValue(c.compute(nodeAgg), c.unit)}</span>
              ))}
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

        {/* Mesmo seletor da lista de campanhas — `range` é estado compartilhado do board, e o loader
            de nós do drill já depende de `range` (useEffect acima), então trocar o período aqui
            refaz o fetch dos conjuntos/criativos automaticamente. */}
        <div className="mb-4">
          <DateRangeSelector value={range} onChange={setRange} />
        </div>

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
                    key={historyEntryKey(h.action)}
                    className="border-l-[3px] border-l-muted-foreground/25 fade-in-up opacity-80"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    <CardContent className="p-4">
                      {isNodeAction(h.action) ? (
                        // Log de nó: o QUE foi desligado (conjunto/criativo) LIDERA; a campanha (em geral
                        // ainda ativa) vira contexto secundário, pra não ler como "campanha desligada".
                        <>
                          <p className="text-sm truncate">{historyActionPhrase(h.action)}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            na campanha {h.action.campaignName ?? h.action.campaignId}
                          </p>
                          {h.action.clientName && (
                            <p className="text-xs text-muted-foreground truncate">{h.action.clientName}</p>
                          )}
                          <p className="text-[11px] text-muted-foreground mt-1.5">em {fmtActionDate(h.action.createdAt)}</p>
                        </>
                      ) : (
                        // Ação de campanha: título = campanha, frase "Mantida/Desligada … inativa agora".
                        <>
                          <p className="text-sm truncate">{h.action.campaignName ?? h.action.campaignId}</p>
                          {h.action.clientName && (
                            <p className="text-xs text-muted-foreground truncate">{h.action.clientName}</p>
                          )}
                          <p className="text-[11px] text-muted-foreground mt-1.5">
                            {historyActionPhrase(h.action)} em {fmtActionDate(h.action.createdAt)} · dentro do limite ou inativa agora
                          </p>
                          {/* Religar SÓ em campanha desligada (paused) e inativa. Nó é log — sem botão. */}
                          {h.action.action === "paused" && (
                            <div className="flex mt-3">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pausingId === h.action.campaignId}
                                onClick={() => handleReligar(h.action)}
                              >
                                {pausingId === h.action.campaignId ? "Religando..." : "Religar"}
                              </Button>
                            </div>
                          )}
                        </>
                      )}
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

      <Dialog open={!!notifyPreview} onOpenChange={(o) => { if (!o) dismissNotify(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Avisar o cliente no grupo?</DialogTitle>
          </DialogHeader>
          {notifyPreview?.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Preparando prévia do aviso…
            </div>
          ) : notifyPreview?.noGroup ? (
            <p className="text-sm text-muted-foreground py-2">
              Cliente sem grupo de WhatsApp configurado.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Enviando para{" "}
                <strong className="text-foreground">{notifyPreview?.clientName ?? "cliente"}</strong>
                {notifyPreview?.groupId ? <> · grupo <span className="font-mono">{notifyPreview.groupId}</span></> : null}. Confira antes de enviar.
              </p>
              <p className="min-w-0 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
                {notifyPreview?.text}
              </p>
            </>
          )}
          <DialogFooter>
            {notifyPreview?.noGroup ? (
              <Button variant="outline" onClick={dismissNotify}>
                Fechar
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={dismissNotify}>
                  Agora não
                </Button>
                <Button onClick={handleEnviarAviso} disabled={sendingNotify || notifyPreview?.loading || !notifyPreview?.text}>
                  {sendingNotify ? "Enviando..." : "Enviar aviso"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
