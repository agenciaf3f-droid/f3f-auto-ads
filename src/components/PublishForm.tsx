import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WhatsAppNumberSelector,
  WhatsAppMessages,
  Fase3Summary,
  validateFase3Fields as validateFase3FieldsHelper,
} from "@/components/Fase3Components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  LogIn, Settings2, Send, CheckCircle2, Loader2, Copy, AlertTriangle, Unplug,
  Instagram, HardDrive, ArrowRight, FolderOpen, Plus, Calendar, Clock, MessageCircle, MapPin, Phone, Save, Trash2,
  Layers, PlusCircle, X, Pencil, Search, ChevronDown, RefreshCw,
} from "lucide-react";
import {
  getMetaLoginUrl, fetchMetaStatus, fetchAdAccounts, fetchAudiences,
  publishAd, validateCreative, fetchCampaigns,
  fetchWhatsAppNumbers, fetchIgAccountsForAdAccount, disconnectMeta,
  fetchImportedMetaTemplates, type ImportedMetaTemplate,
  fetchPixels, type AdPixel,
} from "@/lib/meta-api";
import { generateCampaignName, generateLtCampaignName, generateAdsetName, generateAdName_v2 } from "@/lib/naming";
import {
  placementKindFor, placementGroupsFor, allPlacementKeys, placementKey, buildPlacementsObject,
} from "@/lib/placements";
import { listClientAdAccounts, listClientLtProducts } from "@/lib/clients";
import SearchableSelect from "@/components/SearchableSelect";
import IDDisplay from "@/components/IDDisplay";
import LocationSelector, { type LocationItem } from "@/components/LocationSelector";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { supabase } from "@/integrations/supabase/client";
import { usePublishing } from "@/contexts/PublishingContext";

interface AdAccount { id: string; name: string }
interface Audience { id: string; name: string; type: "custom" | "saved"; targeting_spec?: any }
interface Campaign { id: string; name: string; status: string; objective: string; effective_status?: string; daily_budget?: string; lifetime_budget?: string; bid_strategy?: string }
interface WhatsAppNumber { id: string; display: string; phone: string; page_id: string; page_name: string; status?: string; waba_id?: string }
interface MessageTemplate { id: string; name: string; greeting: string; ready_message: string }
interface PublishResult { ok?: boolean; campaign_id?: string; campaign_ids?: string[]; adset_id?: string; ad_id?: string; creative_id?: string; error?: string; step?: string; error_message?: string; error_code?: number | null; error_subcode?: number | null; error_user_msg?: string; error_user_title?: string; raw_error?: any; logs?: { step: string; status: string; ts: string; detail?: string }[]; adsets_created?: number; ads_created?: number; warning?: boolean; creative_errors?: { name: string; error: string }[] }
interface ErrorDetails { message?: string; error_user_title?: string; error_user_msg?: string; code?: number | null; error_subcode?: number | null; error_data?: any }
interface ValidationResult { valid: boolean; checks?: { label: string; ok: boolean; detail: string }[]; error?: string; error_details?: ErrorDetails; min_budget?: number | null }

type CreativeType = "instagram" | "drive";
type CampaignStructure = "new" | "existing";
type DistributionStructure = "ABO" | "CBO";

function tryParseError(err: unknown): PublishResult | null {
  // (1) try extrair .context
  try {
    if (err && typeof err === "object" && "context" in err) {
      const ctx = (err as any).context;
      if (ctx && typeof ctx === "object") return ctx as PublishResult;
    }
  } catch (parseErr) {
    if (typeof console !== "undefined") console.debug("[tryParseError] context extract failed", parseErr);
  }
  // (2) try JSON.parse(message ou string)
  try {
    if (err && typeof err === "object") {
      const raw = typeof err === "string" ? JSON.parse(err) : (err as any).message ? JSON.parse((err as any).message) : null;
      if (raw && typeof raw === "object" && ("step" in raw || "error_message" in raw)) return raw as PublishResult;
    }
  } catch (parseErr) {
    if (typeof console !== "undefined") console.debug("[tryParseError] JSON.parse failed", parseErr);
  }
  // (3) return null
  return null;
}

interface CreativeItem {
  id: string;
  type: CreativeType;
  link: string;
  name: string;
  validation?: { ok: boolean; error?: string; suggest_drive?: boolean } | null;
  // media_id resolvido pela validação IG (evita re-scan no publish). Limpo ao editar link/tipo.
  resolved_instagram_media_id?: string | null;
  resolved_ig_account_id?: string | null;
  // Texto primário (copy) — só criativo Drive usa; override individual, cai no "texto para
  // todos" (captionAll) se vazio. Instagram usa a legenda do próprio post.
  caption?: string;
}

// Aplica o resultado da validação a um criativo: guarda a validação + o media_id/ig resolvido
// (só em sucesso). Usada no setCreatives (state) E no finalCreatives (payload) — mesma lógica.
function applyCreativeValidation(c: CreativeItem, r: any): CreativeItem {
  return {
    ...c,
    validation: r,
    resolved_instagram_media_id: r?.ok ? (r.instagram_media_id ?? null) : null,
    resolved_ig_account_id: r?.ok ? (r.ig_account_id ?? null) : null,
  };
}

// Resolve o texto primário final de um criativo: override individual (c.caption) tem
// prioridade; vazio cai no "texto para todos" (captionAll). Usada ao montar o payload
// validado — o publish reusa o valor já resolvido (não recalcula contra captionAll ao vivo).
function resolveCreativeCaption(c: CreativeItem, captionAll: string): string | undefined {
  return c.caption?.trim() ? c.caption.trim() : (captionAll.trim() || undefined);
}

const PRESETS = [
  {
    id: "fase1-trafego",
    label: "FASE 1 - TRÁFEGO",
    objective: "OUTCOME_TRAFFIC",
    optimization_goal: "PROFILE_VISIT",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "INSTAGRAM_PROFILE",
    default_cta: "NO_BUTTON",
    status: "PAUSED",
    fase: "FASE 1",
    requires_whatsapp: false,
    not_implemented: false,
  },
  {
    id: "fase2-publico-completo",
    label: "FASE 2 - POLONÊS COMPLETO",
    objective: "OUTCOME_ENGAGEMENT",
    optimization_goal: "THRUPLAY",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "ON_VIDEO",
    default_cta: "NO_BUTTON",
    status: "PAUSED",
    fase: "FASE 2",
    requires_whatsapp: false,
    not_implemented: false,
  },
  {
    id: "fase2-polones-adaptado",
    label: "FASE 2 - POLONÊS ADAPTADO",
    objective: "OUTCOME_ENGAGEMENT",
    optimization_goal: "THRUPLAY",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "ON_VIDEO",
    default_cta: "NO_BUTTON",
    status: "PAUSED",
    fase: "FASE 2",
    requires_whatsapp: false,
    not_implemented: false,
  },
  {
    id: "fase3-br",
    label: "FASE 3 - LEADS | ZAP",
    objective: "OUTCOME_LEADS",
    optimization_goal: "CONVERSATIONS",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "WHATSAPP",
    default_cta: "WHATSAPP_MESSAGE",
    status: "PAUSED",
    fase: "FASE 3",
    requires_whatsapp: true,
    not_implemented: false,
  },
  {
    id: "fase3-leads-lp",
    label: "FASE 3 - LEADS | LP",
    objective: "OUTCOME_LEADS",
    optimization_goal: "OFFSITE_CONVERSIONS",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "WEBSITE",
    default_cta: "LEARN_MORE",
    status: "PAUSED",
    fase: "FASE 3",
    requires_whatsapp: false,
    not_implemented: false,
  },
  {
    id: "fase3-vendas-zap",
    label: "FASE 3 - VENDAS | ZAP",
    objective: "OUTCOME_SALES",
    optimization_goal: "CONVERSATIONS",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "WHATSAPP",
    default_cta: "WHATSAPP_MESSAGE",
    status: "PAUSED",
    fase: "FASE 3",
    requires_whatsapp: true,
    not_implemented: false,
  },
  {
    id: "fase3-vendas-lp",
    label: "L.T",
    objective: "OUTCOME_SALES",
    optimization_goal: "OFFSITE_CONVERSIONS",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "WEBSITE",
    default_cta: "LEARN_MORE",
    status: "PAUSED",
    fase: "FASE 3",
    requires_whatsapp: false,
    not_implemented: false,
  },
] as const;
type PresetId = typeof PRESETS[number]["id"];

const UTM_DEFAULT = "utm_source=FB&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_medium={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}&utm_term={{placement}}";

// TTL do cache de descoberta: linha mais velha que isso é tratada como cache miss (call site busca
// da Meta de novo, e o edge regrava o cache). Sem TTL, recurso criado fora do app (público, conta,
// número) some pra sempre até o gestor clicar em "Atualizar" manualmente.
const DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000; // 10min

// Cache de descoberta COMPARTILHADO no banco (tabela meta_discovery_cache, gravada pelos edges).
// Frontend LÊ daqui primeiro em cada load* = 0 chamada Meta. kind ∈ {ad_accounts, audiences,
// identity, imported_templates, whatsapp_numbers, pixels}; account_id = conta (ou "shared"
// p/ ad_accounts). Retorna o `data` só se NÃO-vazio (array com itens / objeto com keys) E dentro do
// TTL (DISCOVERY_CACHE_TTL_MS); senão null. `updated_at` ausente/inválido conta como stale (falhar
// pro lado de buscar da Meta é seguro; falhar pro lado de servir cache eterno é o bug original).
// Loga o error do supabase-js (NÃO lança em falha de RLS) — guard anti-silêncio.
async function readDiscoveryCache<T = unknown>(kind: string, accountId: string): Promise<T | null> {
  try {
    const { data, error } = await supabase
      .from("meta_discovery_cache")
      .select("data, updated_at")
      .eq("kind", kind)
      .eq("account_id", accountId)
      .maybeSingle();
    if (error) {
      console.warn(`[discovery-cache] leitura ${kind}/${accountId} falhou: ${error.message}`);
      return null;
    }
    const updatedAtMs = data?.updated_at ? new Date(data.updated_at).getTime() : NaN;
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > DISCOVERY_CACHE_TTL_MS) return null;
    const d = data?.data as unknown;
    if (Array.isArray(d)) return d.length ? (d as T) : null;
    if (d && typeof d === "object" && Object.keys(d).length > 0) return d as T;
    return null;
  } catch (e) {
    console.warn(`[discovery-cache] leitura ${kind}/${accountId} erro: ${e instanceof Error ? e.message : "?"}`);
    return null;
  }
}

let creativeCounter = 0;
function nextCreativeId() { return `cr_${++creativeCounter}_${Date.now()}`; }
function blankCreative(): CreativeItem {
  return { id: nextCreativeId(), type: "instagram", link: "", name: "", validation: null };
}

let audienceRowCounter = 0;
function nextAudienceRowId() { return `aud_${++audienceRowCounter}_${Date.now()}`; }

interface AudienceRow { id: string; audienceId: string }

// ── Orquestração paralela de publish ──
const PUBLISH_CONCURRENCY = 3;              // quantos criativos sobem em paralelo (balance velocidade x rate limit da Meta)
const PUBLISH_BACKOFF = [3000, 8000, 20000]; // backoff (ms) de retry só p/ erro transiente {1,2}/transporte
// Rate-limit (#4) = janela ROLANTE de ~1h: se esperar, budget SEMPRE libera (chamadas velhas saem).
// Logo, ESPERA fixa de 2min e RETOMA o mesmo criativo, até 18× (~36min por criativo) — sobrevive à
// janela de 1h com folga e CONVERGE (não é loop infinito). Só desiste desse criativo ao esgotar.
const RATE_LIMIT_BACKOFF_MS = 120000; // 2min por espera
const RATE_LIMIT_MAX_WAITS = 18;      // ~36min de espera máx. por criativo
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613]); // rate-limit da Meta: falha rápido (decai em ~15min), não martela
const FAST_RETRY_CODES = new Set([1, 2]);   // transiente curto: vale re-tentar com backoff

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pool de concorrência: no máx `limit` workers simultâneos consumindo `items` (cursor síncrono = atômico no event loop).
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>, staggerMs = 0): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async (_unused, runnerIdx) => {
    // Escalona a largada dos workers (runner n espera n*staggerMs) pra 1ª onda não disparar
    // K uploads simultâneos em t=0 — reduz o pico de writes que dispara rate limit.
    if (staggerMs && runnerIdx > 0) await sleep(runnerIdx * staggerMs);
    while (cursor < items.length) {
      const k = cursor++;
      await worker(items[k]);
    }
  });
  await Promise.all(runners);
}

// Código Meta do erro: preferir estruturado (error_code, vem da edge), senão raspar "code=NNN" de reason/msg.
function metaErrorCode(r: unknown): number | null {
  const o = r as Record<string, unknown> | null;
  if (o && typeof o.error_code === "number") return o.error_code;
  const hay = `${(o?.error_message as string) ?? ""} ${(o?.error as string) ?? ""} ${o?.failures ? JSON.stringify(o.failures) : ""}`;
  const m = hay.match(/\bcode=(\d+)\b/);
  return m ? Number(m[1]) : null;
}

// Classe de retry: "rate_limit" (falha rápido, não martela), "fast" (backoff), "none".
function classifyRetry(r: unknown, threw: boolean): "rate_limit" | "fast" | "none" {
  if (threw) return "fast";
  const o = r as Record<string, unknown> | null;
  const c = metaErrorCode(r);
  if (c != null && RATE_LIMIT_CODES.has(c)) return "rate_limit";
  if (c != null && FAST_RETRY_CODES.has(c)) return "fast";
  // is_transient sem código legível pode ser rate-limit — falha rápido (viés seguro p/ a conta), não martela.
  if (o?.is_transient === true) return "rate_limit";
  return "none";
}

// Logs vivem aqui (estado próprio) para que addLog NÃO re-renderize o form gigante.
// Durante validate/publish o storm de logs antes derrubava o frame rate (spinner
// "travava"); agora só este painel pequeno re-renderiza.
export interface LogPanelHandle {
  add: (msg: string) => void;
  clear: () => void;
}

const LogPanel = forwardRef<LogPanelHandle>((_props, ref) => {
  const [logs, setLogs] = useState<string[]>([]);
  useImperativeHandle(ref, () => ({
    add: (msg) => setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]),
    clear: () => setLogs([]),
  }), []);

  const copy = () => {
    navigator.clipboard.writeText(logs.join("\n"));
    toast.success("Relatório copiado!");
  };

  return (
    <Card className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <Label className="font-display font-semibold text-xs text-muted-foreground">LOGS</Label>
        <Button variant="ghost" size="sm" onClick={copy} className="h-7 text-xs gap-1">
          <Copy className="w-3 h-3" /> Copiar
        </Button>
      </div>
      <div className="max-h-40 overflow-y-auto space-y-1">
        {logs.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhum log ainda...</p>
        ) : logs.slice(-150).map((log, i) => (
          <p key={i} className="text-xs font-mono text-muted-foreground">{log}</p>
        ))}
      </div>
    </Card>
  );
});
LogPanel.displayName = "LogPanel";

export default function PublishForm() {
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Logs emitidos antes do LogPanel montar (ex: checkMetaStatus no boot, enquanto
  // metaLoading=true) ficam aqui até o ref conectar — senão são perdidos (addLog
  // vira no-op com logRef.current === null).
  const pendingLogsRef = useRef<string[]>([]);
  // Progresso de publish multi-criativo: permite retomar da campanha já criada
  // em vez de recomeçar do criativo #1 quando o usuário clica Publicar de novo
  // após uma falha parcial (recomeçar colide com o lock de idempotência do adset).
  const multiPublishProgressRef = useRef<{
    payload: Record<string, unknown>;
    campaignId: string;
    adsetId?: string;
    adsetsCreated: number;
    adsCreated: number;
    okNames: string[];
    pending: number[];
  } | null>(null);

  // FASE 2 COMPLETO multi-criativo: 1 campanha por criativo. Guarda as campanhas já
  // publicadas com sucesso nesta sessão, indexadas por CHAVE DE CONTEÚDO do criativo
  // (name+link) — não por identidade do payload, que a validação recria a cada clique.
  // FASE 2 não tem dedupe lock no backend (é WhatsApp-only), então republicar um criativo
  // já publicado criaria campanha DUPLICADA (gasto dobrado). Este ref evita isso.
  const fase2MultiCampaignRef = useRef<{
    campaigns: { name: string; key: string; campaignId: string; adsets: number; ads: number }[];
  } | null>(null);

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [metaName, setMetaName] = useState("");
  const [metaLoading, setMetaLoading] = useState(true);

  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [selectedAudience, setSelectedAudience] = useState("");
  // Multi-público (FASE 1 / FASE 3): N linhas de público, combinadas (OR) em 1 conjunto.
  const [audienceRows, setAudienceRows] = useState<AudienceRow[]>([{ id: nextAudienceRowId(), audienceId: "" }]);
  const [campaignNameInput, setCampaignNameInput] = useState("");
  // L.T: 1º bloco do nome (livre, ex: "LDX") e sufixo opcional após o traço final.
  // Desacoplados do "Nome do produto" (campaignNameInput) — produto NÃO entra mais no nome.
  const [ltNomenclatura, setLtNomenclatura] = useState("");
  const [ltSuffix, setLtSuffix] = useState("");
  // Produtos L.T cadastrados em Clientes p/ a conta selecionada (alimenta dropdown de produto).
  const [ltProducts, setLtProducts] = useState<{ id: string; name: string }[]>([]);
  const [ltProductsClientId, setLtProductsClientId] = useState<string | null>(null);
  const [adsetNameInput, setAdsetNameInput] = useState("");
  const [budget, setBudget] = useState("");
  const [campaignStructure, setCampaignStructure] = useState<CampaignStructure>("new");
  const [distributionStructure, setDistributionStructure] = useState<DistributionStructure>("ABO");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [preset, setPreset] = useState<PresetId>("fase1-trafego");
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loadingAdAccounts, setLoadingAdAccounts] = useState(false);
  const [loading, setLoading] = useState(false);
  // Sinal global de publicação em andamento (guard de navegação + beforeunload no AppLayout).
  const { setPublishing } = usePublishing();
  const [loadingAudiences, setLoadingAudiences] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [validatedPayload, setValidatedPayload] = useState<Record<string, unknown> | null>(null);
  const [minBudget, setMinBudget] = useState<number | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  // Status ao vivo durante a publicação (ex.: aguardando janela do rate-limit #4 pra retomar).
  const [publishStatus, setPublishStatus] = useState("");
  const logRef = useRef<LogPanelHandle>(null);
  const publishErrorRef = useRef<HTMLDivElement>(null);
  // Dedup do carregamento FASE 3: guarda a chave "conta|page" já carregada. loadFase3Resources é
  // chamado de 2 lugares (loadAccountContext + effect de preset/identidade) e na troca de conta os
  // DOIS disparam → 2× whatsapp/templates. O ref garante que só 1 executa por conta|page.
  const fase3LoadedKeyRef = useRef("");
  useEffect(() => {
    if (publishResult && !publishResult.ok) {
      publishErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [publishResult]);
  const [validatingCreative, setValidatingCreative] = useState(false);

  // Multi-creative
  const [creatives, setCreatives] = useState<CreativeItem[]>([blankCreative()]);
  // Bulk: quantidade de slots a gerar de uma vez.
  const [bulkCount, setBulkCount] = useState("");
  // Copy (texto primário) — modal "Adicionar copy". captionAll = fallback pra todo criativo
  // Drive sem override; overrides individuais vivem em creatives[].caption.
  const [captionAll, setCaptionAll] = useState("");
  const [copyModalOpen, setCopyModalOpen] = useState(false);

  // FASE 3 fields
  const [whatsappNumbers, setWhatsappNumbers] = useState<WhatsAppNumber[]>([]);
  const [loadingWhatsappNumbers, setLoadingWhatsappNumbers] = useState(false);
  const [selectedWhatsappId, setSelectedWhatsappId] = useState("");
  // Motivo da falha ao puxar WhatsApp (sem entrada manual: explicar o erro real).
  const [whatsappError, setWhatsappError] = useState<string | null>(null);
  const [ctaText, setCtaText] = useState("");
  const [greetingText, setGreetingText] = useState("");
  const [readyMessage, setReadyMessage] = useState("");
  // Modo de mensagem FASE 3: false = usar modelo importado (CTWA); true = criar mensagem manual
  // (Saudação + Mensagem pronta). Toggle re-exposto no Fase3Components (WhatsAppMessages).
  const [useCustomMessage, setUseCustomMessage] = useState(false);

  // Location
  const [includedLocations, setIncludedLocations] = useState<LocationItem[]>([]);
  const [excludedLocations, setExcludedLocations] = useState<LocationItem[]>([]);

  // Message templates
  const [messageTemplates, setMessageTemplates] = useState<MessageTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Imported templates (extraídos das campanhas existentes da conta de anúncios)
  const [importedTemplates, setImportedTemplates] = useState<ImportedMetaTemplate[]>([]);
  const [loadingImported, setLoadingImported] = useState(false);
  const [selectedImportedKey, setSelectedImportedKey] = useState("");
  const [importedRawJson, setImportedRawJson] = useState<string>("");

  // FASE 3 LP — pixels + URL do site
  const [pixels, setPixels] = useState<AdPixel[]>([]);
  const [loadingPixels, setLoadingPixels] = useState(false);
  const [selectedPixelId, setSelectedPixelId] = useState("");
  const [lpUrl, setLpUrl] = useState("");

  // FASE 2 — multi-audience (2-10 inclusion audiences, each becomes 1 adset)
  const [fase2Audiences, setFase2Audiences] = useState<string[]>([]);
  const [fase2Search, setFase2Search] = useState("");
  const [fase2AgeMin, setFase2AgeMin] = useState("18");
  const [fase2AgeMax, setFase2AgeMax] = useState("65");
  const [fase2Gender, setFase2Gender] = useState<"all" | "male" | "female">("all");
  // COMPLETO multi-criativo (1 campanha por criativo): como distribuir o orçamento entre
  // as N campanhas. "per_campaign" = cada campanha recebe o budget cheio (gasto N×).
  // "split" = budget dividido por N (mantém o gasto total de 1 criativo só).
  const [fase2BudgetSplitMode, setFase2BudgetSplitMode] = useState<"per_campaign" | "split">("per_campaign");
  // L.T (FASE 3 LP) — público Advantage + sugestões de idade/gênero
  const [ltAdvantage, setLtAdvantage] = useState(true);
  // Posicionamentos (placements) — Set de "platform:position" LIGADOS. Default (via useEffect)
  // = todos os válidos do preset = AUTOMÁTICO. Gestor desliga → envia subconjunto explícito.
  const [placementSelected, setPlacementSelected] = useState<Set<string>>(new Set());
  const [placementsExpanded, setPlacementsExpanded] = useState(false);
  // Transparência (DSA): beneficiário/pagador — puxado da conta, fixo, não editável pelo usuário.
  const [suggestedBeneficiary, setSuggestedBeneficiary] = useState("");

  // Scheduling
  const [utmTemplate, setUtmTemplate] = useState(UTM_DEFAULT);
  const [editingUtm, setEditingUtm] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleEndDate, setScheduleEndDate] = useState("");
  const [scheduleEndTime, setScheduleEndTime] = useState("");

  // Identity state
  const [identityPageId, setIdentityPageId] = useState<string | null>(null);
  const [identityPageName, setIdentityPageName] = useState<string | null>(null);
  const [identityIgActorId, setIdentityIgActorId] = useState<string | null>(null);
  const [identityIgUsername, setIdentityIgUsername] = useState<string | null>(null);
  const [identityWhatsappId, setIdentityWhatsappId] = useState<string | null>(null);
  const [identityWhatsappPhone, setIdentityWhatsappPhone] = useState<string | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  const addLog = useCallback((msg: string) => {
    if (logRef.current) logRef.current.add(msg);
    else pendingLogsRef.current.push(msg);
  }, []);

  useEffect(() => { checkMetaStatus(); }, []); // modelos são por conta → carregam no selectedAccount, não no mount
  // Ao entrar no modo "Criar mensagem", limpa a seleção de modelo importado — senão o edge
  // preferiria o importado e ignoraria a mensagem manual (precedência importedTemplateJson
  // no buildFase3Creative). Cobre o toggle E o Editar/Duplicar de templates salvos.
  useEffect(() => {
    if (useCustomMessage) { setSelectedImportedKey(""); setImportedRawJson(""); }
  }, [useCustomMessage]);
  const checkMetaStatus = async () => {
    setMetaLoading(true);
    try {
      // Check sessionStorage cache first to avoid hitting API on every page load
      const cached = sessionStorage.getItem("meta_status_cache");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          const cacheAge = Date.now() - (parsed._cachedAt || 0);
          // Cache valid for 5 minutes
          if (cacheAge < 5 * 60 * 1000 && parsed.connected && parsed.access_token) {
            setAccessToken(parsed.access_token);
            setMetaName(parsed.meta_name || "");
            addLog(`✅ Meta conectado (cache) como ${parsed.meta_name || "usuário"}`);
            setMetaLoading(false);
            return;
          }
        } catch (parseErr) {
          addLog(`⚠️ Cache JSON corrompido, descartando e re-validando contra API...`);
          sessionStorage.removeItem("meta_status_cache");
        }
      }

      addLog("🔍 Verificando conexão Meta...");
      const status = await fetchMetaStatus();
      if (status.connected && status.access_token) {
        setAccessToken(status.access_token);
        setMetaName(status.meta_name || "");
        addLog(`✅ Meta conectado como ${status.meta_name || "usuário"}`);
        if (status.expires_soon) {
          addLog("⚠️ Token Meta expira em breve. Reconecte para evitar interrupções.");
          toast.warning("Token Meta expira em breve. Reconecte nas configurações.");
        }
        // Cache the status
        sessionStorage.setItem("meta_status_cache", JSON.stringify({ ...status, _cachedAt: Date.now() }));
      } else {
        setAccessToken(null);
        setMetaName("");
        sessionStorage.removeItem("meta_status_cache");
        addLog(`❌ Meta não conectado${status.reason ? ` (${status.reason})` : ""}`);
      }
    } catch (err) {
      setAccessToken(null);
      addLog(`❌ Erro ao verificar Meta: ${err instanceof Error ? err.message : "desconhecido"}`);
    } finally {
      setMetaLoading(false);
    }
  };

  useEffect(() => { if (accessToken) loadAdAccounts(); }, [accessToken]);

  // ========== CENTRALIZED ACCOUNT CONTEXT PIPELINE ==========
  // Single sequential pipeline: reset → identity → FASE 3 resources
  // Triggered when selectedAccount changes
  useEffect(() => {
    if (selectedAccount && accessToken) {
      loadAccountContext();
      loadMessageTemplates(selectedAccount); // modelos salvos DESTA conta
    } else {
      setMessageTemplates([]); // sem conta → limpa (senão sobrariam os da conta anterior)
    }
  }, [selectedAccount]);

  // Produtos L.T: se a conta selecionada estiver vinculada a um cliente (aba Clientes),
  // carrega os produtos cadastrados p/ virar dropdown (evita erro de digitação que quebra
  // o match exato com a regra de KPI em optimization-engine.ts).
  useEffect(() => {
    if (!selectedAccount) {
      setLtProducts([]);
      setLtProductsClientId(null);
      return;
    }
    (async () => {
      try {
        const rows = await listClientAdAccounts();
        const row = rows.find(r => r.ad_account_id === selectedAccount);
        if (!row) {
          setLtProducts([]);
          setLtProductsClientId(null);
          return;
        }
        setLtProductsClientId(row.client_id);
        const products = await listClientLtProducts(row.client_id);
        setLtProducts(products.map(p => ({ id: p.id, name: p.product_name })));
      } catch {
        setLtProducts([]);
        setLtProductsClientId(null);
      }
    })();
  }, [selectedAccount]);

  // When preset changes, reload FASE 3 resources if identity is already loaded
  useEffect(() => {
    const p = PRESETS.find(pp => pp.id === preset);
    if (p?.requires_whatsapp && accessToken && identityLoaded && identityPageId) {
      loadFase3Resources(identityPageId);
    }
  }, [preset, identityLoaded, identityPageId]);

  // Invalidate validated payload when any form field changes — EXCETO creatives,
  // que tem useEffect separado abaixo. Motivo: handleValidate grava resultado por-criativo
  // via setCreatives() durante o próprio run, e se "creatives" estivesse aqui, este
  // useEffect dispararia mid-flight e apagaria validationResult (bug do "precisa 2 cliques").
  useEffect(() => {
    setValidatedPayload(null);
    setValidationResult(null);
  }, [selectedAccount, selectedAudience, budget, preset, campaignStructure, distributionStructure,
      selectedCampaign, selectedWhatsappId, greetingText, readyMessage, selectedTemplateId,
      useCustomMessage, scheduleEnabled, scheduleDate, scheduleTime,
      includedLocations, excludedLocations, campaignNameInput, adsetNameInput,
      // L.T: nomenclatura/sufixo compõem o campaign_name (computedCampaignName) — mudar
      // qualquer um invalida o payload validado, senão publish sai com nome desatualizado.
      ltNomenclatura, ltSuffix,
      // Mudar a distribuição de orçamento (FASE 2 COMPLETO) muda o gasto → re-validar obrigatório
      // (senão handlePublish leria o modo antigo do payload validado e publicaria o gasto errado).
      fase2BudgetSplitMode,
      // Mudar posicionamentos muda o adset → re-validar (placementSelected é Set novo a cada toggle).
      placementSelected,
      // Texto "para todos" do modal de copy — não é per-criativo (por isso não está em
      // creativeSignature); mudar sem tocar em nenhum override também invalida o payload.
      captionAll]);

  // Posicionamentos: ao trocar de preset, reseta pra TODOS os válidos ligados (= automático).
  // Cada preset tem um conjunto válido diferente; não faz sentido carregar seleção do preset anterior.
  useEffect(() => {
    const p = PRESETS.find((x) => x.id === preset);
    if (!p) return;
    const kind = placementKindFor(p.destination_type, p.optimization_goal);
    setPlacementSelected(new Set(allPlacementKeys(placementGroupsFor(kind))));
  }, [preset]);

  // Reset validação quando o user MUDA algo visível em criativos (link/type/name/count/caption).
  // NÃO inclui `validation` em si — então gravar resultado de validação não dispara reset.
  const creativeSignature = useMemo(
    () => creatives.map(c => `${c.id}:${c.type}:${c.link}:${c.name}:${c.caption ?? ""}`).join("|"),
    [creatives]
  );
  useEffect(() => {
    setValidatedPayload(null);
    setValidationResult(null);
  }, [creativeSignature]);

  const loadAccountContext = async () => {
    if (!accessToken || !selectedAccount) return;

    // ===== STEP 1: FULL RESET =====
    addLog("🔄 [pipeline] Reset completo do contexto da conta");
    fase3LoadedKeyRef.current = ""; // troca de conta → permite recarregar os recursos FASE 3
    setIdentityPageId(null);
    setIdentityPageName(null);
    setIdentityIgActorId(null);
    setIdentityIgUsername(null);
    setIdentityWhatsappId(null);
    setIdentityWhatsappPhone(null);
    setIdentityLoaded(false);
    setIdentityError(null);
    setIdentityLoading(true);
    // Reset FASE 3 resources
    setWhatsappNumbers([]);
    setSelectedWhatsappId("");
    setWhatsappError(null);
    setSuggestedBeneficiary("");
    setSelectedTemplateId("");
    // Reset audiences
    setAudiences([]);
    setSelectedAudience("");
    setAudienceRows([{ id: nextAudienceRowId(), audienceId: "" }]);
    // Reset validation/publish state
    setValidationResult(null);
    setPublishResult(null);
    setMinBudget(null);
    // Troca de conta invalida validação + media_id resolvido dos criativos (eram do IG da conta
    // anterior). Sem isso o publish (T1#1) injetaria mídia/actor da conta antiga na conta nova.
    // Mantém link/nome/tipo; o usuário re-valida na conta nova (ou o publish escaneia).
    setCreatives(prev => prev.map(c => ({ ...c, validation: undefined, resolved_instagram_media_id: null, resolved_ig_account_id: null })));

    // ===== Identidade: tenta cache por conta (a varredura de páginas é lenta) =====
    let resolvedPageId: string | null = null;
    const IDENTITY_TTL = 60 * 60 * 1000; // 1h
    const identityCacheKey = `identity_cache_v2_${selectedAccount}`;
    let identityFromCache = false;
    try {
      const raw = sessionStorage.getItem(identityCacheKey);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && c.igActorId && Date.now() - (c._cachedAt || 0) < IDENTITY_TTL) {
          setIdentityPageId(c.pageId ?? null);
          setIdentityPageName(c.pageName ?? null);
          setIdentityIgActorId(c.igActorId ?? null);
          setIdentityIgUsername(c.igUsername ?? null);
          setIdentityWhatsappId(c.whatsappId ?? null);
          setIdentityWhatsappPhone(c.whatsappPhone ?? null);
          if (c.dsaBeneficiary) { setSuggestedBeneficiary(c.dsaBeneficiary); }
          setIdentityLoaded(true);
          setIdentityLoading(false);
          resolvedPageId = c.pageId ?? null;
          identityFromCache = true;
          addLog(`⚡ [pipeline] Identidade do cache (conta ${selectedAccount}) — page=${c.pageId}, ig=@${c.igUsername || "?"}`);
        }
      }
    } catch { /* ignore */ }

    // resolveIdentity: MESMA resolução p/ o cache-do-banco e p/ o fetch-da-Meta (senão divergem →
    // page/IG/whatsapp inconsistentes). Recebe igAccounts + dsa_beneficiary (+ diagnostic só p/
    // log/erro). Seta os 6 setIdentity*, re-cacheia na sessão, e RETORNA o pageId resolvido.
    const resolveIdentity = (igAccounts: any[], dsaBeneficiary: string | null, diagnostic: any[] = []): string | null => {
      if (dsaBeneficiary) { setSuggestedBeneficiary(dsaBeneficiary); addLog(`🏷️ [pipeline] Beneficiário da conta (auto-preenchido): ${dsaBeneficiary}`); }
      addLog(`📄 [pipeline] contas IG autorizadas: ${igAccounts.length}`);
      for (const d of diagnostic) {
        addLog(`   🔎 ${d.endpoint} → ${d.status}${d.count !== undefined ? ` (${d.count})` : ""}${d.detail ? ` | ${d.detail}` : ""}`);
      }
      for (const ig of igAccounts) {
        addLog(`   IG: id=${ig.ig_account_id}, @${ig.ig_username || "?"}, page=${ig.page_name || "sem página"}`);
      }

      let foundPageId: string | null = null;
      let foundPageName: string | null = null;
      let foundIgActorId: string | null = null;
      let foundIgUsername: string | null = null;
      let foundWhatsappId: string | null = null;
      let foundWhatsappPhone: string | null = null;

      for (const ig of igAccounts) {
        if (ig.ig_account_id && ig.page_id) {
          foundPageId = ig.page_id;
          foundPageName = ig.page_name;
          foundIgActorId = ig.ig_account_id;
          foundIgUsername = ig.ig_username || null;
          foundWhatsappId = ig.waba_phone_id || null;
          foundWhatsappPhone = ig.waba_phone || null;
          addLog(`✅ [pipeline] IG autorizado: @${foundIgUsername || "?"} (id=${foundIgActorId})`);
          addLog(`✅ [pipeline] página vinculada: ${foundPageName} (id=${foundPageId})`);
          if (foundWhatsappId) {
            addLog(`✅ [pipeline] WhatsApp ID encontrado: ${foundWhatsappId} (${foundWhatsappPhone})`);
          } else {
            addLog(`⚠️ [pipeline] Nenhum WhatsApp vinculado à página ${foundPageId}`);
          }
          break;
        }
      }

      if (!foundIgActorId && igAccounts.length > 0) {
        foundIgActorId = igAccounts[0].ig_account_id;
        foundIgUsername = igAccounts[0].ig_username || null;
        addLog(`⚠️ [pipeline] IG autorizado sem página vinculada: id=${foundIgActorId}`);
      }

      // NÃO usar "primeira página" como fallback — isso causava bug grave
      // (ex: IG @claulopes.personal vinha com page "Jun yamaguchi").
      // Se não casou IG↔Page corretamente, melhor falhar e mostrar diagnóstico.
      if (!foundPageId && foundIgActorId) {
        addLog(`❌ [pipeline] IG @${foundIgUsername} (id=${foundIgActorId}) não casou com nenhuma Page do BM. Possíveis causas: Page sem acesso/permissão pra esse user, IG não vinculado a Page do BM.`);
      }

      setIdentityPageId(foundPageId);
      setIdentityPageName(foundPageName);
      setIdentityIgActorId(foundIgActorId);
      setIdentityIgUsername(foundIgUsername);
      setIdentityWhatsappId(foundWhatsappId);
      setIdentityWhatsappPhone(foundWhatsappPhone);
      setIdentityLoaded(true);

      // Re-cacheia identidade resolvida na sessão (só quando achou IG) p/ próxima vez ser instantâneo.
      if (foundIgActorId) {
        try {
          sessionStorage.setItem(identityCacheKey, JSON.stringify({
            pageId: foundPageId, pageName: foundPageName,
            igActorId: foundIgActorId, igUsername: foundIgUsername,
            whatsappId: foundWhatsappId, whatsappPhone: foundWhatsappPhone,
            dsaBeneficiary: dsaBeneficiary || null,
            _cachedAt: Date.now(),
          }));
        } catch { /* ignore */ }
      }

      if (!foundIgActorId) {
        const diagSummary = diagnostic.map((d: any) => `${d.endpoint}=${d.status}${d.count !== undefined ? `(${d.count})` : ""}${d.detail ? `:${d.detail}` : ""}`).join(" • ");
        setIdentityError(`Nenhuma conta Instagram autorizada encontrada. Tentativas: ${diagSummary || "n/a"}`);
      }
      addLog(`✅ [pipeline] identidade final: page=${foundPageId}, ig_actor=${foundIgActorId}, ig_user=@${foundIgUsername || "N/A"}, whatsapp_id=${foundWhatsappId || "N/A"}, whatsapp_phone=${foundWhatsappPhone || "N/A"}`);
      return foundPageId;
    };

    // ===== Identidade (cache do banco → senão fetch) + Públicos EM PARALELO =====
    // Identidade: kind=identity guarda {ig_accounts, dsa_beneficiary}; se tiver IG, resolve dele
    // SEM chamar a Meta (gate em ig_accounts.length p/ não pinar um "sem IG" cacheado). Senão fetch
    // (o edge grava o cache). Gera resolvedPageId ANTES do loadFase3Resources (whatsapp depende dele).
    const identityWork = identityFromCache ? Promise.resolve() : (async () => {
      try {
        const dbIdentity = await readDiscoveryCache<{ ig_accounts: any[]; dsa_beneficiary: string | null }>("identity", selectedAccount);
        if (dbIdentity && dbIdentity.ig_accounts?.length) {
          addLog(`⚡ [pipeline] Identidade do cache do banco (${dbIdentity.ig_accounts.length} IG) — 0 chamada Meta`);
          resolvedPageId = resolveIdentity(dbIdentity.ig_accounts, dbIdentity.dsa_beneficiary ?? null, []);
        } else {
          addLog(`📡 [pipeline] Buscando contas IG autorizadas para ${selectedAccount}...`);
          const { ig_accounts, diagnostic, dsa_beneficiary } = await fetchIgAccountsForAdAccount(accessToken, selectedAccount);
          resolvedPageId = resolveIdentity(ig_accounts, dsa_beneficiary, diagnostic);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Erro";
        addLog(`❌ [pipeline] Erro ao carregar identidade: ${msg}`);
        setIdentityError(msg);
        setIdentityLoaded(true);
      } finally {
        setIdentityLoading(false);
      }
    })();

    await Promise.all([loadAudiences(), identityWork]);

    // ===== STEPS 4-6 EM PARALELO: (WhatsApp+Templates só FASE 3) + Pixels =====
    // Antes era sequencial com 1.5s de sleep no meio — agora roda tudo junto.
    setSelectedImportedKey("");
    setImportedRawJson("");
    setSelectedPixelId("");

    const tasks: Promise<unknown>[] = [];

    // WhatsApp + modelos de mensagem só existem em FASE 3/ZAP (requires_whatsapp).
    // L.T e demais presets sem WhatsApp NÃO puxam isso — evita o warning de permissão
    // WhatsApp e o scan de templates à toa. Troca de preset é coberta pelo useEffect
    // acima, que também gateia por requires_whatsapp.
    const presetNeedsWhatsapp = PRESETS.find(p => p.id === preset)?.requires_whatsapp ?? false;
    if (resolvedPageId && presetNeedsWhatsapp) {
      tasks.push(loadFase3Resources(resolvedPageId));
    }

    setLoadingPixels(true);
    tasks.push((async () => {
      try {
        // Cache compartilhado (kind=pixels): se houver pixels, usa e NÃO toca na Meta.
        const cachedPx = await readDiscoveryCache<AdPixel[]>("pixels", selectedAccount);
        if (cachedPx) {
          setPixels(cachedPx);
          addLog(`✅ [pixels] ${cachedPx.length} pixel(s) do cache (0 chamada Meta)`);
          return;
        }
        addLog(`📡 [pixels] Carregando pixels da conta...`);
        const list = await fetchPixels(accessToken, selectedAccount);
        setPixels(list);
        addLog(`✅ [pixels] ${list.length} pixel(s) encontrado(s)`);
      } catch (err: unknown) {
        addLog(`⚠️ [pixels] erro: ${err instanceof Error ? err.message : "desconhecido"}`);
        setPixels([]);
      } finally {
        setLoadingPixels(false);
      }
    })());

    await Promise.all(tasks);
  };

  const loadFase3Resources = async (pageId: string) => {
    // Dedup: se já carregamos p/ esta conta|page, pula a 2ª chamada (loadAccountContext + effect
    // disparam ambos na troca de conta). O ref é resetado no FULL RESET (troca de conta) → recarrega.
    const loadKey = `${selectedAccount}|${pageId}`;
    if (fase3LoadedKeyRef.current === loadKey) {
      addLog(`↩️ [pipeline] Recursos FASE 3 já carregados (conta ${selectedAccount}, page ${pageId}) — pulando chamada duplicada`);
      return;
    }
    fase3LoadedKeyRef.current = loadKey;
    addLog(`📡 [pipeline] Carregando recursos FASE 3 (page=${pageId})...`);
    setLoadingImported(true);
    // WhatsApp numbers + modelos de mensagem — ambos SÓ FASE 3/ZAP — em paralelo.
    // pageId resolvido é passado explícito (state pode estar stale).
    await Promise.all([
      loadWhatsappNumbers(pageId),
      (async () => {
        try {
          // Cache compartilhado (kind=imported_templates): se houver modelos, usa e NÃO toca na Meta.
          const cachedT = await readDiscoveryCache<ImportedMetaTemplate[]>("imported_templates", selectedAccount);
          if (cachedT) {
            setImportedTemplates(cachedT);
            addLog(`✅ [imported] ${cachedT.length} modelo(s) do cache (0 chamada Meta). Use "Buscar novamente" p/ atualizar.`);
            return;
          }
          addLog(`📡 [imported] Buscando modelos de mensagem da conta...`);
          const result = await fetchImportedMetaTemplates(accessToken, selectedAccount);
          setImportedTemplates(result.templates);
          addLog(`✅ [imported] ${result.templates.length} modelo(s) extraído(s) (scanned=${result.scanned_adsets}, erros=${result.errors_during_scan})`);
          if (result.error_summary) {
            addLog(`⚠️ [imported] ${result.error_summary}`);
            toast.error("Meta rate-limited. Tente o botão Buscar novamente em alguns segundos.");
          } else if (result.errors_during_scan > 0 && result.error_sample) {
            addLog(`ℹ️ [imported] sample de erro: ${result.error_sample}`);
          }
        } catch (err: unknown) {
          // Erro na busca → NÃO zera modelos (mantém o que tem); usuário ainda pode digitar manual.
          addLog(`⚠️ [imported] erro: ${err instanceof Error ? err.message : "desconhecido"}`);
        } finally {
          setLoadingImported(false);
        }
      })(),
    ]);
    addLog(`✅ [pipeline] Recursos FASE 3 carregados`);
  };

  const goToMetaLogin = () => {
    // sessionStorage pode lançar (modo privado/bloqueado) — NUNCA pode impedir a navegação.
    try { sessionStorage.removeItem("meta_status_cache"); } catch { /* ignore */ }
    const state = crypto.randomUUID();
    try { sessionStorage.setItem("meta_oauth_state", state); } catch { /* ignore */ }
    const url = getMetaLoginUrl(state);
    if (!url) { toast.error("URL de login Meta indisponível. Recarregue a página."); return; }
    // assign() é mais robusto que href= em alguns navegadores/extensões.
    window.location.assign(url);
  };
  const handleConnect = () => {
    addLog("🔐 Iniciando login Meta via redirect OAuth...");
    goToMetaLogin();
  };
  const handleReconnect = () => {
    addLog("🔄 Reconectando Meta via redirect OAuth...");
    goToMetaLogin();
  };

  const handleDisconnect = async () => {
    addLog("🔌 Desconectando conta Meta...");
    try {
      await disconnectMeta();
      // Clear all Meta-related state
      setAccessToken(null);
      setMetaName("");
      setAdAccounts([]);
      setSelectedAccount("");
      setAudiences([]);
      setSelectedAudience("");
      setAudienceRows([{ id: nextAudienceRowId(), audienceId: "" }]);
      setCampaigns([]);
      setSelectedCampaign("");
      setWhatsappNumbers([]);
      setSelectedWhatsappId("");
      setIdentityPageId(null);
      setIdentityPageName(null);
      setIdentityIgActorId(null);
      setIdentityIgUsername(null);
      setIdentityWhatsappId(null);
      setIdentityWhatsappPhone(null);
      setIdentityLoaded(false);
      setIdentityError(null);
      setValidationResult(null);
      setPublishResult(null);
      setCreatives([blankCreative()]);
      addLog("✅ Conta Meta desconectada com sucesso");
      addLog("🧹 Token removido, identidade limpa, estado = desconectado");
      toast.success("Conta Meta desconectada");
    } catch (err) {
      addLog(`❌ Erro ao desconectar: ${err instanceof Error ? err.message : "desconhecido"}`);
      toast.error("Erro ao desconectar conta Meta");
    }
  };

  const loadAdAccounts = async () => {
    if (!accessToken) return;
    // 1) Cache compartilhado no banco (kind=ad_accounts, account=shared): se houver contas,
    //    usa e NÃO toca na Meta (economiza ~37 chamadas/load).
    const cachedAccounts = await readDiscoveryCache<AdAccount[]>("ad_accounts", "shared");
    if (cachedAccounts) {
      setAdAccounts(cachedAccounts);
      addLog(`✅ ${cachedAccounts.length} conta(s) do cache compartilhado (0 chamada Meta). Use "Atualizar" p/ re-buscar.`);
      return;
    }
    // 2) Sem cache: busca da Meta (o edge grava o cache p/ todos).
    setLoadingAdAccounts(true);
    try {
      addLog("📡 Carregando todas as contas de anúncios...");
      const accounts = await fetchAdAccounts(accessToken);
      setAdAccounts(accounts);
      addLog(`✅ ${accounts.length} conta(s) encontrada(s)`);
    } catch (err: unknown) {
      addLog(`❌ Erro ao carregar contas: ${err instanceof Error ? err.message : "Erro"}`);
    } finally {
      setLoadingAdAccounts(false);
    }
  };

  // Botão "Atualizar": re-busca TUDO da Meta ignorando o cache (cada edge regrava o cache
  // compartilhado p/ todos). Sequencial p/ não estourar o rate-limit (#4) da conta em surto.
  const refreshAll = async (account: string) => {
    if (!accessToken) return;
    setLoadingAdAccounts(true);
    try {
      addLog("📡 [atualizar] Re-buscando contas de anúncios na Meta (ignorando cache)...");
      const accounts = await fetchAdAccounts(accessToken, true); // force pula o micro-cache de sessão
      setAdAccounts(accounts);
      addLog(`✅ [atualizar] ${accounts.length} conta(s)`);

      // Recursos da conta atual (sequencial: 1 dependência real é identity→whatsapp; e serial
      // evita o surto de ~6 edges paginando de uma vez, que re-tripa o #4).
      if (account) {
        try { const auds = await fetchAudiences(accessToken, account); setAudiences(auds); addLog(`✅ [atualizar] ${auds.length} público(s)`); } catch (e) { addLog(`⚠️ [atualizar] públicos: ${e instanceof Error ? e.message : "erro"}`); }
        try { const px = await fetchPixels(accessToken, account); setPixels(px); addLog(`✅ [atualizar] ${px.length} pixel(s)`); } catch (e) { addLog(`⚠️ [atualizar] pixels: ${e instanceof Error ? e.message : "erro"}`); }
        try { const ig = await fetchIgAccountsForAdAccount(accessToken, account); if (ig.dsa_beneficiary) setSuggestedBeneficiary(ig.dsa_beneficiary); addLog(`✅ [atualizar] identidade re-buscada (${ig.ig_accounts.length} IG)`); } catch (e) { addLog(`⚠️ [atualizar] identidade: ${e instanceof Error ? e.message : "erro"}`); }
        if (isFase3) {
          try { const r = await fetchImportedMetaTemplates(accessToken, account); setImportedTemplates(r.templates); addLog(`✅ [atualizar] ${r.templates.length} modelo(s)`); } catch (e) { addLog(`⚠️ [atualizar] modelos: ${e instanceof Error ? e.message : "erro"}`); }
          try { const w = await fetchWhatsAppNumbers(accessToken, account, identityPageId || undefined); setWhatsappNumbers(w.numbers); addLog(`✅ [atualizar] ${w.numbers.length} número(s) WhatsApp`); } catch (e) { addLog(`⚠️ [atualizar] whatsapp: ${e instanceof Error ? e.message : "erro"}`); }
        }
      }
      toast.success(`Cache atualizado: ${accounts.length} conta(s).`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      addLog(`❌ [atualizar] erro: ${msg}`);
      toast.error(`Erro ao atualizar: ${msg}`);
    } finally {
      setLoadingAdAccounts(false);
    }
  };

  const loadAudiences = async () => {
    if (!accessToken || !selectedAccount) return;
    // Cache compartilhado (kind=audiences): se houver públicos, usa e NÃO toca na Meta.
    const cachedAuds = await readDiscoveryCache<Audience[]>("audiences", selectedAccount);
    if (cachedAuds) {
      setAudiences(cachedAuds);
      addLog(`✅ ${cachedAuds.length} público(s) do cache (0 chamada Meta)`);
      return;
    }
    setLoadingAudiences(true);
    try {
      addLog(`📡 Carregando públicos da conta ${selectedAccount}...`);
      const auds = await fetchAudiences(accessToken, selectedAccount);
      setAudiences(auds);
      addLog(auds.length ? `✅ ${auds.length} público(s)` : "⚠️ Nenhum público encontrado");
    } catch (err: unknown) {
      addLog(`❌ Erro: ${err instanceof Error ? err.message : "Erro"}`);
    } finally {
      setLoadingAudiences(false);
    }
  };

  const loadCampaigns = async () => {
    if (!accessToken || !selectedAccount) return;
    setLoadingCampaigns(true);
    try {
      addLog(`📡 Carregando campanhas da conta ${selectedAccount}...`);
      const camps = await fetchCampaigns(accessToken, selectedAccount);
      setCampaigns(camps);
      addLog(camps.length ? `✅ ${camps.length} campanha(s)` : "⚠️ Nenhuma campanha encontrada");
    } catch (err: unknown) {
      addLog(`❌ Erro: ${err instanceof Error ? err.message : "Erro"}`);
    } finally {
      setLoadingCampaigns(false);
    }
  };

  const loadWhatsappNumbers = async (explicitPageId?: string) => {
    if (!accessToken) return;
    setLoadingWhatsappNumbers(true);
    setWhatsappNumbers([]);
    setSelectedWhatsappId("");
    setWhatsappError(null);
    try {
      const adAccId = selectedAccount;
      // explicitPageId vem direto da resolução de identidade (state ainda pode estar
      // stale aqui). Sem isso, Strategy 1 (page→WABA, a mais confiável) era pulada.
      const pageId = explicitPageId || identityPageId;
      // Cache compartilhado (kind=whatsapp_numbers): se houver números, usa; senão busca da Meta.
      // Os números do cache passam pela MESMA lógica de seleção abaixo (identidade/seed).
      let nums: WhatsAppNumber[];
      let error_summary: string | undefined;
      const cachedNums = adAccId ? await readDiscoveryCache<WhatsAppNumber[]>("whatsapp_numbers", adAccId) : null;
      if (cachedNums) {
        nums = cachedNums;
        addLog(`✅ ${nums.length} número(s) de WhatsApp do cache (0 chamada Meta)`);
      } else {
        addLog(`📡 Buscando números de WhatsApp (ad_account=${adAccId || "none"}, page_id=${pageId || "none"})...`);
        const res = await fetchWhatsAppNumbers(accessToken, adAccId || undefined, pageId || undefined);
        nums = res.numbers;
        error_summary = res.error_summary;
      }
      setWhatsappNumbers(nums);
      if (nums.length > 0) {
        addLog(`✅ ${nums.length} número(s) de WhatsApp encontrado(s)`);
        // Prefer identity-resolved WhatsApp ID if it matches one of the fetched numbers
        if (identityWhatsappId) {
          const match = nums.find((n: WhatsAppNumber) => n.id === identityWhatsappId);
          if (match) {
            setSelectedWhatsappId(match.id);
            addLog(`📱 WhatsApp auto-selecionado via identidade: ${match.display} (id=${match.id})`);
          } else {
            setSelectedWhatsappId(nums[0].id);
            addLog(`⚠️ WhatsApp da identidade (${identityWhatsappId}) não encontrado na lista. Usando primeiro: ${nums[0].display}`);
          }
        } else {
          setSelectedWhatsappId(nums[0].id);
          if (nums.length === 1) addLog(`📱 Número auto-selecionado: ${nums[0].display}`);
        }
      } else if (identityWhatsappId && identityWhatsappPhone) {
        // Fallback: a resolução de identidade já achou o WhatsApp da página (waba_phone).
        // Usa ele direto mesmo que o fetch dedicado tenha vindo vazio (página pesada,
        // rate limit, ou WABA acessível só pela página da identidade).
        const seeded: WhatsAppNumber = {
          id: identityWhatsappId,
          display: identityWhatsappPhone,
          phone: identityWhatsappPhone,
          page_id: explicitPageId || identityPageId || "",
          page_name: identityPageName || "",
          status: "identity",
          waba_id: "",
        };
        setWhatsappNumbers([seeded]);
        setSelectedWhatsappId(seeded.id);
        addLog(`📱 WhatsApp via identidade: ${seeded.display} (id=${seeded.id})`);
      } else {
        const reason = error_summary || "Não foi possível puxar o número do WhatsApp. Verifique se há um WhatsApp Business vinculado à página/conta no Gerenciador de Negócios da Meta.";
        setWhatsappError(reason);
        addLog(`⚠️ ${reason}`);
      }
    } catch (err: unknown) {
      addLog(`❌ Erro ao buscar WhatsApp: ${err instanceof Error ? err.message : "Erro"}`);
    } finally {
      setLoadingWhatsappNumbers(false);
    }
  };

  const loadMessageTemplates = async (account = selectedAccount) => {
    // Templates são POR CONTA DE ANÚNCIO: sem conta → nenhum; senão filtra ESTRITO por ad_account_id.
    if (!account) { setMessageTemplates([]); return; }
    try {
      addLog(`📡 [modelos] Carregando modelos salvos da conta ${account}...`);
      const { data, error } = await supabase
        .from("message_templates")
        .select("id, name, greeting, ready_message")
        .eq("ad_account_id", account)
        .order("created_at", { ascending: false });
      if (!error && data) {
        setMessageTemplates(data);
        addLog(`✅ [modelos] ${data.length} modelo(s) da conta ${account}`);
      } else {
        addLog(`⚠️ [modelos] Erro ao carregar: ${error?.message || "Desconhecido"}`);
      }
    } catch (err: unknown) {
      addLog(`❌ [modelos] Exceção ao carregar: ${err instanceof Error ? err.message : "desconhecido"}`);
    }
  };

  const handleSaveTemplate = async () => {
    if (!templateName.trim()) { toast.error("Digite um nome para o modelo."); return; }
    if (!selectedAccount) { toast.error("Selecione a conta de anúncios antes de salvar o modelo."); return; }
    setSavingTemplate(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast.error("Faça login primeiro."); return; }
      const { error } = await supabase.from("message_templates").insert({
        user_id: user.id, ad_account_id: selectedAccount, name: templateName.trim(), greeting: greetingText, ready_message: readyMessage,
      });
      if (error) throw error;
      toast.success("Modelo salvo!");
      setTemplateName("");
      loadMessageTemplates();
    } catch (err: unknown) {
      toast.error(`Erro ao salvar: ${err instanceof Error ? err.message : "Erro"}`);
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await supabase.from("message_templates").delete().eq("id", id);
      toast.success("Modelo removido.");
      loadMessageTemplates();
      if (selectedTemplateId === id) setSelectedTemplateId("");
    } catch {}
  };

  const handleSelectTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const tpl = messageTemplates.find(t => t.id === templateId);
    if (tpl) { setGreetingText(tpl.greeting); setReadyMessage(tpl.ready_message); }
    // limpa importado se trocar pra interno
    setSelectedImportedKey("");
    setImportedRawJson("");
  };

  const handleLoadImportedTemplates = async () => {
    if (!selectedAccount) {
      toast.error("Selecione uma conta de anúncios primeiro");
      return;
    }
    if (!accessToken) {
      toast.error("Conexão Meta não disponível");
      return;
    }
    setLoadingImported(true);
    try {
      addLog(`📡 [imported] Buscando modelos de mensagem da conta ${selectedAccount} (ignorando cache)...`);
      const result = await fetchImportedMetaTemplates(accessToken, selectedAccount);
      if (result.templates.length > 0) {
        setImportedTemplates(result.templates); // o edge já regravou o cache do banco p/ os próximos loads
        addLog(`✅ [imported] ${result.templates.length} modelo(s) extraído(s) (scanned=${result.scanned_adsets}, erros=${result.errors_during_scan})`);
      } else if (result.error_summary) {
        // Rate-limit: NÃO zera os modelos atuais nem o cache — só avisa.
        toast.error("Meta rate-limited. Aguarde alguns segundos e tente Buscar novamente.");
        addLog(`⚠️ [imported] ${result.error_summary} (mantendo modelos atuais)`);
      } else {
        // Conta realmente sem modelos.
        setImportedTemplates([]);
        toast.info("Nenhum modelo encontrado nessa conta.");
      }
    } catch (e: any) {
      // Erro → mantém o que tem (não zera).
      toast.error(`Erro ao buscar modelos: ${e.message}`);
      addLog(`❌ [imported] erro: ${e.message}`);
    } finally {
      setLoadingImported(false);
    }
  };

  const handleSelectImportedTemplate = (key: string) => {
    setSelectedImportedKey(key);
    const t = importedTemplates.find(x => x.key === key);
    if (t) {
      setGreetingText(t.welcome_text || "");
      setReadyMessage(t.autofill || "");
      setImportedRawJson(t.raw_json);
      // limpa interno se trocar pra importado
      setSelectedTemplateId("");
    }
  };

  // Creative management
  const addCreative = () => {
    setCreatives(prev => [...prev, blankCreative()]);
  };
  // Bulk: gera N slots de uma vez (cap 1..20; ignora vazio/inválido).
  const addCreativesBulk = () => {
    const raw = Math.floor(Number(bulkCount));
    if (!Number.isFinite(raw) || raw < 1) return;
    const n = Math.min(20, raw);
    setCreatives(prev => [...prev, ...Array.from({ length: n }, () => blankCreative())]);
    setBulkCount("");
  };
  // Colar em massa: lê a área de transferência (2 colunas do Sheets, nome<TAB>link por linha),
  // gera 1 criativo Drive por linha e SUBSTITUI a lista.
  const pasteCreativesFromClipboard = async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast.error("Não consegui ler a área de transferência — copie os nomes e links do Sheets e tente de novo.");
      return;
    }
    // Achata TUDO em células (linhas × TAB), preserva a ordem, dropa vazias. Cobre os 2 formatos:
    // 2 colunas (nome<TAB>link por linha) E coluna única (N nomes depois N links).
    const cells = text.split(/\r?\n/).flatMap(line => line.split("\t")).map(c => c.trim()).filter(Boolean);
    if (cells.length === 0) {
      toast.error("Nada pra colar — copie os nomes e/ou links do Sheets.");
      return;
    }
    // Classifica cada célula por conteúdo: tem URL → links[]; senão → names[]. Ordem preservada.
    const isLink = (s: string) => /https?:\/\/|drive\.google|docs\.google|instagram\.com/i.test(s);
    // Auto-tipo pelo domínio do link: Drive → "drive"; Instagram/qualquer outro → "instagram".
    const detectType = (link: string): CreativeType => (/drive\.google|docs\.google/i.test(link) ? "drive" : "instagram");
    const names: string[] = [];
    const links: string[] = [];
    for (const c of cells) (isLink(c) ? links : names).push(c);

    const hasNames = names.length > 0;
    const hasLinks = links.length > 0;

    // SÓ LINKS colados (o gestor já pôs os nomes na mão): PREENCHE os links nos criativos
    // existentes por ordem, MANTENDO os nomes. Estende se colou mais links que criativos.
    if (hasLinks && !hasNames) {
      setCreatives(prev => {
        const count = Math.max(prev.length, links.length);
        return Array.from({ length: count }, (_, i) => {
          const base = prev[i] ?? blankCreative();
          const link = (links[i] ?? base.link ?? "").trim();
          return { ...base, link, type: link ? detectType(link) : base.type, validation: null };
        });
      });
      toast.success(`${links.length} link(s) colado(s) — nomes mantidos.`);
      return;
    }

    // SÓ NOMES colados: PREENCHE os nomes, MANTENDO os links dos criativos existentes. Estende.
    if (hasNames && !hasLinks) {
      setCreatives(prev => {
        const count = Math.max(prev.length, names.length);
        return Array.from({ length: count }, (_, i) => {
          const base = prev[i] ?? blankCreative();
          return { ...base, name: (names[i] ?? base.name ?? "").trim(), validation: null };
        });
      });
      toast.success(`${names.length} nome(s) colado(s) — links mantidos.`);
      return;
    }

    // NOME + LINK juntos (2 colunas do Sheets) → substitui pela lista pareada (batch fresco).
    const count = Math.max(names.length, links.length);
    if (names.length !== links.length) {
      toast.warning(`${names.length} nome(s), ${links.length} link(s) — pareei por ordem; complete o que faltar.`);
    }
    const paired: CreativeItem[] = Array.from({ length: count }, (_, i) => {
      const link = (links[i] || "").trim();
      return {
        ...blankCreative(),
        name: (names[i] || "").trim(),
        link,
        type: link ? detectType(link) : "instagram",
        validation: null,
      };
    });
    setCreatives(paired);
    toast.success(`${paired.length} criativo(s) colado(s) do Sheets.`);
  };
  const removeCreative = (id: string) => {
    setCreatives(prev => prev.length <= 1 ? prev : prev.filter(c => c.id !== id));
  };
  const updateCreative = (id: string, updates: Partial<CreativeItem>) => {
    setCreatives(prev => prev.map(c => {
      if (c.id !== id) return c;
      // Mudar link/tipo invalida a validação E o media_id resolvido (senão o publish usaria id velho).
      const linkOrTypeChanged = updates.link !== undefined || updates.type !== undefined;
      return {
        ...c,
        ...updates,
        validation: linkOrTypeChanged ? null : c.validation,
        resolved_instagram_media_id: linkOrTypeChanged ? null : c.resolved_instagram_media_id,
        resolved_ig_account_id: linkOrTypeChanged ? null : c.resolved_ig_account_id,
      };
    }));
  };

  // Audience management (mesma mecânica dos criativos)
  const addAudience = () => setAudienceRows(prev => [...prev, { id: nextAudienceRowId(), audienceId: "" }]);
  const removeAudience = (id: string) => setAudienceRows(prev => prev.length <= 1 ? prev : prev.filter(r => r.id !== id));
  const updateAudience = (id: string, audienceId: string) => setAudienceRows(prev => prev.map(r => r.id === id ? { ...r, audienceId } : r));

  const selectedAud = useMemo(() => audiences.find((a) => a.id === selectedAudience), [audiences, selectedAudience]);
  const selectedAudienceName = selectedAud?.name || "";
  const selectedPreset = PRESETS.find(p => p.id === preset)!;
  const isFase3 = selectedPreset.requires_whatsapp;
  const isFase3Lp = selectedPreset.destination_type === "WEBSITE";
  // isFase3Lp = "destino é site" (vale pra fase3-leads-lp E fase3-vendas-lp/L.T).
  // isLt = só o preset Low-Ticket — o naming "[PRODUTO] [L.T] ..." é exclusivo dele.
  const isLt = selectedPreset.id === "fase3-vendas-lp";
  const isFase3VendasZap = selectedPreset.id === "fase3-vendas-zap";
  const isFase2 = selectedPreset.fase === "FASE 2";
  const isFase2Adaptado = selectedPreset.id === "fase2-polones-adaptado";
  // COMPLETO com N>1 criativos → 1 campanha por criativo (único caso que expõe a escolha
  // de divisão de orçamento). ADAPTADO nunca tem N>1.
  const fase2MultiCreative = isFase2 && !isFase2Adaptado && creatives.length > 1;
  const fase2PerCampaignBudget = fase2MultiCreative && fase2BudgetSplitMode === "split"
    ? Number(budget || 0) / creatives.length
    : Number(budget || 0);
  const selectedWhatsapp = whatsappNumbers.find(n => n.id === selectedWhatsappId);

  // Multi-público: FASE 1 (perfil IG) + FASE 3 ZAP (Leads/Vendas). NÃO inclui LP/website (Advantage+).
  const isMultiAud = selectedPreset.destination_type === "INSTAGRAM_PROFILE" || isFase3;

  // ── Posicionamentos (placements) ──
  const placementKind = placementKindFor(selectedPreset.destination_type, selectedPreset.optimization_goal);
  const placementGroups = placementGroupsFor(placementKind);
  const placementAllKeys = allPlacementKeys(placementGroups);
  const placementSelectedCount = placementAllKeys.filter((k) => placementSelected.has(k)).length;
  // L.T com Advantage+ ON → só automático (o backend reconstrói o targeting puro; manual quebraria).
  const placementManualAvailable = !(isFase3Lp && ltAdvantage);
  const togglePlacement = (key: string) => {
    setPlacementSelected((prev) => {
      const next = new Set(prev); // fresh ref: dispara o useEffect de invalidação
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const setPlacementGroup = (keys: string[], on: boolean) => {
    setPlacementSelected((prev) => {
      const next = new Set(prev);
      if (on) keys.forEach((k) => next.add(k)); else keys.forEach((k) => next.delete(k));
      return next;
    });
  };
  // Memoizados (deps: audienceRows/audiences) pra não recalcular O(n·m) a cada keystroke em
  // qualquer campo do form — só quando os públicos/linhas realmente mudam.
  const multiAudIds = useMemo(() => [...new Set(audienceRows.map(r => r.audienceId).filter(Boolean))], [audienceRows]);
  const multiAudNamesList = useMemo(() => multiAudIds.map(id => audiences.find(a => a.id === id)?.name || id), [multiAudIds, audiences]);
  const multiSingleAud = useMemo(() => audiences.find(a => a.id === multiAudIds[0]), [audiences, multiAudIds]);
  const anySavedSelected = useMemo(() => multiAudIds.some(id => audiences.find(a => a.id === id)?.type === "saved"), [multiAudIds, audiences]);
  // Options dos Select memoizados: um array novo a cada render quebra a memo dos filhos (re-render).
  const campaignOptions = useMemo(() => campaigns.map(c => ({ id: c.id, name: c.name })), [campaigns]);
  const ltProductOptions = useMemo(() => ltProducts.map(p => ({ id: p.name, name: p.name })), [ltProducts]);
  // Filtro FASE 2 memoizado: só recalcula quando os públicos ou a busca mudam (não a cada keystroke geral).
  const fase2FilteredAudiences = useMemo(() => {
    const q = fase2Search.trim().toLowerCase();
    return q ? audiences.filter(a => (a.name || "").toLowerCase().includes(q) || a.id.includes(q)) : audiences;
  }, [audiences, fase2Search]);
  // Opções por linha: dedupe entre linhas; com >1 linha só custom (salvo não combina no Meta).
  const audienceOptionsFor = (rowId: string): Audience[] => {
    const restrictCustom = audienceRows.length > 1;
    const thisRow = audienceRows.find(r => r.id === rowId);
    const otherIds = new Set(audienceRows.filter(r => r.id !== rowId).map(r => r.audienceId).filter(Boolean));
    return audiences.filter(a =>
      a.id === thisRow?.audienceId ||
      (!otherIds.has(a.id) && (!restrictCustom || a.type === "custom"))
    );
  };

  // FASE 2 — usa nomes das audiences selecionadas no nome da campanha
  const fase2AudienceNamesList = isFase2
    ? fase2Audiences.map(id => audiences.find(a => a.id === id)?.name || id)
    : [];
  const namingPublicName = isFase2
    ? (fase2AudienceNamesList.length === 1
        ? fase2AudienceNamesList[0]
        : fase2AudienceNamesList.length > 1
          ? `${fase2AudienceNamesList[0]} +${fase2AudienceNamesList.length - 1}`
          : "Multi")
    : isMultiAud
      ? (multiAudNamesList.length === 1
          ? multiAudNamesList[0]
          : multiAudNamesList.length > 1
            ? `${multiAudNamesList[0]} +${multiAudNamesList.length - 1}`
            : "")
    : (isFase3Lp && ltAdvantage ? "Advantage+" : selectedAudienceName);
  // Adaptado leva "ADAPTADO" no nome pra diferenciar do Completo no Gerenciador — mesmos
  // 2 públicos dariam nome idêntico senão (só a estrutura interna difere: 1 conjunto combinado vs N).
  const fase2NamingLabel = isFase2Adaptado ? "FASE 2 ADAPTADO" : selectedPreset.fase;
  const computedCampaignName = campaignStructure === "new" && budget && (isLt ? ltNomenclatura : (namingPublicName || isFase2))
    ? (isLt
        ? generateLtCampaignName({ nomenclatura: ltNomenclatura, presetLabel: selectedPreset.label, structure: distributionStructure, suffix: ltSuffix })
        : generateCampaignName({ presetLabel: isFase2 ? fase2NamingLabel : selectedPreset.fase, publicName: namingPublicName || "Multi", budget: Number(budget), campaignName: campaignNameInput }))
    : null;
  const computedAdsetName = adsetNameInput && (namingPublicName || isFase2)
    ? (isFase2
        ? null  // FASE 2: adset names são gerados no backend por audience
        : generateAdsetName({ publicName: namingPublicName || "Multi", adsetName: adsetNameInput }))
    : null;
  const generatedName = computedCampaignName || "";

  // Slug da página (L.T): último segmento da LP URL em MAIÚSCULO.
  // ex: marianaeiraspersona.com/ddx-12/ → DDX-12
  const slugifyLp = (url: string): string => {
    try {
      const u = url.includes("://") ? url : `https://${url}`;
      const path = new URL(u).pathname.replace(/\/+$/, "");
      return (path.split("/").filter(Boolean).pop() || "").toUpperCase();
    } catch { return ""; }
  };
  const lpSlug = isFase3Lp ? slugifyLp(lpUrl) : "";

  // Preview do nome do conjunto (espelha o backend): [PUBLICO] {WHATS|PAGINA|SLUG} - NomeCriativo
  const previewChanTag = isFase3Lp
    ? (lpSlug || "PAGINA")
    : (selectedPreset.destination_type === "WHATSAPP" ? "WHATS"
      : selectedPreset.destination_type === "INSTAGRAM_PROFILE" ? "IG" : "PAGINA");
  const previewAudTag = (() => {
    if (isMultiAud && multiAudNamesList.length > 0) {
      const joined = multiAudNamesList.join(" + ");
      return (joined.length > 150 ? joined.slice(0, 147) + "..." : joined).trim();
    }
    return (selectedAudienceName || (isFase3Lp && ltAdvantage ? "Advantage+" : "Público")).trim();
  })();
  const previewAdsetName = (creativeName?: string) =>
    creativeName ? `[${previewAudTag}] {${previewChanTag}} - ${creativeName}` : `[${previewAudTag}] {${previewChanTag}}`;

  // Structure descriptions
  const structureDescription = isFase2
    ? isFase2Adaptado
      ? `1 Campanha → 1 Conjunto (${fase2Audiences.length || "N"} públicos combinados) → 1 Anúncio (criativo compartilhado)`
      : creatives.length > 1
        ? `${creatives.length} Campanhas (1 por criativo) → ${fase2Audiences.length || "N"} Conjunto(s) cada — ${fase2BudgetSplitMode === "split" ? `R$${fase2PerCampaignBudget.toFixed(2)}/dia por campanha (orçamento dividido)` : `R$${budget || "0"}/dia por campanha (gasto ${creatives.length}×)`}`
        : `1 Campanha → ${fase2Audiences.length || "N"} Conjunto(s) → 1 Ad/conjunto (criativo compartilhado)`
    : distributionStructure === "CBO"
      ? `1 Campanha → 1 Conjunto → ${creatives.length} Anúncio(s)`
      : `1 Campanha → ${creatives.length} Conjunto(s) → 1 Anúncio/conjunto`;

  const budgetLabel = distributionStructure === "CBO" ? "Orçamento da campanha (R$/dia)" : "Orçamento por conjunto (R$/dia)";

  const fase3Validate = (): { valid: boolean; errors: string[] } => {
    if (!isFase3) return { valid: true, errors: [] };
    const result = validateFase3FieldsHelper({
      selectedWhatsappId,
      useCustomMessage,
      greetingText,
      readyMessage,
      selectedTemplateId,
      selectedImportedKey,
      addLog,
    });
    return { valid: result.valid, errors: result.errors };
  };

  const fase3Valid = () => fase3Validate().valid;

  const fase3LpValidate = (): { valid: boolean; errors: string[] } => {
    if (!isFase3Lp) return { valid: true, errors: [] };
    const errors: string[] = [];
    if (!lpUrl.trim()) errors.push("Cole a URL do site no campo 'URL do site'.");
    else {
      try { new URL(lpUrl); } catch { errors.push("URL inválida — precisa começar com https:// ou http://"); }
    }
    if (!selectedPixelId) errors.push("Selecione um pixel.");
    return { valid: errors.length === 0, errors };
  };

  const fase3LpValid = () => fase3LpValidate().valid;

  const fase3VendasValidate = (): { valid: boolean; errors: string[] } => {
    if (!isFase3VendasZap) return { valid: true, errors: [] };
    const errors: string[] = [];
    if (!selectedPixelId) errors.push("Selecione um pixel para FASE 3 - VENDAS | ZAP.");
    return { valid: errors.length === 0, errors };
  };

  const fase2Validate = (): { valid: boolean; errors: string[] } => {
    if (!isFase2) return { valid: true, errors: [] };
    const errors: string[] = [];
    // Mesma faixa 2-10 pros dois presets — a diferença é estrutural (ADAPTADO combina todos
    // num único conjunto; COMPLETO cria 1 conjunto por público), não na quantidade permitida.
    if (fase2Audiences.length < 2) errors.push("FASE 2 requer no mínimo 2 públicos selecionados.");
    if (fase2Audiences.length > 10) errors.push("FASE 2 aceita no máximo 10 públicos.");
    // ADAPTADO: exatamente 1 criativo (1 conjunto combinado, criativo compartilhado).
    // COMPLETO: N≥1 criativos — cada criativo vira 1 campanha própria (1 campanha por criativo).
    if (isFase2Adaptado) {
      if (creatives.length !== 1) errors.push("FASE 2 exige exatamente 1 criativo (vídeo).");
    } else if (creatives.length < 1) {
      errors.push("FASE 2 exige ao menos 1 criativo (vídeo).");
    }
    // COMPLETO + "dividir orçamento": cada campanha recebe budget/N. Se cair abaixo do mínimo
    // da Meta, bloqueia aqui (senão a Meta rejeita o adset com daily_budget inválido).
    if (!isFase2Adaptado && fase2BudgetSplitMode === "split" && creatives.length > 1) {
      const per = Number(budget || 0) / creatives.length;
      if (minBudget && per < minBudget) {
        errors.push(`Orçamento dividido (R$${per.toFixed(2)}/campanha) fica abaixo do mínimo da Meta (R$${minBudget}). Aumente o orçamento ou use "Orçamento por campanha".`);
      }
    }
    // COMPLETO multi-criativo cria SEMPRE campanhas novas (1 por criativo) — impossível
    // empilhar N campanhas numa existente. Bloqueia (senão a escolha "campanha existente"
    // seria descartada em silêncio e N campanhas novas subiriam mesmo assim).
    if (!isFase2Adaptado && creatives.length > 1 && campaignStructure === "existing") {
      errors.push('FASE 2 com múltiplos criativos sempre cria campanhas novas (1 por criativo). Desmarque "usar campanha existente" ou reduza para 1 criativo.');
    }
    return { valid: errors.length === 0, errors };
  };

  const scheduleValid = () => {
    if (!scheduleEnabled) return true;
    return !!(scheduleDate && scheduleTime);
  };

  const creativesValid = () => {
    return creatives.every(c => c.link.trim() && c.name.trim());
  };

  const identityValidForFase1 = () => {
    if (!selectedPreset.destination_type?.includes("INSTAGRAM")) return true;
    return !!(identityPageId && identityIgActorId && !isNaN(Number(identityIgActorId)));
  };

  const handleValidate = async () => {
    const t0 = performance.now();
    addLog("⏱️ [validate] Início da validação completa");
    setValidatedPayload(null); // Always reset on new validation

    // FASE 2 usa multi-audience (fase2Audiences) em vez de selectedAudience.
    // L.T + Advantage+ não usa público manual (Meta acha sozinho) → dispensa.
    const audienceOk = isFase2
      ? fase2Audiences.length >= 2
      : isMultiAud
        ? multiAudIds.length >= 1
        : (isFase3Lp && ltAdvantage) ? true : !!selectedAudience;
    if (!selectedAccount || !audienceOk || !budget) {
      const missing = [
        !selectedAccount && "conta de anúncios",
        !audienceOk && (isFase2 ? `${fase2Audiences.length}/2 públicos` : "público"),
        !budget && "orçamento",
      ].filter(Boolean).join(", ");
      const msg = `Faltando: ${missing}`;
      addLog(`❌ [validate] ${msg}`);
      toast.error(msg);
      return;
    }
    if (!identityLoaded || identityLoading) {
      toast.error("Aguarde o carregamento da identidade da conta.");
      return;
    }
    if (!identityValidForFase1()) {
      toast.error("Nenhum Instagram Business válido foi carregado para esta conta. FASE 1 requer instagram_actor_id numérico.");
      addLog("❌ Bloqueado: instagram_actor_id inválido ou ausente");
      return;
    }
    if (!creativesValid()) {
      addLog(`❌ [validate] criativos inválidos — verificar nome/link de todos`);
      toast.error("Preencha nome e link de todos os criativos.");
      return;
    }
    const fase3Result = fase3Validate();
    if (!fase3Result.valid) {
      addLog(`❌ [validate] fase3: ${fase3Result.errors.join("; ")}`);
      fase3Result.errors.forEach(err => toast.error(err));
      return;
    }
    const fase3LpResult = fase3LpValidate();
    if (!fase3LpResult.valid) {
      addLog(`❌ [validate] fase3LP: ${fase3LpResult.errors.join("; ")}`);
      fase3LpResult.errors.forEach(err => toast.error(err));
      return;
    }
    const fase3VendasResult = fase3VendasValidate();
    if (!fase3VendasResult.valid) {
      addLog(`❌ [validate] fase3Vendas: ${fase3VendasResult.errors.join("; ")}`);
      fase3VendasResult.errors.forEach(err => toast.error(err));
      return;
    }
    const fase2Result = fase2Validate();
    if (!fase2Result.valid) {
      addLog(`❌ [validate] fase2: ${fase2Result.errors.join("; ")}`);
      fase2Result.errors.forEach(err => toast.error(err));
      return;
    }
    if (!scheduleValid()) {
      addLog(`❌ [validate] schedule: data/hora ausente`);
      toast.error("Preencha data e hora do agendamento.");
      return;
    }
    addLog(`✅ [validate] checks locais passaram — rodando validação estrutural`);
    addLog(`⏱️ [validate] Checagens locais: ${Math.round(performance.now() - t0)}ms`);

    // Validate creatives that haven't been validated yet — IN PARALLEL
    let finalCreatives = creatives;
    const creativesToValidate = creatives.filter(cr => !cr.validation?.ok);
    if (creativesToValidate.length > 0) {
      setValidatingCreative(true);
      const tCr = performance.now();
      addLog(`🔍 [validate] Validando ${creativesToValidate.length} criativo(s) — concorrência 2 + stagger 500ms (${creatives.length - creativesToValidate.length} já validados, pulando)...`);

      // Concorrência 2 + stagger 500ms (runPool): o Drive anônimo é sensível a surto — muitos
      // downloads de uma vez disparam a página anti-abuso do Google (falso "arquivo não público").
      // Menos concorrência = menos surto no Google (e na Meta).
      const validationMap = new Map<string, any>(); // guarda o result completo (inclui resolved_*)
      let hasError = false;
      await runPool(creativesToValidate, 2, async (cr) => {
        const tSingle = performance.now();
        addLog(`🔍 [validate-creative] "${cr.name}" (${cr.type}) — iniciando...`);
        try {
          const result = await validateCreative({
            access_token: accessToken, ad_account_id: selectedAccount, creative_link: cr.link, creative_type: cr.type,
            ig_account_id: identityIgActorId || undefined,
          });
          addLog(`⏱️ [validate-creative] "${cr.name}" — ${Math.round(performance.now() - tSingle)}ms — ${result.ok ? "✅ OK" : `❌ ${result.error}`} (source: ${result.source || "api"})`);
          validationMap.set(cr.id, result);
          if (!result.ok) { toast.error(`Criativo "${cr.name}" inválido`); hasError = true; }
        } catch (e) {
          hasError = true;
          addLog(`❌ [validate-creative] Erro "${cr.name}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }, 500);
      if (isMountedRef.current) {
        setCreatives(prev => prev.map(c => validationMap.has(c.id) ? applyCreativeValidation(c, validationMap.get(c.id)) : c));
      }
      addLog(`⏱️ [validate] Criativos validados em ${Math.round(performance.now() - tCr)}ms`);
      if (isMountedRef.current) {
        setValidatingCreative(false);
      }
      // NÃO bloqueia mais: a falha de validação de criativo (muitas vezes é o rate-limit do Google
      // Drive, NÃO permissão — arquivo público falha falso) vira só AVISO. O publish baixa a mídia
      // por outro caminho (API key/Meta) e é o gate real; se um arquivo for de fato inválido, ele
      // falha por criativo no publish (limpo). Deixa o gestor configurar tudo e publicar direto.
      if (hasError) {
        addLog("⚠️ [validate] Alguns criativos não validaram (provável limite do Google Drive, não permissão) — você PODE publicar mesmo assim; o publish baixa a mídia. Confira os marcados com ✗.");
        toast.warning("Alguns criativos não validaram — pode publicar mesmo assim (o publish baixa a mídia).");
      }

      // Build up-to-date list since React state still holds pre-update snapshot
      finalCreatives = creatives.map(c => validationMap.has(c.id) ? applyCreativeValidation(c, validationMap.get(c.id)) : c);
    } else {
      addLog("⏱️ [validate] Todos os criativos já validados, pulando validação de criativos");
    }

    // === BUILD FULL PAYLOAD (identical to what Publish will send) ===
    setLoading(true);
    setValidationResult(null);
    const tLocal = performance.now();
    addLog("🔍 [validate] Construindo payload completo para validação estrutural...");

    const checks: { label: string; ok: boolean; detail: string }[] = [];
    checks.push({ label: "Access Token", ok: !!accessToken, detail: accessToken ? "presente" : "ausente" });
    checks.push({ label: "Conta de Anúncios", ok: !!selectedAccount, detail: selectedAccount || "ausente" });
    if (isFase2) {
      const audOk = fase2Audiences.length >= 2 && fase2Audiences.length <= 10;
      checks.push({ label: isFase2Adaptado ? "Públicos (ADAPTADO)" : "Públicos (FASE 2)", ok: audOk, detail: `${fase2Audiences.length} público(s) selecionado(s)` });
    } else if (isFase3Lp && ltAdvantage) {
      checks.push({ label: "Público", ok: true, detail: "Advantage+ (Meta define automaticamente)" });
    } else if (isMultiAud) {
      // FASE 1 / FASE 3: público vem de audienceRows (multiAudIds), não de selectedAudience (state morto aqui).
      checks.push({ label: "Público", ok: multiAudIds.length >= 1, detail: `${multiAudIds.length} público(s) selecionado(s)` });
    } else {
      checks.push({ label: "Público", ok: !!selectedAudience, detail: `${selectedAudience} (${selectedAud?.type || "unknown"})` });
    }
    checks.push({ label: "Orçamento", ok: Number(budget) > 0, detail: budget ? `R$${budget}` : "ausente" });
    checks.push({ label: "Nome Gerado", ok: !!generatedName || campaignStructure === "existing", detail: generatedName || (campaignStructure === "existing" ? "campanha existente" : "ausente") });
    checks.push({ label: "Identidade (Página)", ok: !!identityPageId, detail: identityPageName || "ausente" });
    checks.push({ label: "Identidade (Instagram)", ok: !!identityIgActorId, detail: identityIgUsername ? `@${identityIgUsername}` : (identityIgActorId || "ausente") });
    // "Criativos" é INFORMATIVO — NÃO trava o publish. A validação de mídia (Drive/IG) não é o
    // gate: o publish é quem resolve/baixa a mídia e mostra o motivo REAL se falhar de verdade.
    // O ✗ por-criativo continua visível na lista; aqui só avisa, sem derrubar validationResult.valid.
    {
      const okCount = finalCreatives.filter(c => c.validation?.ok).length;
      const failCount = finalCreatives.length - okCount;
      checks.push({
        label: "Criativos",
        ok: true,
        detail: failCount > 0
          ? `${okCount}/${finalCreatives.length} validados — ⚠ ${failCount} não validaram; pode publicar (o publish resolve a mídia e mostra o motivo se falhar)`
          : `${okCount}/${finalCreatives.length} validados`,
      });
    }
    if (isFase3) {
      checks.push({ label: "WhatsApp", ok: !!selectedWhatsappId && !!selectedWhatsapp?.phone, detail: selectedWhatsapp?.display || whatsappError || "não puxado" });
      checks.push({ label: "CTA", ok: true, detail: "WHATSAPP_MESSAGE (automático)" });
      if (useCustomMessage) {
        checks.push({ label: "Saudação", ok: !!greetingText.trim(), detail: greetingText.trim() ? `"${greetingText.substring(0, 30)}..."` : "ausente" });
        checks.push({ label: "Mensagem Pronta", ok: !!readyMessage.trim(), detail: readyMessage.trim() ? `"${readyMessage.substring(0, 30)}..."` : "ausente" });
      } else {
        // Modelo de conversa: importado (selectedImportedKey) OU salvo (selectedTemplateId)
        // OU mensagem preenchida manualmente (greeting+ready).
        const hasMsg = !!selectedImportedKey || !!selectedTemplateId || (!!greetingText.trim() && !!readyMessage.trim());
        const detail = selectedImportedKey
          ? `importado: ${selectedImportedKey}`
          : selectedTemplateId
            ? `salvo: ${selectedTemplateId}`
            : (greetingText.trim() ? "mensagem manual" : "nenhum selecionado");
        checks.push({ label: "Modelo de Conversa", ok: hasMsg, detail });
      }
    }

    // === STRUCTURAL COMPATIBILITY CHECKS (FASE 3) ===
    if (isFase3) {
      // Campaign ↔ AdSet compatibility
      const campaignObj = selectedPreset.objective;
      const adsetOpt = selectedPreset.optimization_goal;
      const adsetDest = selectedPreset.destination_type;
      checks.push({ label: "Campanha → Objetivo", ok: campaignObj === "OUTCOME_LEADS", detail: `${campaignObj} (esperado: OUTCOME_LEADS)` });
      checks.push({ label: "AdSet → optimization_goal", ok: adsetOpt === "CONVERSATIONS", detail: `${adsetOpt} (esperado: CONVERSATIONS)` });
      checks.push({ label: "AdSet → destination_type", ok: adsetDest === "WHATSAPP", detail: `${adsetDest} (esperado: WHATSAPP)` });

      // Attribution: must be 1 day for Leads+WhatsApp+Conversations
      checks.push({ label: "Attribution", ok: true, detail: "CLICK_THROUGH / 1 dia (fixo FASE 3)" });

      // Promoted object CTW: backend usa só { page_id, whatsapp_phone_number }.
      // Telefone vem SEMPRE do número puxado da conta (sem entrada manual).
      const hasPhone = !!(selectedWhatsapp?.phone);
      checks.push({ label: "promoted_object (telefone)", ok: hasPhone, detail: selectedWhatsapp?.phone || whatsappError || "não puxado" });

      addLog(`🔍 [validate] ═══ VALIDAÇÃO ESTRUTURAL FASE 3 ═══`);
      addLog(`🔍 [validate] Campaign: objective=${campaignObj}`);
      addLog(`🔍 [validate] AdSet: optimization_goal=${adsetOpt}, destination_type=${adsetDest}`);
      addLog(`🔍 [validate] Attribution: CLICK_THROUGH / 1 dia`);
      addLog(`🔍 [validate] Promoted Object: page_id=${identityPageId}, whatsapp_id=${identityWhatsappId || selectedWhatsappId}, phone=${selectedWhatsapp?.phone || "N/A"}`);
      addLog(`🔍 [validate] CTA: WHATSAPP_MESSAGE (fixo)`);
      addLog(`🔍 [validate] ═══ FIM VALIDAÇÃO ESTRUTURAL ═══`);
    }

    // Posicionamentos: se manual disponível, exige ao menos 1 ligado (senão adset sem placement).
    if (placementManualAvailable) {
      checks.push({
        label: "Posicionamentos",
        ok: placementSelectedCount > 0,
        detail: placementSelectedCount === placementAllKeys.length
          ? "Automático (todos ligados)"
          : `Manual: ${placementSelectedCount}/${placementAllKeys.length} posições`,
      });
    }

    const allValid = checks.every(c => c.ok);
    addLog(`⏱️ [validate] Checagens completas: ${Math.round(performance.now() - tLocal)}ms`);

    // === BUILD AND STORE THE PUBLISH PAYLOAD ===
    if (allValid) {
      const schedule = buildSchedule();
      const payload: Record<string, unknown> = {
        access_token: accessToken,
        ad_account_id: selectedAccount,
        audience_id: isMultiAud ? (multiAudIds[0] || "") : selectedAudience,
        audience_type: isMultiAud
          ? (multiAudIds.length >= 2 ? "custom" : (multiSingleAud?.type || "custom"))
          : (selectedAud?.type || "custom"),
        audience_name: isMultiAud
          ? (multiAudNamesList[0] || "")
          : (selectedAudienceName || (isFase3Lp && ltAdvantage ? "Advantage+" : "")),
        targeting_spec: isMultiAud
          ? (multiAudIds.length >= 2 ? null : (multiSingleAud?.targeting_spec || null))
          : (selectedAud?.targeting_spec || null),
        creatives: finalCreatives.map(c => ({
          type: c.type, link: c.link, name: c.name,
          // media_id resolvido na validação → o publish reusa e NÃO re-escaneia (só quando existe).
          resolved_instagram_media_id: c.resolved_instagram_media_id || undefined,
          resolved_ig_account_id: c.resolved_ig_account_id || undefined,
          // Copy (Drive): override individual > "texto para todos" > sem texto. Resolvido AQUI
          // (não recalculado no publish) — o publish reusa vp.creatives[i].caption como está.
          caption: resolveCreativeCaption(c, captionAll),
        })),
        creative_link: finalCreatives[0].link,
        creative_type: finalCreatives[0].type,
        creative_name: finalCreatives[0].name,
        budget: Number(budget),
        campaign_name: computedCampaignName || campaignNameInput,
        adset_name: computedAdsetName || adsetNameInput,
        ad_name: finalCreatives[0].name,
        existing_campaign_id: campaignStructure === "existing" ? selectedCampaign : undefined,
        generated_name: generatedName,
        distribution_structure: distributionStructure,
        identity: {
          page_id: identityPageId,
          page_name: identityPageName,
          instagram_actor_id: identityIgActorId,
          instagram_username: identityIgUsername,
          whatsapp_phone_id: identityWhatsappId,
          whatsapp_phone: identityWhatsappPhone,
        },
        preset: {
          objective: selectedPreset.objective,
          optimization_goal: selectedPreset.optimization_goal,
          billing_event: selectedPreset.billing_event,
          bid_strategy: selectedPreset.bid_strategy,
          destination_type: selectedPreset.destination_type,
          default_cta: selectedPreset.default_cta,
          status: selectedPreset.status,
        },
        whatsapp_number: isFase3 ? (selectedWhatsapp?.phone || "") : undefined,
        whatsapp_number_id: isFase3 ? (selectedWhatsappId || undefined) : undefined,
        location_targeting: isFase3 ? buildLocationTargeting() : undefined,
        cta_text: undefined,
        greeting_text: greetingText || undefined,
        ready_message: readyMessage || undefined,
        imported_template_json: importedRawJson || undefined,
        lp_url: selectedPreset.destination_type === "WEBSITE" ? lpUrl : undefined,
        pixel_id: (selectedPreset.destination_type === "WEBSITE" || isFase3VendasZap) ? selectedPixelId : undefined,
        custom_event_type: selectedPreset.destination_type === "WEBSITE"
          ? (selectedPreset.objective === "OUTCOME_SALES" ? "PURCHASE" : "LEAD")
          : (isFase3VendasZap ? "PURCHASE" : undefined),
        fase2_audiences: isFase2 ? fase2Audiences : undefined,
        fase2_audience_names: isFase2
          ? fase2Audiences.map(id => audiences.find(a => a.id === id)?.name || id)
          : undefined,
        // Multi-público FASE 1/FASE 3: N públicos combinados (OR) em 1 conjunto. Só quando >=2;
        // com 1 público o caminho single (audience_id acima) segue idêntico ao antigo.
        audience_ids: (isMultiAud && multiAudIds.length >= 2) ? multiAudIds : undefined,
        audience_names: (isMultiAud && multiAudIds.length >= 2) ? multiAudNamesList : undefined,
        fase2_age_min: isFase2 ? Number(fase2AgeMin) || 18 : undefined,
        fase2_age_max: isFase2 ? Number(fase2AgeMax) || 65 : undefined,
        fase2_genders: isFase2 ? (fase2Gender === "male" ? [1] : fase2Gender === "female" ? [2] : []) : undefined,
        // ADAPTADO: 1 conjunto com os 2 públicos combinados (em vez de N conjuntos, 1 por público).
        // preset.objective/optimization_goal/etc são idênticos ao Completo — sem esta flag o backend
        // não tem como distinguir os dois presets.
        fase2_combined_adset: isFase2 ? isFase2Adaptado : undefined,
        // Divisão de orçamento entre criativos (COMPLETO N>1). Backend NÃO usa este campo — a
        // divisão é feita no frontend por chamada; viaja no payload só p/ handlePublish ler o modo.
        fase2_budget_split_mode: fase2MultiCreative ? fase2BudgetSplitMode : undefined,
        lt_advantage: isFase3Lp ? ltAdvantage : undefined,
        // Posicionamentos: só envia quando MANUAL (subconjunto). Automático (todos ligados) ou
        // L.T Advantage+ ON → undefined = Advantage+ Placements no backend.
        placements: placementManualAvailable ? buildPlacementsObject(placementGroups, placementSelected) : undefined,
        schedule,
        utm_template: utmTemplate.trim() || UTM_DEFAULT,
        // Beneficiário não é editável pelo usuário — backend resolve sozinho via /dsa_recommendations da conta.
      };
      setValidatedPayload(payload);
      addLog("✅ [validate] Payload completo construído e armazenado para publicação");
      addLog(`📋 [validate] campaign_name: ${payload.campaign_name}`);
      addLog(`📋 [validate] adset_name: ${payload.adset_name}`);
      addLog(`📋 [validate] distribution: ${payload.distribution_structure}`);
      addLog(`📋 [validate] budget: R$${payload.budget}`);
      addLog(`📋 [validate] criativos: ${finalCreatives.length}`);
      if (isFase3) {
        addLog(`📋 [validate] FASE 3 payload: whatsapp_number_id=${payload.whatsapp_number_id}, whatsapp_number=${payload.whatsapp_number}`);
        addLog(`📋 [validate] FASE 3 attribution: CLICK_THROUGH / 1 dia (será aplicado no backend)`);
      }

    } else {
      setValidatedPayload(null);
    }

    // Sem pré-voo na Meta: o Validar faz só checks locais + validateCreative por criativo. O
    // pré-voo dry_run criava+deletava campanha/adset de teste = trabalho DOBRADO (o Publicar cria
    // de novo) e piorava o rate-limit (#4). O publish real já limpa a campanha na falha.
    setValidationResult({ valid: allValid, checks });
    if (allValid) {
      addLog("✅ Validação OK — payload pronto para publicação");
      toast.success("Validação OK! Pronto para publicar.");
    } else {
      const failedChecks = checks.filter(c => !c.ok).map(c => c.label).join(", ");
      addLog(`❌ Validação falhou: ${failedChecks}`);
      toast.error(`Validação falhou: ${failedChecks}`);
    }
    setLoading(false);
    addLog(`⏱️ [validate] TOTAL: ${Math.round(performance.now() - t0)}ms`);
  };

  const buildSchedule = () => {
    if (!scheduleEnabled || !scheduleDate || !scheduleTime) return undefined;
    const startIso = new Date(`${scheduleDate}T${scheduleTime}:00`).toISOString();
    let endIso: string | undefined;
    if (scheduleEndDate && scheduleEndTime) {
      endIso = new Date(`${scheduleEndDate}T${scheduleEndTime}:00`).toISOString();
    }
    return { start_time: startIso, end_time: endIso };
  };

  const buildLocationTargeting = () => {
    if (includedLocations.length === 0) return undefined;
    return {
      included: includedLocations.map(l => ({ key: l.key, name: l.name, type: l.type, country_code: l.country_code })),
      excluded: excludedLocations.map(l => ({ key: l.key, name: l.name, type: l.type, country_code: l.country_code })),
    };
  };

  const handlePublish = async () => {
    // === GATE: Require prior validation ===
    if (!validatedPayload) {
      toast.error("Execute a validação antes de publicar.");
      addLog("❌ [publish] Bloqueado: payload não validado. Execute Validar primeiro.");
      return;
    }
    if (!validationResult?.valid) {
      toast.error("Validação não passou. Corrija os erros e valide novamente.");
      addLog("❌ [publish] Bloqueado: última validação falhou.");
      return;
    }

    setLoading(true);
    setPublishing(true); // liga o guard de navegação/beforeunload (finally desliga em todos os caminhos)
    setPublishResult(null);
    addLog(`🚀 [publish] Usando payload previamente validado (NÃO remontando)`);
    addLog(`📋 [publish] Preset: ${selectedPreset.label}`);
    addLog(`📋 [publish] Estrutura: ${distributionStructure}`);
    addLog(`📋 [publish] Criativos: ${creatives.length}`);
    if (isFase3) {
      addLog(`📋 [publish] FASE 3: attribution=CLICK_THROUGH/1d (fixo no backend)`);
    }

    try {
      const vp = validatedPayload as Record<string, unknown>;
      const allCreatives = (Array.isArray(vp.creatives) ? vp.creatives : []) as Array<{ type: string; link: string; name: string; caption?: string }>;

      // Modo lido do PAYLOAD VALIDADO (não do estado do form, que pode ter mudado).
      const isVpFase2 = Array.isArray(vp.fase2_audiences) && (vp.fase2_audiences as string[]).length > 0;
      const isVpFase2Adaptado = vp.fase2_combined_adset === true;

      // === FASE 2 COMPLETO, N>1 criativos → 1 CAMPANHA POR CRIATIVO ===
      // Cada criativo vira sua própria campanha auto-contida: seu vídeo, sua VV50%, seu
      // Balde e seus M conjuntos (um por público). NÃO reusa campanha (ao contrário do
      // loop genérico abaixo, que empilha criativos numa mesma campanha). 1 chamada por
      // criativo porque resolver N vídeos numa única chamada estoura o teto de 150s da
      // edge. ADAPTADO nunca cai aqui (exige exatamente 1 criativo).
      if (isVpFase2 && !isVpFase2Adaptado && allCreatives.length > 1) {
        const total = allCreatives.length;
        const baseName = String(vp.campaign_name || vp.generated_name || "Campaign");
        const nameFor = (i: number) => `${baseName} - ${allCreatives[i].name}`;
        // Orçamento por campanha: "split" divide o budget do form por N (mantém o gasto total
        // de 1 criativo); "per_campaign" manda o budget cheio pra cada campanha (gasto N×).
        // budget é o mesmo knob do backend (ABO: daily_budget por adset; CBO: da campanha).
        const splitBudget = vp.fase2_budget_split_mode === "split";
        const perCampaignBudget = splitBudget && total > 0 ? Number(vp.budget) / total : Number(vp.budget);
        const callFor = (i: number) => {
          const c = allCreatives[i];
          return publishAd({
            ...vp,
            creatives: [c],
            creative_link: c.link, creative_type: c.type, creative_name: c.name, creative_caption: c.caption, ad_name: c.name,
            campaign_name: nameFor(i),
            generated_name: nameFor(i),
            budget: perCampaignBudget, // override do vp.budget (divide no modo split)
            existing_campaign_id: undefined, // cada chamada cria a SUA campanha
          });
        };

        // SERIAL (concorrência 1): cada chamada faz read-modify-write no público "Balde"
        // (recurso compartilhado por conta, sem lock — dedupe é WhatsApp-only). Em paralelo,
        // updates simultâneos se perdem (lost update) e o Balde ganharia MENOS de N vídeos.
        addLog(`🚀 [publish] FASE 2 COMPLETO — ${total} criativos → ${total} campanhas (1 por criativo, serial p/ não corromper o Balde) — orçamento: ${splitBudget ? `dividido, R$${perCampaignBudget.toFixed(2)}/campanha` : `R$${perCampaignBudget.toFixed(2)}/campanha (gasto ${total}×)`}`);

        let rateLimitTripped = false;
        const publishWithRetry = async (thunk: () => Promise<any>, label: string): Promise<any> => {
          let attempt = 0;
          let rlAttempt = 0;
          for (;;) {
            let ri: any, threw = false;
            try { ri = await thunk(); }
            catch (e) { threw = true; ri = { ok: false, _transport: true, error_message: e instanceof Error ? e.message : "erro de transporte" }; }
            if (ri?.ok) return ri;
            if (ri?.warning || ri?.step === "idempotency") return ri;
            const cls = classifyRetry(ri, threw);
            if (cls === "rate_limit") {
              // #4: ESPERA a janela abrir e RETOMA o MESMO criativo. FASE 2 = 1 campanha por criativo;
              // na falha o backend já deletou a campanha desta tentativa (respond ok:false), então
              // re-criar é limpo, sem duplicar. Só desiste (para o lote) ao esgotar o backoff longo.
              if (rlAttempt < RATE_LIMIT_MAX_WAITS) {
                const s = Math.round(RATE_LIMIT_BACKOFF_MS / 1000);
                addLog(`⏳ [publish] ${label} — limite da Meta (#4). Aguardando ${s}s pra retomar (tentativa ${rlAttempt + 1}/${RATE_LIMIT_MAX_WAITS})...`);
                setPublishStatus(`Limite da Meta (#4) atingido — aguardando ${s}s pra retomar o criativo ${label}. Mantenha esta aba ABERTA (o processo roda no navegador).`);
                await sleep(RATE_LIMIT_BACKOFF_MS);
                setPublishStatus(`Retomando criativo ${label}…`);
                rlAttempt++;
                continue;
              }
              rateLimitTripped = true; // esgotou o backoff → para o lote
              return ri;
            }
            if (cls === "fast" && attempt < PUBLISH_BACKOFF.length) {
              const wait = PUBLISH_BACKOFF[attempt] + Math.floor(Math.random() * 800);
              addLog(`⏳ [publish] ${label} transiente — retry em ${Math.round(wait / 1000)}s`);
              attempt++;
              await sleep(wait);
              continue;
            }
            return ri;
          }
        };

        // Retomada por CHAVE DE CONTEÚDO do criativo (name+link), NÃO por identidade do objeto
        // vp: a validação recria vp a cada clique, então comparar por referência perderia o
        // rastro das campanhas já publicadas e as recriaria DUPLICADAS (backend não tem dedupe
        // p/ FASE 2). Regra: nunca republicar um criativo já publicado com sucesso nesta sessão.
        const creativeKey = (c: { name: string; link: string }) => `${c.name} ${c.link}`;
        const prevDone = fase2MultiCampaignRef.current?.campaigns ?? [];
        // chave name+link é única por criativo: o link (URL/shortcode) nunca contém espaço,
        // então o separador " " não gera colisão entre criativos distintos.
        const currentKeys = new Set(allCreatives.map(creativeKey));
        // Só reaproveita campanhas cujo criativo pertence AO batch atual — evita vazar campanhas
        // de um publish anterior não-relacionado pro resultado/contagem deste.
        const done = prevDone.filter(d => currentKeys.has(d.key));
        const publishedKeys = new Set(done.map(d => d.key));
        const pending: number[] = allCreatives.map((_, i) => i).filter(i => !publishedKeys.has(creativeKey(allCreatives[i])));
        if (done.length > 0) addLog(`↻ [publish] ${done.length} campanha(s) já publicada(s) nesta sessão — pulando; ${pending.length}/${total} pendente(s)`);

        const failNames: string[] = [];
        const creativeErrors: { name: string; error: string }[] = [];
        const stillPending: number[] = [];
        await runPool(pending, 1, async (i) => {
          if (rateLimitTripped) { stillPending.push(i); return; }
          setPublishStatus(`Publicando criativo ${i + 1}/${total}…`);
          addLog(`📦 [publish] criativo ${i + 1}/${total} — "${allCreatives[i].name}" (nova campanha)`);
          const ri = await publishWithRetry(() => callFor(i), `${i + 1}/${total}`);
          if (ri?.ok && ri.campaign_id) {
            done.push({ name: allCreatives[i].name, key: creativeKey(allCreatives[i]), campaignId: ri.campaign_id, adsets: ri.adsets_created ?? 0, ads: ri.ads_created ?? 0 });
            addLog(`✅ criativo ${i + 1}/${total} ok — campanha ${ri.campaign_id}`);
          } else {
            const errMsg = ri?.error_user_msg || ri?.error_message || ri?.error || "erro desconhecido";
            failNames.push(allCreatives[i].name);
            creativeErrors.push({ name: allCreatives[i].name, error: errMsg });
            stillPending.push(i);
            if (ri?.logs) for (const l of ri.logs) addLog(`  [${l.step}] ${l.status}${l.detail ? ` — ${l.detail}` : ""}`);
            addLog(`❌ criativo ${i + 1}/${total} falhou: ${errMsg}`);
          }
          // Espaça lote grande (>5): 5s entre criativos reduz quantas vezes bate o #4.
          if (total > 5) await sleep(5000);
        }, 400);
        if (rateLimitTripped) addLog(`🛑 [publish] Limite da Meta (#4) persistente após ~36min de espera — parei. Clique Publicar pra retomar os pendentes.`);

        const campaignIds = done.map(d => d.campaignId);
        const totalAdsets = done.reduce((s, d) => s + d.adsets, 0);
        const totalAds = done.reduce((s, d) => s + d.ads, 0);

        if (stillPending.length === 0) {
          fase2MultiCampaignRef.current = null;
          setPublishResult({ ok: true, campaign_id: campaignIds[0], campaign_ids: campaignIds, adsets_created: totalAdsets, ads_created: totalAds });
          logRef.current?.clear();
          toast.success(`${total} campanhas publicadas (1 por criativo)!`);
          setValidatedPayload(null);
        } else {
          fase2MultiCampaignRef.current = { campaigns: done };
          addLog(`⚠️ Parcial: ${done.length}/${total} campanhas criadas. Falharam: ${failNames.join(", ")}`);
          setPublishResult({ ok: false, step: "partial", campaign_id: campaignIds[0], campaign_ids: campaignIds, adsets_created: totalAdsets, ads_created: totalAds, error_message: `${failNames.length}/${total} criativos falharam`, creative_errors: creativeErrors });
          toast.error(`${failNames.length}/${total} criativos falharam — clique Publicar pra retomar os pendentes.`, { duration: 8000 });
        }
        return;
      }

      // === ORQUESTRAÇÃO: N>1 criativos → 1 chamada por criativo ===
      // Edge function tem teto de 150s + memória limitada; resolver N vídeos numa
      // chamada estoura (OOM/timeout). Quebramos em chamadas pequenas reusando a
      // campanha da 1ª (CBO reusa o adset; ABO cria adset novo por chamada — backend decide).
      // FASE 2 é tratada acima (1 campanha por criativo, sem reuso) — excluída aqui.
      if (allCreatives.length > 1 && !isVpFase2) {
        const total = allCreatives.length;
        const callFor = (idx: number, extra: Record<string, unknown>) => {
          const c = allCreatives[idx];
          return publishAd({ ...vp, creatives: [c], creative_link: c.link, creative_type: c.type, creative_name: c.name, creative_caption: c.caption, ad_name: c.name, ...extra });
        };

        // Lote grande (>5) → serial + delay entre criativos (espaça, reduz o #4). ≤5 → paralelo.
        const publishConcurrency = total > 5 ? 1 : PUBLISH_CONCURRENCY;
        addLog(`🚀 [publish] Orquestrando ${total} criativos (${publishConcurrency === 1 ? "serial + espaçado" : `${PUBLISH_CONCURRENCY} em paralelo`}, auto-retry em transiente/#4)`);

        // Retry: transiente {1,2}/transporte → backoff; rate-limit {4,17,32,341,613} → falha
        // rápido e aciona rateLimitTripped (o pool para de despachar). NUNCA lança (transporte
        // vira ri._transport). warning/idempotency nunca re-tenta. Usado pela 1ª chamada e pelo pool.
        let rateLimitTripped = false;
        const publishWithRetry = async (thunk: () => Promise<any>, label: string, canTrip: boolean): Promise<any> => {
          let attempt = 0;
          let rlAttempt = 0;
          for (;;) {
            let ri: any, threw = false;
            try { ri = await thunk(); }
            catch (e) { threw = true; ri = { ok: false, _transport: true, error_message: e instanceof Error ? e.message : "erro de transporte" }; }
            if (ri?.ok) return ri;
            if (ri?.warning || ri?.step === "idempotency") return ri;
            const cls = classifyRetry(ri, threw);
            if (cls === "rate_limit") {
              // #4: ESPERA a janela abrir e RETOMA o MESMO criativo em vez de parar o lote.
              // 1ª chamada (canTrip=false): na falha o backend deletou a campanha que criou (respond
              // ok:false) → re-criar é limpo. Chamadas seguintes: reusam a campanha; o #4 quase sempre
              // bate na criação do adset (nada criado) → re-tentar é limpo. Só desiste ao esgotar.
              if (rlAttempt < RATE_LIMIT_MAX_WAITS) {
                const s = Math.round(RATE_LIMIT_BACKOFF_MS / 1000);
                addLog(`⏳ [publish] ${label} — limite da Meta (#4). Aguardando ${s}s pra retomar (tentativa ${rlAttempt + 1}/${RATE_LIMIT_MAX_WAITS})...`);
                setPublishStatus(`Limite da Meta (#4) atingido — aguardando ${s}s pra retomar o criativo ${label}. Mantenha esta aba ABERTA (o processo roda no navegador).`);
                await sleep(RATE_LIMIT_BACKOFF_MS);
                setPublishStatus(`Retomando criativo ${label}…`);
                rlAttempt++;
                continue;
              }
              if (canTrip) rateLimitTripped = true; // esgotou → para o pool
              return ri;
            }
            if (cls === "fast" && attempt < PUBLISH_BACKOFF.length) {
              const wait = PUBLISH_BACKOFF[attempt] + Math.floor(Math.random() * 800);
              addLog(`⏳ [publish] ${label} transiente — retry em ${Math.round(wait / 1000)}s`);
              attempt++;
              await sleep(wait);
              continue;
            }
            return ri;
          }
        };

        // Retomada: se este é o mesmo payload validado de uma tentativa anterior
        // que publicou parcialmente, continua da campanha já criada em vez de
        // recomeçar do criativo #1 — recomeçar colidiria com o lock de
        // idempotência do adset e abortaria o retry inteiro, deixando campanha órfã.
        const resume = multiPublishProgressRef.current?.payload === vp ? multiPublishProgressRef.current : null;

        let campaignId: string;
        let firstAdsetId: string | undefined;
        let adsetsCreated: number;
        let adsCreated: number;
        const okNames: string[] = [];
        let pending: number[];

        if (resume) {
          campaignId = resume.campaignId;
          firstAdsetId = resume.adsetId;
          adsetsCreated = resume.adsetsCreated;
          adsCreated = resume.adsCreated;
          okNames.push(...resume.okNames);
          pending = resume.pending;
          addLog(`↻ [publish] Retomando campanha ${campaignId} — ${pending.length}/${total} criativo(s) pendente(s)`);
        } else {
          // 1ª chamada cria a campanha (+ 1º adset/criativo/ad)
          addLog(`📦 [publish] 1/${total} — "${allCreatives[0].name}"`);
          let r1;
          try {
            r1 = await publishWithRetry(() => callFor(0, {}), `1/${total}`, false);
          } catch (e) {
            const msg = e instanceof Error ? e.message : "erro";
            addLog(`❌ 1/${total} falhou (campanha não criada): ${msg}`);
            setPublishResult({ ok: false, step: "request", error_message: msg });
            toast.error("Falha ao criar a campanha (1º criativo).");
            return;
          }
          const isWarning1 = Boolean(r1?.warning || r1?.step === "idempotency");
          if (!r1?.ok) {
            const msg1 = r1?.error_message || r1?.error || "erro";
            if (r1?.logs) for (const l of r1.logs) addLog(`  [${l.step}] ${l.status}${l.detail ? ` — ${l.detail}` : ""}`);
            addLog(`${isWarning1 ? "⚠️" : "❌"} 1/${total} ${isWarning1 ? "bloqueado" : "falhou"}: ${msg1}`);
            setPublishResult(r1);
            if (!r1?.campaign_id) {
              // Nada foi criado (falhou antes/na criação da campanha) — seguro recomeçar do zero.
              if (isWarning1) toast.warning(msg1);
              else toast.error("Falha ao criar a campanha (1º criativo).");
              return;
            }
            // Campanha já existe mas o 1º criativo não foi confirmado (adset/creative/ad
            // falhou) — guarda progresso pra o retry reusar a campanha em vez de duplicá-la.
            multiPublishProgressRef.current = {
              payload: vp,
              campaignId: r1.campaign_id,
              adsetId: r1.adset_id,
              adsetsCreated: r1.adsets_created ?? 0,
              adsCreated: r1.ads_created ?? 0,
              okNames: [],
              pending: Array.from({ length: total }, (_, i) => i),
            };
            toast.warning(isWarning1 ? msg1 : `${msg1} Campanha já criada — clique em Publicar de novo pra retomar sem duplicar.`);
            return;
          }
          campaignId = r1.campaign_id;
          firstAdsetId = r1.adset_id;
          adsetsCreated = r1.adsets_created ?? 1;
          adsCreated = r1.ads_created ?? 1;
          okNames.push(allCreatives[0].name);
          pending = Array.from({ length: total - 1 }, (_, i) => i + 1);
          addLog(`✅ 1/${total} ok — campanha ${campaignId}`);
        }

        // Chamadas restantes — reusa campanha; CBO reusa adset, ABO ignora (cria novo).
        // Rodam em PARALELO (pool de PUBLISH_CONCURRENCY) pra sobrepor a espera de vídeo de
        // cada chamada. A 1ª chamada já criou campanha+adset → sem race de criação.
        const failNames: string[] = [];
        const creativeErrors: { name: string; error: string }[] = [];
        const stillPending: number[] = [];
        await runPool(pending, publishConcurrency, async (i) => {
          if (rateLimitTripped) { stillPending.push(i); return; }
          setPublishStatus(`Publicando criativo ${i + 1}/${total}…`);
          addLog(`📦 [publish] ${i + 1}/${total} — "${allCreatives[i].name}"`);
          const ri = await publishWithRetry(
            () => callFor(i, { existing_campaign_id: campaignId, existing_adset_id: firstAdsetId }),
            `${i + 1}/${total}`, true,
          );
          if (ri?.ok) {
            okNames.push(allCreatives[i].name);
            adsetsCreated += ri.adsets_created ?? 0;
            adsCreated += ri.ads_created ?? 0;
            addLog(`✅ ${i + 1}/${total} ok`);
          } else {
            const errMsg = ri?.error_user_msg || ri?.error_message || ri?.error || "erro desconhecido";
            failNames.push(allCreatives[i].name);
            creativeErrors.push({ name: allCreatives[i].name, error: errMsg });
            stillPending.push(i);
            if (ri?.logs) for (const l of ri.logs) addLog(`  [${l.step}] ${l.status}${l.detail ? ` — ${l.detail}` : ""}`);
            addLog(`❌ ${i + 1}/${total} falhou: ${errMsg}`);
          }
          // Espaça lote grande (>5): 5s entre criativos reduz quantas vezes bate o #4.
          if (total > 5) await sleep(5000);
        }, 400);
        if (rateLimitTripped) addLog(`🛑 [publish] Limite da Meta (#4) persistente após ~36min de espera — parei. Clique Publicar pra retomar os pendentes.`);

        const allOk = stillPending.length === 0;
        if (allOk) {
          setPublishResult({ ok: true, campaign_id: campaignId, adset_id: firstAdsetId, adsets_created: adsetsCreated, ads_created: adsCreated });
          multiPublishProgressRef.current = null;
          logRef.current?.clear();
          toast.success(`${total} criativos publicados com sucesso!`);
          setValidatedPayload(null);
        } else {
          multiPublishProgressRef.current = { payload: vp, campaignId, adsetId: firstAdsetId, adsetsCreated, adsCreated, okNames, pending: stillPending };
          addLog(`⚠️ Parcial: ${okNames.length}/${total} publicados. Falharam: ${failNames.join(", ")}`);
          setPublishResult({ ok: false, step: "partial", campaign_id: campaignId, adset_id: firstAdsetId, adsets_created: adsetsCreated, ads_created: adsCreated, error_message: `${failNames.length}/${total} criativos falharam`, creative_errors: creativeErrors });
          toast.error(`${failNames.length}/${total} criativos falharam — veja o motivo de cada um abaixo do botão Publicar.`, { duration: 8000 });
        }
        return;
      }

      // === Caminho de 1 criativo (inalterado) ===
      // Use the EXACT payload built during validation — no reconstruction
      const result = await publishAd(validatedPayload);
      setPublishResult(result);
      if (result.ok) {
        // Publicação sem erro → limpa o log verboso (confirmação aparece no card abaixo),
        // MAS re-exibe warnings/erros internos (ex: fase2_balde, sanity checks) — senão
        // degradação graciosa (passo falhou mas publish seguiu) fica invisível pro gestor.
        logRef.current?.clear();
        const softIssues = (result.logs || []).filter((l: any) => l.status === "warning" || l.status === "error");
        for (const l of softIssues) addLog(`⚠️ [${l.step}] ${l.detail || l.status}`);
        // Balde (FASE 2) — mostra o resultado mesmo em sucesso (confirmação de negócio,
        // não só warning): gestor precisa saber se o vídeo entrou no público acumulado.
        const baldeOutcome = (result.logs || []).filter((l: any) => l.step === "fase2_balde" && l.status !== "start").pop();
        if (baldeOutcome && baldeOutcome.status === "success") addLog(`🪣 [balde] ${baldeOutcome.detail}`);
        toast.success("Anúncio(s) publicado(s) com sucesso!");
        // Clear validated payload after successful publish
        setValidatedPayload(null);
      } else {
        if (result.logs) {
          for (const l of result.logs) addLog(`  [${l.step}] ${l.status}${l.detail ? ` — ${l.detail}` : ""}`);
        }
        const stepLabel = result.step || "desconhecido";
        const msg = result.error_message || result.error || "Erro desconhecido";
        const isWarning = result.warning || stepLabel === "idempotency";
        addLog(`${isWarning ? "⚠️" : "❌"} Falha no step "${stepLabel}": ${msg}`);
        if (result.error_code != null || result.error_subcode != null) addLog(`   Meta: code=${result.error_code ?? "-"} subcode=${result.error_subcode ?? "-"}`);
        if (result.error_user_title) addLog(`   Título: ${result.error_user_title}`);
        if (result.error_user_msg) addLog(`   Detalhe: ${result.error_user_msg}`);
        if (result.creative_errors?.length) for (const ce of result.creative_errors) addLog(`   ▸ criativo "${ce.name}": ${ce.error}`);
        if (isWarning) toast.warning(msg);
        else toast.error(`Falha (${stepLabel}): ${msg}`.slice(0, 120));
      }
    } catch (err: unknown) {
      const parsed = tryParseError(err);
      if (parsed && (parsed.step || parsed.error_message)) {
        addLog(`❌ Erro estruturado: step="${parsed.step}", msg="${parsed.error_message}"`);
        if (parsed.error_user_title) addLog(`   Título: ${parsed.error_user_title}`);
        if (parsed.error_user_msg) addLog(`   Detalhe: ${parsed.error_user_msg}`);
        if (parsed.logs) {
          for (const l of parsed.logs) addLog(`  [${l.step}] ${l.status}${l.detail ? ` — ${l.detail}` : ""}`);
        }
        setPublishResult({ ok: false, ...parsed });
      } else {
        const msg = err instanceof Error ? err.message : "Erro";
        addLog(`❌ Erro ao publicar: ${msg}`);
        setPublishResult({ ok: false, error_message: msg, step: "request" });
      }
      toast.error("Falha ao publicar");
    } finally {
      setLoading(false);
      setPublishing(false); // desliga o guard de navegação/beforeunload em TODOS os caminhos
      setPublishStatus("");
    }
  };

  if (metaLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Meta Status */}
      <Card className="glass-card p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${accessToken ? "bg-success animate-pulse-glow" : "bg-destructive"}`} />
            <div>
              <span className="font-display font-semibold text-sm">
                {accessToken ? "Meta conectado" : "Meta desconectado"}
              </span>
              {metaName && <p className="text-xs text-muted-foreground">{metaName}</p>}
            </div>
          </div>
          {!accessToken ? (
            <Button onClick={handleConnect} className="gap-2">
              <LogIn className="w-4 h-4" /> Conectar Meta
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={handleReconnect} className="text-xs gap-1">
                <Unplug className="w-3.5 h-3.5" /> Trocar conta
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDisconnect} className="text-xs gap-1 text-destructive hover:text-destructive">
                <LogIn className="w-3.5 h-3.5 rotate-180" /> Desconectar
              </Button>
            </div>
          )}
        </div>
      </Card>

      {accessToken && (
        <>
          {/* Ad Account */}
          <Card className="glass-card p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <Label className="font-display font-semibold text-sm">Conta de Anúncios ({adAccounts.length})</Label>
              <Button
                variant="outline"
                size="sm"
                className="gap-1 text-xs h-8"
                onClick={() => refreshAll(selectedAccount)}
                disabled={loadingAdAccounts}
                title="Re-busca tudo na Meta ignorando o cache e atualiza o cache compartilhado p/ todos. Use quando criar/ganhar acesso a uma conta, público, número novo, etc."
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingAdAccounts ? "animate-spin" : ""}`} /> Atualizar
              </Button>
            </div>
            {loadingAdAccounts && adAccounts.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Carregando contas de anúncios...
              </div>
            ) : (
              <SearchableSelect
                options={adAccounts}
                value={selectedAccount}
                onValueChange={setSelectedAccount}
                placeholder="Selecione a conta"
                searchPlaceholder="Pesquisar por nome ou ID..."
              />
            )}
          </Card>

          {/* Identity */}
          {selectedAccount && (
            <Card className="glass-card p-6 space-y-4">
              <Label className="font-display font-semibold text-sm">Identidade da Conta</Label>
              {identityLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Carregando identidade...
                </div>
              ) : identityLoaded ? (
                identityError && !identityIgActorId ? (
                  <div className="bg-destructive/10 border border-destructive/30 border-l-4 border-l-destructive/60 rounded-md p-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                      <div className="flex-1 space-y-1">
                        <p className="text-xs text-destructive font-medium">Conta sem Instagram Business válido para FASE 1.</p>
                        <p className="text-[10px] text-muted-foreground">{identityError}</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-muted/50 rounded-md p-3 space-y-1">
                    {identityPageName && (
                      <p className="text-xs"><strong>Página:</strong> {identityPageName}</p>
                    )}
                    {identityIgUsername && (
                      <p className="text-xs"><strong>Instagram:</strong> @{identityIgUsername}</p>
                    )}
                    {identityIgActorId && (
                      <IDDisplay id={identityIgActorId} label="IG Actor ID" />
                    )}
                    {!identityIgActorId && (
                      <p className="text-xs text-warning">⚠️ Sem Instagram Business vinculado (FASE 1 bloqueada)</p>
                    )}
                    {/* WhatsApp só é relevante p/ FASE 3. Usa a MESMA fonte do seletor
                        (business WABAs), não a resolução por página — evita "desconexo"
                        (card dizia não-vinculado enquanto o seletor achava os números). */}
                    {isFase3 && (
                      loadingWhatsappNumbers ? (
                        <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Buscando WhatsApp...</p>
                      ) : whatsappNumbers.length > 0 ? (
                        <p className="text-xs"><strong>WhatsApp:</strong> {whatsappNumbers.length} número(s) — ex: {whatsappNumbers[0].phone}</p>
                      ) : (
                        <p className="text-xs text-destructive">⚠️ {whatsappError || "Não foi possível puxar o WhatsApp."}</p>
                      )
                    )}
                  </div>
                )
              ) : null}
            </Card>
          )}

          <Card className="glass-card p-6 space-y-4">
            <Label className="font-display font-semibold text-sm">Preset da Campanha</Label>
            <Select value={preset} onValueChange={(v) => setPreset(v as PresetId)}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione o preset" />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}{p.not_implemented ? " (em breve)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Objetivo: {selectedPreset.objective} | Otimização: {selectedPreset.optimization_goal} | Destino: {selectedPreset.destination_type}
            </p>
            {selectedPreset.not_implemented && (
              <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded-md p-3">
                <p className="text-xs font-medium text-amber-900 dark:text-amber-200">⚠️ Preset em desenvolvimento</p>
                <p className="text-[10px] text-amber-800 dark:text-amber-300 mt-1">
                  Este preset ({selectedPreset.label}) ainda não está implementado no backend. Ainda não publica anúncios. Selecione "FASE 1 - TRÁFEGO" ou "FASE 3 - LEADS | ZAP" para publicar.
                </p>
              </div>
            )}
          </Card>

          {/* Distribution Structure (ABO / CBO) — só pra campanha NOVA.
              Campanha existente herda a estrutura, então o card some. */}
          {campaignStructure === "new" && (
          <Card className="glass-card p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              <Label className="font-display font-semibold text-sm">Estrutura de Distribuição</Label>
            </div>
            <div className="flex gap-2">
              <Button
                variant={distributionStructure === "ABO" ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => setDistributionStructure("ABO")}
              >
                ABO
              </Button>
              <Button
                variant={distributionStructure === "CBO" ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => setDistributionStructure("CBO")}
              >
                CBO
              </Button>
            </div>
            <div className="bg-muted/50 rounded-md p-3 space-y-1">
              <p className="text-xs font-medium text-foreground">
                {distributionStructure === "ABO" ? "Ad Set Budget Optimization" : "Campaign Budget Optimization"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {distributionStructure === "ABO"
                  ? "Orçamento no nível do conjunto. Cada criativo gera 1 conjunto com 1 anúncio."
                  : "Orçamento no nível da campanha. Todos os criativos ficam em 1 conjunto como anúncios separados."}
              </p>
              <Badge variant="outline" className="text-[10px] mt-1">{structureDescription}</Badge>
            </div>
          </Card>
          )}

          {/* Campaign Structure */}
          <Card className="glass-card p-6 space-y-4">
            <Label className="font-display font-semibold text-sm">Campanha</Label>
            <RadioGroup value={campaignStructure} onValueChange={(v) => {
              setCampaignStructure(v as CampaignStructure);
              if (v === "existing" && campaigns.length === 0) loadCampaigns();
            }}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="new" id="camp-new" />
                <Label htmlFor="camp-new" className="flex items-center gap-2 text-sm cursor-pointer">
                  <Plus className="w-4 h-4" /> Criar nova campanha
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="existing" id="camp-existing" />
                <Label htmlFor="camp-existing" className="flex items-center gap-2 text-sm cursor-pointer">
                  <FolderOpen className="w-4 h-4" /> Usar campanha existente
                </Label>
              </div>
            </RadioGroup>

            {campaignStructure === "existing" && (
              <div className="space-y-3 pt-2">
                {loadingCampaigns ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" /> Carregando campanhas...
                  </div>
                ) : campaigns.length > 0 ? (
                  <>
                    <SearchableSelect
                      options={campaignOptions}
                      value={selectedCampaign}
                      onValueChange={(id) => {
                        setSelectedCampaign(id);
                        // Estrutura ditada pela campanha: tem orçamento → CBO, senão ABO.
                        const c = campaigns.find(x => x.id === id);
                        if (c) setDistributionStructure((c.daily_budget || c.lifetime_budget) ? "CBO" : "ABO");
                      }}
                      placeholder="Selecione a campanha"
                      searchPlaceholder="Pesquisar campanha..."
                    />
                    {selectedCampaign && (
                      <p className="text-xs text-muted-foreground">
                        Estrutura da campanha: <strong className="text-primary">{distributionStructure}</strong> (definida pela campanha, não editável)
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Nenhuma campanha ativa encontrada</p>
                )}
              </div>
            )}
          </Card>

          {/* Names */}
          <Card className="glass-card p-6 space-y-4">
            <Label className="font-display font-semibold text-sm">Nomes</Label>
            {campaignStructure === "new" && (
              <div className={isLt ? "space-y-3" : "space-y-2"}>
                {isLt && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-muted-foreground">Nomenclatura</Label>
                    <Input
                      placeholder='Ex: "LDX"'
                      value={ltNomenclatura}
                      onChange={(e) => setLtNomenclatura(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">{isFase3Lp ? "Nome do produto" : "Nome da Campanha"}</Label>
                  {isFase3Lp && ltProducts.length > 0 ? (
                    <SearchableSelect
                      options={ltProductOptions}
                      value={campaignNameInput}
                      onValueChange={setCampaignNameInput}
                      placeholder="Selecione o produto"
                      searchPlaceholder="Pesquisar produto..."
                    />
                  ) : (
                    <Input
                      placeholder={isFase3Lp ? 'Ex: "LDX"' : 'Ex: "Campanha Tráfego - Joelho"'}
                      value={campaignNameInput}
                      onChange={(e) => setCampaignNameInput(e.target.value)}
                    />
                  )}
                </div>
                {isLt && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-muted-foreground">Final do nome (opcional)</Label>
                    <Input
                      placeholder='Ex: "Vídeo 1"'
                      value={ltSuffix}
                      onChange={(e) => setLtSuffix(e.target.value)}
                    />
                  </div>
                )}
                {isFase3Lp && (
                  <p className="text-[10px] text-muted-foreground">
                    Nome final: <span className="font-mono">{computedCampaignName || (isLt ? "[NOMENCLATURA] [L.T] [dd/mm] [ABO] [TESTE] [CRIATIVO] - SUFIXO" : "[PRODUTO] [L.T] [dd/mm] [ABO] [TESTE] [CRIATIVO] -")}</span>
                  </p>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {distributionStructure === "ABO" ? "Prefixo do Conjunto (AdSet)" : "Nome do Conjunto (AdSet)"}
              </Label>
              <Input
                placeholder={distributionStructure === "ABO" ? 'Ex: "Conjunto" (será numerado)' : 'Ex: "Conjunto 01 - Público Frio"'}
                value={adsetNameInput}
                onChange={(e) => setAdsetNameInput(e.target.value)}
              />
              {distributionStructure === "ABO" && creatives.length > 1 && (
                <p className="text-[10px] text-muted-foreground">
                  Cada criativo gerará um conjunto: "{adsetNameInput || "Conjunto"} 01", "{adsetNameInput || "Conjunto"} 02", etc.
                </p>
              )}
            </div>
          </Card>

          {/* Creatives - Multi */}
          <Card className="glass-card p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <Label className="font-display font-semibold text-sm">
                Criativos ({creatives.length})
              </Label>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {!isFase2Adaptado && (
                  <>
                    <div className="flex items-center gap-1">
                      <Label htmlFor="bulk-count" className="text-[10px] text-muted-foreground shrink-0">Quantos?</Label>
                      <Input
                        id="bulk-count"
                        type="number"
                        min={1}
                        max={20}
                        value={bulkCount}
                        onChange={(e) => setBulkCount(e.target.value)}
                        placeholder="N"
                        className="h-8 w-16 text-xs"
                      />
                      <Button variant="outline" size="sm" className="gap-1 text-xs h-8" onClick={addCreativesBulk}>
                        <PlusCircle className="w-3.5 h-3.5" /> Gerar
                      </Button>
                    </div>
                    <Button variant="outline" size="sm" className="gap-1 text-xs h-8" onClick={pasteCreativesFromClipboard} title="Cola nomes e links do Sheets (detecta automaticamente qual é qual e o tipo Drive/IG) — substitui a lista">
                      <Copy className="w-3.5 h-3.5" /> Colar
                    </Button>
                  </>
                )}
                {creatives.some(c => c.type === "drive") && (
                  <Button variant="outline" size="sm" className="gap-1 text-xs" onClick={() => setCopyModalOpen(true)}>
                    <Pencil className="w-3.5 h-3.5" /> Adicionar copy
                  </Button>
                )}
                <Button variant="outline" size="sm" className="gap-1 text-xs" onClick={addCreative}>
                  <PlusCircle className="w-3.5 h-3.5" /> Adicionar criativo
                </Button>
              </div>
            </div>

            {creatives.map((cr, idx) => {
              const borderAccent = cr.validation?.ok
                ? "border-l-success/60"
                : cr.validation && !cr.validation.ok
                ? "border-l-destructive/60"
                : "border-l-primary/40";
              return (
              <div key={cr.id} className={`border border-border/50 border-l-4 ${borderAccent} rounded-lg p-4 space-y-3 relative`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium text-muted-foreground shrink-0">Criativo {idx + 1}</span>
                    {cr.name && (
                      <span className="text-xs text-foreground/70 truncate">— {cr.name}</span>
                    )}
                    {cr.validation?.ok && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success font-medium shrink-0">✓ OK</span>
                    )}
                    {cr.validation && !cr.validation.ok && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive font-medium shrink-0">✗ Erro</span>
                    )}
                  </div>
                  {creatives.length > 1 && (
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => removeCreative(cr.id)}>
                      <X className="w-3.5 h-3.5 text-muted-foreground" />
                    </Button>
                  )}
                </div>

                {/* Name */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Nome do Anúncio</Label>
                  <Input
                    placeholder='Ex: "Anúncio 01 - Dor Joelho"'
                    value={cr.name}
                    onChange={(e) => updateCreative(cr.id, { name: e.target.value })}
                    className="text-sm"
                  />
                </div>

                {/* Type toggle */}
                <div className="flex gap-2">
                  <Button
                    variant={cr.type === "instagram" ? "default" : "outline"}
                    size="sm"
                    className="flex-1 gap-1 text-xs"
                    onClick={() => updateCreative(cr.id, { type: "instagram" })}
                  >
                    <Instagram className="w-3.5 h-3.5" /> Instagram
                  </Button>
                  <Button
                    variant={cr.type === "drive" ? "default" : "outline"}
                    size="sm"
                    className="flex-1 gap-1 text-xs"
                    onClick={() => updateCreative(cr.id, { type: "drive" })}
                  >
                    <HardDrive className="w-3.5 h-3.5" /> Drive
                  </Button>
                </div>

                {/* Link */}
                <div className="flex gap-2">
                  <Input
                    placeholder={cr.type === "instagram" ? "https://instagram.com/..." : "https://drive.google.com/..."}
                    value={cr.link}
                    onChange={(e) => updateCreative(cr.id, { link: e.target.value })}
                    className="flex-1 text-sm"
                  />
                </div>

                {/* Validation feedback */}
                {cr.validation && !cr.validation.ok && (
                  <div className="bg-destructive/10 border border-destructive/30 border-l-4 border-l-destructive/60 rounded-md p-3 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    <p className="text-[10px] text-destructive font-medium flex-1">{cr.validation.error}</p>
                  </div>
                )}
                {cr.validation?.ok && (
                  <div className="bg-success/10 border border-success/30 rounded-md p-2">
                    <p className="text-[10px] text-success font-medium">✅ Validado</p>
                  </div>
                )}
              </div>
              );
            })}
          </Card>

          {/* Modal "Adicionar copy": texto primário pra criativos Drive (Instagram usa a legenda
              do próprio post, sem campo aqui). */}
          <Dialog open={copyModalOpen} onOpenChange={setCopyModalOpen}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Adicionar copy</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 min-w-0">
                <div className="space-y-1.5 min-w-0">
                  <Label className="text-xs text-muted-foreground">Texto para todos</Label>
                  <Textarea
                    placeholder="Texto primário aplicado a todo criativo Drive sem override individual"
                    value={captionAll}
                    onChange={(e) => setCaptionAll(e.target.value)}
                    className="text-sm min-h-20"
                  />
                </div>
                <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                  {creatives.filter(c => c.type === "drive").map((cr) => (
                    <div key={cr.id} className="space-y-1.5 min-w-0">
                      <Label className="text-xs text-muted-foreground truncate block">
                        {cr.name || "Criativo Drive sem nome"}
                      </Label>
                      <Textarea
                        placeholder="Override individual — vazio usa o texto para todos"
                        value={cr.caption ?? ""}
                        onChange={(e) => updateCreative(cr.id, { caption: e.target.value })}
                        className="text-sm min-h-16"
                      />
                    </div>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <Button type="button" onClick={() => setCopyModalOpen(false)}>Concluir</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Audience — single (FASE 1/3) ou multi (FASE 2).
              L.T + Advantage+ esconde a seleção: o Meta acha o público sozinho. */}
          {isFase3Lp && ltAdvantage ? (
            <Card className="glass-card p-6">
              <p className="text-xs text-muted-foreground">
                <strong>Público Advantage+ ativo.</strong> O Meta define o público automaticamente — sem seleção manual. Desative "Público Advantage" no card FASE 3 — Landing Page para escolher um público específico.
              </p>
            </Card>
          ) : (
          <Card className="glass-card p-6 space-y-4">
            <Label className="font-display font-semibold text-sm">
              {isFase2
                ? isFase2Adaptado
                  ? `Públicos (ADAPTADO: ${fase2Audiences.length}/10) ${audiences.length > 0 ? `— ${audiences.length} disponíveis` : ""}`
                  : `Públicos (FASE 2: ${fase2Audiences.length}/10) ${audiences.length > 0 ? `— ${audiences.length} disponíveis` : ""}`
                : isMultiAud
                  ? `Públicos (${multiAudIds.length} selecionado${multiAudIds.length === 1 ? "" : "s"})${audiences.length > 0 ? ` — ${audiences.length} disponíveis` : ""}`
                  : `Público ${audiences.length > 0 ? `(${audiences.length})` : ""}`}
            </Label>
            {loadingAudiences ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {isFase2Adaptado
                    ? "Selecione 2 a 10 públicos — todos serão combinados em 1 único conjunto (mesmo criativo)."
                    : "Selecione 2 a 10 públicos. Cada um vira um conjunto separado, todos com o mesmo criativo."}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                      <Skeleton className="w-4 h-4 rounded" />
                      <Skeleton className="h-3 flex-1" />
                    </div>
                  ))}
                </div>
              </div>
            ) : audiences.length > 0 ? (
              isFase2 ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                  {isFase2Adaptado
                    ? "Selecione 2 a 10 públicos — todos serão combinados em 1 único conjunto (mesmo criativo)."
                    : "Selecione 2 a 10 públicos. Cada um vira um conjunto separado, todos com o mesmo criativo."}
                </p>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      value={fase2Search}
                      onChange={(e) => setFase2Search(e.target.value)}
                      placeholder="Pesquisar público..."
                      className="h-8 pl-7 text-xs"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-muted/20 rounded-lg p-4 max-h-64 overflow-y-auto">
                    {(() => {
                      const list = fase2FilteredAudiences;
                      if (list.length === 0) return <p className="text-xs text-muted-foreground col-span-full text-center py-2">Nenhum público encontrado</p>;
                      return list.map((aud) => {
                      const checked = fase2Audiences.includes(aud.id);
                      const disabled = !checked && fase2Audiences.length >= 10;
                      return (
                        <label key={aud.id} className={`flex items-center gap-2 px-2 py-1.5 rounded border transition-colors ${checked ? "bg-primary/20 border-primary/70 font-semibold shadow-sm ring-1 ring-primary/30" : "border-border"} ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-muted/50 focus-within:ring-2 focus-within:ring-primary/40"}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={(e) => {
                              if (e.target.checked) setFase2Audiences([...fase2Audiences, aud.id]);
                              else setFase2Audiences(fase2Audiences.filter(x => x !== aud.id));
                            }}
                            className="shrink-0"
                          />
                          <span className="text-xs truncate">{aud.name}</span>
                        </label>
                      );
                    });
                    })()}
                  </div>
                  {fase2Audiences.length > 0 && fase2Audiences.length < 2 && (
                    <p className="text-[10px] text-warning">FASE 2 requer no mínimo 2 públicos.</p>
                  )}

                  {/* Segmentação manual: idade + gênero (sem sugestão automática) */}
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Idade mín.</Label>
                      <Input type="number" min={13} max={65} value={fase2AgeMin} onChange={(e) => setFase2AgeMin(e.target.value)} className="h-8 text-xs" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Idade máx.</Label>
                      <Input type="number" min={13} max={65} value={fase2AgeMax} onChange={(e) => setFase2AgeMax(e.target.value)} className="h-8 text-xs" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">Gênero</Label>
                      <Select value={fase2Gender} onValueChange={(v) => setFase2Gender(v as "all" | "male" | "female")}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Todos</SelectItem>
                          <SelectItem value="male">Homens</SelectItem>
                          <SelectItem value="female">Mulheres</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">Segmentação manual — sem expansão/sugestão automática do Meta.</p>
                </div>
              ) : isMultiAud ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">Selecione um ou mais públicos — todos combinados (OR) em 1 conjunto.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1 text-xs"
                      disabled={anySavedSelected}
                      title={anySavedSelected ? "Público salvo não pode ser combinado com outros" : undefined}
                      onClick={addAudience}
                    >
                      <PlusCircle className="w-3.5 h-3.5" /> Adicionar público
                    </Button>
                  </div>
                  {audienceRows.map((row) => (
                    <div key={row.id} className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <SearchableSelect
                          options={audienceOptionsFor(row.id)}
                          value={row.audienceId}
                          onValueChange={(v) => updateAudience(row.id, v)}
                          placeholder="Selecione o público"
                          searchPlaceholder="Pesquisar público por nome..."
                        />
                      </div>
                      {audienceRows.length > 1 && (
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => removeAudience(row.id)}>
                          <X className="w-3.5 h-3.5 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                  ))}
                  {anySavedSelected && audienceRows.length === 1 && (
                    <p className="text-[10px] text-muted-foreground">Público salvo não pode ser combinado com outros — remova-o para adicionar mais de um.</p>
                  )}
                </div>
              ) : (
                <SearchableSelect
                  options={audiences}
                  value={selectedAudience}
                  onValueChange={setSelectedAudience}
                  placeholder="Selecione o público"
                  searchPlaceholder="Pesquisar público por nome..."
                />
              )
            ) : selectedAccount ? (
              <div className="bg-muted/30 rounded-lg p-6 text-center space-y-3">
                <AlertTriangle className="w-8 h-8 mx-auto text-muted-foreground opacity-60" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">Nenhum público encontrado</p>
                  <p className="text-xs text-muted-foreground">Verifique se a conta Meta tem públicos configurados no Gerenciador de Anúncios</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Selecione uma conta primeiro</p>
            )}
          </Card>
          )}


          {/* Budget */}
          <Card className="glass-card p-6 space-y-4">
            <Label className="font-display font-semibold text-sm">{budgetLabel}</Label>
            <Input
              type="number"
              placeholder="50"
              min="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              disabled={loading}
            />
            {minBudget && (
              <p className="text-xs font-medium text-warning">
                Mínimo permitido pelo Meta: R$ {minBudget}
              </p>
            )}
            {!isFase2 && distributionStructure === "ABO" && creatives.length > 1 && (
              <p className="text-[10px] text-muted-foreground">
                Cada conjunto terá R$ {budget || "0"}/dia × {creatives.length} conjuntos = R$ {(Number(budget || 0) * creatives.length).toFixed(2)}/dia total
              </p>
            )}
            {/* FASE 2 COMPLETO N>1: 1 campanha por criativo → escolha de distribuição do orçamento */}
            {fase2MultiCreative && (
              <div className="space-y-2 pt-1 border-t border-border/40">
                <Label className="text-xs font-medium">Orçamento entre os {creatives.length} criativos</Label>
                <RadioGroup
                  value={fase2BudgetSplitMode}
                  onValueChange={(v) => setFase2BudgetSplitMode(v as "per_campaign" | "split")}
                  className="gap-2"
                >
                  <div className="flex items-start space-x-2">
                    <RadioGroupItem value="per_campaign" id="f2budget-per" className="mt-0.5" disabled={loading} />
                    <Label htmlFor="f2budget-per" className="text-xs cursor-pointer leading-tight font-normal">
                      <span className="font-medium">Orçamento por campanha</span>{" "}
                      <span className="text-muted-foreground">(recomendado)</span>
                      <span className="block text-[10px] text-muted-foreground">
                        Cada criativo recebe R$ {budget || "0"}/dia — gasto total {creatives.length}×.
                      </span>
                    </Label>
                  </div>
                  <div className="flex items-start space-x-2">
                    <RadioGroupItem value="split" id="f2budget-split" className="mt-0.5" disabled={loading} />
                    <Label htmlFor="f2budget-split" className="text-xs cursor-pointer leading-tight font-normal">
                      <span className="font-medium">Dividir orçamento entre criativos</span>
                      <span className="block text-[10px] text-muted-foreground">
                        R$ {budget || "0"}/dia ÷ {creatives.length} = R$ {(Number(budget || 0) / creatives.length).toFixed(2)}/dia por campanha.
                      </span>
                    </Label>
                  </div>
                </RadioGroup>
                {fase2BudgetSplitMode === "split" && minBudget && (Number(budget || 0) / creatives.length) < minBudget && (
                  <p className="text-[10px] text-warning font-medium">
                    R$ {(Number(budget || 0) / creatives.length).toFixed(2)}/campanha fica abaixo do mínimo da Meta (R$ {minBudget}). Aumente o orçamento.
                  </p>
                )}
              </div>
            )}
          </Card>

          {/* ============ FASE 3 EXTRA FIELDS ============ */}
          {isFase3 && (
            <Card className="glass-card p-6 space-y-5 border-accent/50 bg-accent/5 glow-accent relative">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-6 h-6 text-accent" />
                <div className="flex flex-col">
                  <Label className="font-display font-semibold text-sm">Configurações FASE 3 — WhatsApp</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Integração WhatsApp para automação de vendas</p>
                </div>
              </div>

              <WhatsAppNumberSelector
                numbers={whatsappNumbers}
                loading={loadingWhatsappNumbers}
                selectedId={selectedWhatsappId}
                onSelect={setSelectedWhatsappId}
                errorReason={whatsappError}
                onRetry={() => loadWhatsappNumbers(identityPageId || undefined)}
              />

              {/* FASE 3 VENDAS ZAP — pixel + evento PURCHASE */}
              {isFase3VendasZap && (
                <>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground">Pixel da Meta (obrigatório)</Label>
                      {loadingPixels && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                    </div>
                    {pixels.length > 0 ? (
                      <Select value={selectedPixelId} onValueChange={setSelectedPixelId}>
                        <SelectTrigger><SelectValue className="text-muted-foreground" placeholder={`${pixels.length} pixel(s) — selecione`} /></SelectTrigger>
                        <SelectContent>
                          {pixels.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name} <span className="text-muted-foreground text-[10px]">({p.id})</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-[10px] text-muted-foreground italic">
                        {loadingPixels ? "Carregando pixels..." : "Nenhum pixel encontrado nesta conta. Crie no Gerenciador de Eventos da Meta primeiro."}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Evento de conversão</Label>
                    <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
                      <p className="text-sm font-medium">PURCHASE</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Otimizado para o evento "Compra" (Purchase) do pixel selecionado</p>
                    </div>
                  </div>
                </>
              )}

              {/* CTA — fixo pelo preset */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">CTA — Call to Action</Label>
                <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
                  <p className="text-sm font-medium">Enviar mensagem pelo WhatsApp</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Definido automaticamente pelo preset FASE 3</p>
                </div>
              </div>

              <WhatsAppMessages
                greetingText={greetingText}
                readyMessage={readyMessage}
                useCustomMessage={useCustomMessage}
                selectedTemplateId={selectedTemplateId}
                messageTemplates={messageTemplates}
                templateName={templateName}
                savingTemplate={savingTemplate}
                importedTemplates={importedTemplates}
                loadingImported={loadingImported}
                selectedImportedKey={selectedImportedKey}
                onLoadImported={handleLoadImportedTemplates}
                onSelectImported={handleSelectImportedTemplate}
                onGreetingChange={setGreetingText}
                onReadyMessageChange={setReadyMessage}
                onUseCustomMessageChange={setUseCustomMessage}
                onSelectTemplate={handleSelectTemplate}
                onTemplateName={setTemplateName}
                onSaveTemplate={handleSaveTemplate}
                onDeleteTemplate={handleDeleteTemplate}
                onEditTemplate={(tpl) => {
                  setGreetingText(tpl.greeting);
                  setReadyMessage(tpl.ready_message);
                  setTemplateName(tpl.name);
                  setUseCustomMessage(true);
                }}
                onDuplicateTemplate={(tpl) => {
                  setGreetingText(tpl.greeting);
                  setReadyMessage(tpl.ready_message);
                  setTemplateName(`${tpl.name} (cópia)`);
                  setUseCustomMessage(true);
                }}
              />
            </Card>
          )}

          {/* ============ FASE 3 LP EXTRA FIELDS ============ */}
          {isFase3Lp && (
            <Card className="glass-card p-6 space-y-5 border-accent/30">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-5 h-5 text-accent" />
                <Label className="font-display font-semibold text-sm">Configurações FASE 3 — Landing Page</Label>
              </div>

              {/* URL do site */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">URL do site (obrigatório)</Label>
                <Input
                  type="url"
                  placeholder="https://seusite.com.br/lp"
                  value={lpUrl}
                  onChange={(e) => setLpUrl(e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">A URL pra onde o anúncio leva quando o usuário clica.</p>
              </div>

              {/* Pixel selector */}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Pixel da Meta (obrigatório)</Label>
                  {loadingPixels && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                </div>
                {pixels.length > 0 ? (
                  <Select value={selectedPixelId} onValueChange={setSelectedPixelId}>
                    <SelectTrigger><SelectValue className="text-muted-foreground" placeholder={`${pixels.length} pixel(s) — selecione`} /></SelectTrigger>
                    <SelectContent>
                      {pixels.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} <span className="text-muted-foreground text-[10px]">({p.id})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-[10px] text-muted-foreground italic">
                    {loadingPixels ? "Carregando pixels..." : "Nenhum pixel encontrado nesta conta. Crie um pixel no Gerenciador de Eventos da Meta primeiro."}
                  </p>
                )}
              </div>

              {/* CTA fixo */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">CTA — Call to Action</Label>
                <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
                  <p className="text-sm font-medium">Saiba mais (LEARN_MORE)</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Definido automaticamente pelo preset FASE 3 LP</p>
                </div>
              </div>

              {/* Evento de conversão fixo */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Evento de conversão</Label>
                <div className="bg-muted/50 border border-border rounded-md px-3 py-2">
                  <p className="text-sm font-medium">{selectedPreset.objective === "OUTCOME_SALES" ? "PURCHASE" : "LEAD"}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {selectedPreset.objective === "OUTCOME_SALES"
                      ? "Otimizado para o evento \"Compra\" (Purchase) do pixel selecionado"
                      : "Otimizado para o evento \"Lead\" do pixel selecionado"}
                  </p>
                </div>
              </div>

              {/* Público Advantage */}
              <div className="space-y-3 pt-1 border-t border-border/40">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <Label className="text-xs font-medium">Público Advantage</Label>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      A Meta acha o público sozinha (idade, gênero e interesses).
                    </p>
                  </div>
                  <Switch checked={ltAdvantage} onCheckedChange={setLtAdvantage} disabled={loading} />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {ltAdvantage
                    ? "Advantage ON — a Meta encontra o público automaticamente (recomendado)."
                    : "Advantage OFF — selecione o público manualmente na seção de público acima."}
                </p>
              </div>
            </Card>
          )}

          {/* ============ SCHEDULING ============ */}
          <Card className="glass-card p-6 space-y-4">
            <div className="flex items-center gap-3">
              <Checkbox id="schedule-toggle" checked={scheduleEnabled} onCheckedChange={(c) => setScheduleEnabled(!!c)} />
              <Label htmlFor="schedule-toggle" className="font-display font-semibold text-sm flex items-center gap-2 cursor-pointer">
                <Calendar className="w-4 h-4" /> Agendar início da campanha
              </Label>
            </div>
            {scheduleEnabled && (
              <div className="space-y-4 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Data de início</Label>
                    <Input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} disabled={loading} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> Hora</Label>
                    <Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} disabled={loading} />
                  </div>
                </div>
                <Separator className="opacity-30" />
                <p className="text-[10px] text-muted-foreground">Data de término (opcional)</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Data de término</Label>
                    <Input type="date" value={scheduleEndDate} onChange={(e) => setScheduleEndDate(e.target.value)} disabled={loading} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Hora de término</Label>
                    <Input type="time" value={scheduleEndTime} onChange={(e) => setScheduleEndTime(e.target.value)} disabled={loading} />
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* ============ Posicionamentos ============ */}
          <Card className="glass-card p-6 space-y-3">
            <button
              type="button"
              onClick={() => setPlacementsExpanded((v) => !v)}
              className="w-full flex items-center justify-between gap-3"
            >
              <div className="text-left">
                <Label className="font-display font-semibold text-sm cursor-pointer">Posicionamentos</Label>
                <p className="text-[10px] text-muted-foreground">
                  {!placementManualAvailable
                    ? "Advantage+ ligado — posicionamentos automáticos (Meta define)"
                    : placementSelectedCount === placementAllKeys.length
                      ? "Automático (Advantage+) — todos ligados, melhor entrega"
                      : `Manual — ${placementSelectedCount} de ${placementAllKeys.length} posições`}
                </p>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${placementsExpanded ? "rotate-180" : ""}`} />
            </button>

            {placementsExpanded && (
              !placementManualAvailable ? (
                <p className="text-xs text-muted-foreground">
                  Com o Advantage+ ligado no L.T, a Meta escolhe os posicionamentos automaticamente.
                  Desligue o Advantage+ (na seção de público) para selecionar posicionamentos manualmente.
                </p>
              ) : (
                <div className="space-y-3">
                  {placementSelectedCount < placementAllKeys.length && (
                    <p className="text-[10px] text-warning flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      Posicionamentos manuais podem reduzir a entrega. Deixe todos ligados (automático) se não tiver certeza.
                    </p>
                  )}
                  {placementSelectedCount === 0 && (
                    <p className="text-[10px] text-destructive">Selecione ao menos um posicionamento (ou ligue todos = automático).</p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setPlacementSelected(new Set(placementAllKeys))}
                    disabled={loading || placementSelectedCount === placementAllKeys.length}
                  >
                    Ligar todos (automático)
                  </Button>
                  {placementGroups.map((g) => {
                    const groupKeys = g.positions.map((p) => placementKey(g.platform, p.key));
                    const allOn = groupKeys.every((k) => placementSelected.has(k));
                    return (
                      <div key={g.platform} className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`plc-grp-${g.platform}`}
                            checked={allOn}
                            onCheckedChange={() => setPlacementGroup(groupKeys, !allOn)}
                            disabled={loading}
                          />
                          <Label htmlFor={`plc-grp-${g.platform}`} className="text-xs font-semibold cursor-pointer">{g.label}</Label>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 pl-6">
                          {g.positions.map((p) => {
                            const k = placementKey(g.platform, p.key);
                            return (
                              <label key={k} className="flex items-center gap-2 cursor-pointer">
                                <Checkbox checked={placementSelected.has(k)} onCheckedChange={() => togglePlacement(k)} disabled={loading} />
                                <span className="text-xs">{p.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </Card>

          {/* ============ UTMs ============ */}
          <Card className="glass-card p-6 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label className="font-display font-semibold text-sm">UTMs (parâmetros de rastreio)</Label>
              {!editingUtm ? (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={() => setEditingUtm(true)} disabled={loading}>
                  <Pencil className="w-3.5 h-3.5" /> Editar
                </Button>
              ) : (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={() => setUtmTemplate(UTM_DEFAULT)} disabled={loading}>
                  <X className="w-3.5 h-3.5" /> Restaurar padrão
                </Button>
              )}
            </div>
            {editingUtm ? (
              <div className="space-y-2">
                <Textarea
                  value={utmTemplate}
                  onChange={(e) => setUtmTemplate(e.target.value)}
                  rows={4}
                  className="text-xs font-mono"
                  placeholder={UTM_DEFAULT}
                  disabled={loading}
                />
                <p className="text-[10px] text-muted-foreground">
                  Query string aplicada no <span className="font-mono">url_tags</span> do criativo. Macros do Meta: <span className="font-mono">{"{{campaign.name}}"}</span>, <span className="font-mono">{"{{adset.id}}"}</span>, <span className="font-mono">{"{{ad.name}}"}</span>, <span className="font-mono">{"{{placement}}"}</span>. Vazio = padrão.
                </p>
              </div>
            ) : (
              <p className="text-xs font-mono text-muted-foreground break-all bg-muted/30 rounded p-2">{utmTemplate.trim() || UTM_DEFAULT}</p>
            )}

            <Separator className="opacity-20" />
            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground">Beneficiário e pagador (transparência)</Label>
              <p className="text-sm bg-muted/30 rounded p-2">
                {suggestedBeneficiary || identityPageName || "—"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {suggestedBeneficiary
                  ? "Anunciante verificado da conta. Enviado automaticamente à Meta (exigido para os anúncios rodarem). Fixo — não editável."
                  : "Quem aparece como anunciante na Biblioteca de Anúncios. Puxado automaticamente da conta quando disponível."}
              </p>
            </div>
          </Card>

          {/* Summary */}
          {(computedCampaignName || computedAdsetName || creatives.some(c => c.name) || isFase3) && (
            <Card className="glass-card p-4 glow-primary">
              <div className="space-y-3">
                <Label className="font-display text-xs text-muted-foreground mb-1 block">Resumo</Label>

                {/* Seção 1: Estrutura */}
                <div>
                  <p className="text-[10px] font-semibold text-foreground mb-1">Estrutura</p>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[10px]">{selectedPreset.label}</Badge>
                      <Badge variant="outline" className="text-[10px]">{distributionStructure}</Badge>
                      <Badge variant="secondary" className="text-[10px]">{structureDescription}</Badge>
                    </div>
                  </div>
                </div>

                <Separator className="opacity-20" />

                {/* Seção 2: Campanha */}
                <div>
                  <p className="text-[10px] font-semibold text-foreground mb-1">Campanha</p>
                  <div className="space-y-1">
                    {campaignStructure === "new" && computedCampaignName && (
                      <p className="text-xs font-mono text-primary break-all">{computedCampaignName}</p>
                    )}
                    {campaignStructure === "existing" && selectedCampaign && (
                      <p className="text-xs font-mono text-muted-foreground break-all">{campaigns.find(c => c.id === selectedCampaign)?.name || selectedCampaign}</p>
                    )}
                  </div>
                </div>

                <Separator className="opacity-20" />

                {/* Seção 3: Anúncios/Conjuntos */}
                <div>
                  <p className="text-[10px] font-semibold text-foreground mb-1">Anúncios / Conjuntos</p>
                  <div className="space-y-1">
                    {distributionStructure === "ABO" && creatives.length > 1 ? (
                      creatives.map((cr, idx) => (
                        <div key={cr.id} className="text-xs text-muted-foreground pl-2 border-l border-border/50">
                          <p>Conjunto {idx + 1}: {previewAdsetName(cr.name || `Criativo ${idx + 1}`)}</p>
                          <p className="pl-2">Anúncio: {cr.name || `Criativo ${idx + 1}`}</p>
                        </div>
                      ))
                    ) : (
                      <>
                        {!isFase2 && (isMultiAud ? multiAudIds.length > 0 : selectedAudienceName) && (
                          <p className="text-xs font-mono text-primary break-all">
                            Conjunto: {previewAdsetName(distributionStructure === "ABO" ? (creatives[0]?.name || "Criativo 1") : undefined)}
                            {distributionStructure === "CBO" && creatives.length > 1 ? " (todos criativos)" : ""}
                          </p>
                        )}
                        {creatives.map((cr, idx) => (
                          <p key={cr.id} className="text-xs font-mono text-primary break-all">Anúncio {creatives.length > 1 ? idx + 1 : ""}: {cr.name || `Criativo ${idx + 1}`}</p>
                        ))}
                      </>
                    )}
                  </div>
                </div>

                {/* Seção 4: Fase 3 (se ativo) */}
                {isFase3 && (
                  <>
                    <Separator className="opacity-20" />
                    <div>
                      <p className="text-[10px] font-semibold text-foreground mb-1">Fase 3</p>
                      <div className="space-y-1">
                        {selectedWhatsapp && <p className="text-xs text-muted-foreground">WhatsApp: {selectedWhatsapp.display}</p>}
                        {includedLocations.length > 0 && <p className="text-xs text-muted-foreground">Incluir: {includedLocations.map(l => l.display || l.name).join(", ")}</p>}
                        {excludedLocations.length > 0 && <p className="text-xs text-muted-foreground">Excluir: {excludedLocations.map(l => l.display || l.name).join(", ")}</p>}
                        <p className="text-xs text-muted-foreground">CTA: WHATSAPP_MESSAGE (automático)</p>
                        {(greetingText || readyMessage) && (
                          <p className="text-xs text-muted-foreground">Mensagem: {greetingText ? `"${greetingText}" + ` : ""}{readyMessage ? `"${readyMessage}"` : "modelo selecionado"}</p>
                        )}
                      </div>
                    </div>
                  </>
                )}

                <Separator className="opacity-20" />

                {/* Seção 5: Agendamento + UTM */}
                <div>
                  <p className="text-[10px] font-semibold text-foreground mb-1">Agendamento + UTM</p>
                  <div className="space-y-1">
                    {scheduleEnabled && scheduleDate && scheduleTime && (
                      <p className="text-xs text-muted-foreground">Início agendado: {scheduleDate} às {scheduleTime}</p>
                    )}
                    <p className="text-xs font-mono text-muted-foreground break-all">UTM: {utmTemplate.trim() || UTM_DEFAULT}</p>
                  </div>
                </div>
              </div>
            </Card>
          )}

          <Separator className="opacity-30" />

          {/* Validation Result */}
          {validationResult && (
            <Card className={`glass-card p-4 space-y-3 ${validationResult.valid ? "border-success/30" : "border-destructive/30"}`}>
              <p className="font-display font-semibold text-sm">
                {validationResult.valid ? "✅ Validação OK" : "❌ Validação falhou"}
              </p>
              {validationResult.checks?.map((c, i) => (
                <div key={i} className="flex items-center justify-between text-xs gap-3">
                  <span className="font-semibold text-foreground">{c.label}</span>
                  <span className={`font-normal ${c.ok ? "text-success" : "text-destructive"}`}>{c.detail}</span>
                </div>
              ))}
              {validationResult.min_budget && (
                <div className="bg-warning/10 border border-warning/30 rounded-md p-3 mt-2">
                  <p className="text-sm text-warning font-medium">Orçamento mínimo: R$ {validationResult.min_budget}</p>
                </div>
              )}
              {validationResult.error && (
                <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3 mt-2 space-y-1">
                  <p className="text-xs text-destructive font-medium">{validationResult.error}</p>
                  {validationResult.error_details?.error_user_title && <p className="text-xs text-destructive">{validationResult.error_details.error_user_title}</p>}
                  {validationResult.error_details?.error_user_msg && <p className="text-xs text-muted-foreground">{validationResult.error_details.error_user_msg}</p>}
                </div>
              )}
            </Card>
          )}

          {/* Status ao vivo do publish (ex.: aguardando janela do rate-limit #4 pra retomar) */}
          {publishStatus && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-warning shrink-0" />
              <p className="text-xs text-warning">{publishStatus}</p>
            </div>
          )}

          {/* Actions */}
          <div className="border-t border-border pt-6 mt-2 flex gap-3">
            <Button variant="secondary" size="lg" onClick={handleValidate} disabled={loading || validatingCreative || selectedPreset.not_implemented} className="flex-1 gap-2">
              {(loading || validatingCreative) ? <Loader2 className="w-4 h-4 animate-spin will-change-transform" /> : <CheckCircle2 className="w-4 h-4" />}
              Validar
            </Button>
            <Button variant="default" size="lg" onClick={handlePublish} disabled={loading || !validatedPayload || !validationResult?.valid || (!!minBudget && Number(budget) < minBudget) || selectedPreset.not_implemented} className="flex-1 gap-2 glow-primary bg-gradient-to-r from-primary via-primary to-accent/30">
              {loading ? <Loader2 className="w-4 h-4 animate-spin will-change-transform" /> : <Send className="w-4 h-4" />}
              {loading ? "Publicando..." : "Publicar"}
            </Button>
          </div>

          {publishResult && publishResult.ok && (
            <Card className="glass-card p-4 border-success/30 glow-primary space-y-2">
              <p className="text-sm font-display font-semibold text-success">✅ Publicado com sucesso!</p>
              <div className="space-y-1 text-xs font-mono">
                {publishResult.campaign_ids && publishResult.campaign_ids.length > 1 ? (
                  <>
                    <p>Campanhas criadas: {publishResult.campaign_ids.length} (1 por criativo)</p>
                    {publishResult.campaign_ids.map((cid, i) => (
                      <p key={cid}>Campaign {i + 1} ID: {cid}</p>
                    ))}
                  </>
                ) : (
                  <p>Campaign ID: {publishResult.campaign_id}</p>
                )}
                {publishResult.adsets_created && <p>AdSets criados: {publishResult.adsets_created}</p>}
                {publishResult.ads_created && <p>Ads criados: {publishResult.ads_created}</p>}
              </div>
            </Card>
          )}

          {publishResult && !publishResult.ok && (
            <Card ref={publishErrorRef} className="glass-card p-4 border-destructive/30 space-y-3">
              <p className="text-sm font-display font-semibold text-destructive">
                ❌ Falha na etapa: <span className="font-mono">{publishResult.step || "desconhecido"}</span>
              </p>
              <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3 space-y-1">
                <p className="text-xs text-destructive font-medium">{publishResult.error_message || publishResult.error}</p>
                {publishResult.error_user_title && <p className="text-xs text-destructive">{publishResult.error_user_title}</p>}
                {publishResult.error_user_msg && <p className="text-xs text-muted-foreground">{publishResult.error_user_msg}</p>}
                {(publishResult.error_code != null || publishResult.error_subcode != null) && (
                  <p className="text-[10px] font-mono text-muted-foreground">Meta code={publishResult.error_code ?? "-"} · subcode={publishResult.error_subcode ?? "-"}</p>
                )}
              </div>
              {publishResult.creative_errors && publishResult.creative_errors.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Motivo por criativo:</p>
                  {publishResult.creative_errors.map((ce, i) => (
                    <div key={i} className="bg-destructive/10 border border-destructive/30 rounded-md p-2 flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                      <p className="text-[10px] text-destructive flex-1"><span className="font-semibold">{ce.name}:</span> {ce.error}</p>
                    </div>
                  ))}
                </div>
              )}
              {(publishResult.campaign_id || publishResult.adset_id || (publishResult.campaign_ids && publishResult.campaign_ids.length > 0)) && (
                <div className="space-y-1">
                  {publishResult.campaign_ids && publishResult.campaign_ids.length > 0
                    ? publishResult.campaign_ids.map((cid, i) => <IDDisplay key={cid} id={cid} label={`Campaign ${i + 1}`} />)
                    : (publishResult.campaign_id && <IDDisplay id={publishResult.campaign_id} label="Campaign" />)}
                  {publishResult.adset_id && <IDDisplay id={publishResult.adset_id} label="AdSet" />}
                </div>
              )}
            </Card>
          )}

          {/* Logs */}
          <LogPanel ref={(inst) => {
            logRef.current = inst;
            if (inst && pendingLogsRef.current.length) {
              for (const msg of pendingLogsRef.current) inst.add(msg);
              pendingLogsRef.current = [];
            }
          }} />
        </>
      )}
    </div>
  );
}
