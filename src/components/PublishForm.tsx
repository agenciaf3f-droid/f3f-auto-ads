import { useState, useEffect, useCallback } from "react";
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
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  LogIn, Settings2, Send, CheckCircle2, Loader2, Copy, AlertTriangle, Unplug,
  Instagram, HardDrive, ArrowRight, FolderOpen, Plus, Calendar, Clock, MessageCircle, MapPin, Phone, Save, Trash2,
  Layers, PlusCircle, X, Pencil,
} from "lucide-react";
import {
  getMetaLoginUrl, fetchMetaStatus, fetchAdAccounts, fetchAudiences,
  validatePublish, publishAd, validateCreative, fetchCampaigns,
  fetchWhatsAppNumbers, fetchIgAccountsForAdAccount, disconnectMeta,
  runCampaignDiagnostic,
  fetchImportedMetaTemplates, type ImportedMetaTemplate,
} from "@/lib/meta-api";
import { generateCampaignName, generateAdsetName, generateAdName_v2 } from "@/lib/naming";
import SearchableSelect from "@/components/SearchableSelect";
import LocationSelector, { type LocationItem } from "@/components/LocationSelector";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { supabase } from "@/integrations/supabase/client";

interface AdAccount { id: string; name: string }
interface Audience { id: string; name: string; type: "custom" | "saved"; targeting_spec?: any }
interface Campaign { id: string; name: string; status: string; objective: string }
interface WhatsAppNumber { id: string; display: string; phone: string; page_id: string; page_name: string }
interface MessageTemplate { id: string; name: string; greeting: string; ready_message: string }
interface PublishResult { ok?: boolean; campaign_id?: string; adset_id?: string; ad_id?: string; creative_id?: string; error?: string; step?: string; error_message?: string; error_code?: number | null; error_subcode?: number | null; error_user_msg?: string; error_user_title?: string; raw_error?: any; logs?: { step: string; status: string; ts: string; detail?: string }[]; adsets_created?: number; ads_created?: number; warning?: boolean }
interface ErrorDetails { message?: string; error_user_title?: string; error_user_msg?: string; code?: number | null; error_subcode?: number | null; error_data?: any }
interface ValidationResult { valid: boolean; checks?: { label: string; ok: boolean; detail: string }[]; error?: string; error_details?: ErrorDetails; min_budget?: number | null }

type CreativeType = "instagram" | "drive";
type CampaignStructure = "new" | "existing";
type DistributionStructure = "ABO" | "CBO";

interface CreativeItem {
  id: string;
  type: CreativeType;
  link: string;
  name: string;
  validation?: { ok: boolean; error?: string; suggest_drive?: boolean } | null;
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
  },
  {
    id: "fase3-br",
    label: "FASE 3",
    objective: "OUTCOME_LEADS",
    optimization_goal: "CONVERSATIONS",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "WHATSAPP",
    default_cta: "WHATSAPP_MESSAGE",
    status: "PAUSED",
    fase: "FASE 3",
    requires_whatsapp: true,
  },
] as const;
type PresetId = typeof PRESETS[number]["id"];

const UTM_TEMPLATE = "utm_source=FB&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_medium={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}&utm_term={{placement}}";

let creativeCounter = 0;
function nextCreativeId() { return `cr_${++creativeCounter}_${Date.now()}`; }

export default function PublishForm() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [metaName, setMetaName] = useState("");
  const [metaLoading, setMetaLoading] = useState(true);

  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [selectedAudience, setSelectedAudience] = useState("");
  const [campaignNameInput, setCampaignNameInput] = useState("");
  const [adsetNameInput, setAdsetNameInput] = useState("");
  const [budget, setBudget] = useState("");
  const [campaignStructure, setCampaignStructure] = useState<CampaignStructure>("new");
  const [distributionStructure, setDistributionStructure] = useState<DistributionStructure>("ABO");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [preset, setPreset] = useState<PresetId>("fase1-trafego");
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingAudiences, setLoadingAudiences] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [validatedPayload, setValidatedPayload] = useState<Record<string, unknown> | null>(null);
  const [minBudget, setMinBudget] = useState<number | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [validatingCreative, setValidatingCreative] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<any>(null);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);

  // Multi-creative
  const [creatives, setCreatives] = useState<CreativeItem[]>([
    { id: nextCreativeId(), type: "instagram", link: "", name: "", validation: null },
  ]);

  // FASE 3 fields
  const [whatsappNumbers, setWhatsappNumbers] = useState<WhatsAppNumber[]>([]);
  const [loadingWhatsappNumbers, setLoadingWhatsappNumbers] = useState(false);
  const [selectedWhatsappId, setSelectedWhatsappId] = useState("");
  const [ctaText, setCtaText] = useState("");
  const [greetingText, setGreetingText] = useState("");
  const [readyMessage, setReadyMessage] = useState("");
  const [useCustomMessage, setUseCustomMessage] = useState(true);

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

  // Scheduling
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

  const addLog = (msg: string) => setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  useEffect(() => { checkMetaStatus(); loadMessageTemplates(); }, []);
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
        } catch { /* ignore parse errors */ }
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
    }
  }, [selectedAccount]);

  // When preset changes, reload FASE 3 resources if identity is already loaded
  useEffect(() => {
    const p = PRESETS.find(pp => pp.id === preset);
    if (p?.requires_whatsapp && accessToken && identityLoaded && identityPageId) {
      loadFase3Resources(identityPageId);
    }
  }, [preset, identityLoaded, identityPageId]);

  // Invalidate validated payload when any form field changes
  useEffect(() => {
    setValidatedPayload(null);
    setValidationResult(null);
  }, [selectedAccount, selectedAudience, budget, preset, campaignStructure, distributionStructure,
      selectedCampaign, selectedWhatsappId, greetingText, readyMessage, selectedTemplateId,
      useCustomMessage, creatives, scheduleEnabled, scheduleDate, scheduleTime,
      includedLocations, excludedLocations, campaignNameInput, adsetNameInput]);

  const loadAccountContext = async () => {
    if (!accessToken || !selectedAccount) return;

    // ===== STEP 1: FULL RESET =====
    addLog("🔄 [pipeline] Reset completo do contexto da conta");
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
    setSelectedTemplateId("");
    // Reset audiences
    setAudiences([]);
    setSelectedAudience("");
    // Reset validation/publish state
    setValidationResult(null);
    setPublishResult(null);
    setMinBudget(null);

    // ===== STEP 2: LOAD AUDIENCES (parallel with identity) =====
    loadAudiences();

    // ===== STEP 3: LOAD IDENTITY (from ad account's authorized IG accounts) =====
    let resolvedPageId: string | null = null;
    try {
      addLog(`📡 [pipeline] Buscando contas IG autorizadas para ${selectedAccount}...`);
      const igAccounts = await fetchIgAccountsForAdAccount(accessToken, selectedAccount);
      addLog(`📄 [pipeline] contas IG autorizadas: ${igAccounts.length}`);
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

      if (!foundPageId) {
        const { data: pagesData } = await supabase.functions.invoke("meta-ad-accounts", {
          body: { access_token: accessToken, action: "get_pages" },
        });
        const pages: any[] = pagesData?.pages || [];
        if (pages.length > 0) {
          foundPageId = pages[0].id;
          foundPageName = pages[0].name;
          addLog(`⚠️ [pipeline] usando primeira página como fallback: ${foundPageName}`);
        }
      }

      setIdentityPageId(foundPageId);
      setIdentityPageName(foundPageName);
      setIdentityIgActorId(foundIgActorId);
      setIdentityIgUsername(foundIgUsername);
      setIdentityWhatsappId(foundWhatsappId);
      setIdentityWhatsappPhone(foundWhatsappPhone);
      setIdentityLoaded(true);
      resolvedPageId = foundPageId;

      if (!foundIgActorId) {
        setIdentityError("Nenhuma conta Instagram autorizada encontrada para esta conta de anúncios.");
      }
      addLog(`✅ [pipeline] identidade final: page=${foundPageId}, ig_actor=${foundIgActorId}, ig_user=@${foundIgUsername || "N/A"}, whatsapp_id=${foundWhatsappId || "N/A"}, whatsapp_phone=${foundWhatsappPhone || "N/A"}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      addLog(`❌ [pipeline] Erro ao carregar identidade: ${msg}`);
      setIdentityError(msg);
      setIdentityLoaded(true);
    } finally {
      setIdentityLoading(false);
    }

    // ===== STEP 4: LOAD FASE 3 RESOURCES (depends on identity) =====
    if (resolvedPageId) {
      await loadFase3Resources(resolvedPageId);
    }

    // ===== STEP 5: LOAD IMPORTED MESSAGE TEMPLATES (FASE 3) =====
    // Auto-busca dos modelos de mensagem da própria conta Meta
    setImportedTemplates([]);
    setSelectedImportedKey("");
    setImportedRawJson("");
    setLoadingImported(true);
    try {
      addLog(`📡 [imported] Buscando modelos de mensagem da conta...`);
      const list = await fetchImportedMetaTemplates(accessToken, selectedAccount);
      setImportedTemplates(list);
      addLog(`✅ [imported] ${list.length} modelo(s) extraído(s)`);
    } catch (err: unknown) {
      addLog(`⚠️ [imported] erro: ${err instanceof Error ? err.message : "desconhecido"}`);
    } finally {
      setLoadingImported(false);
    }
  };

  const loadFase3Resources = async (pageId: string) => {
    addLog(`📡 [pipeline] Carregando recursos FASE 3 (page=${pageId})...`);
    // Load WhatsApp numbers (templates are loaded globally on mount)
    await loadWhatsappNumbers();
    addLog(`✅ [pipeline] Recursos FASE 3 carregados`);
  };

  const handleConnect = () => {
    addLog("🔐 Iniciando login Meta via redirect OAuth...");
    sessionStorage.removeItem("meta_status_cache");
    window.location.href = getMetaLoginUrl();
  };
  const handleReconnect = () => {
    addLog("🔄 Reconectando Meta via redirect OAuth...");
    sessionStorage.removeItem("meta_status_cache");
    window.location.href = getMetaLoginUrl();
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
      setCreatives([{ id: nextCreativeId(), type: "instagram", link: "", name: "", validation: null }]);
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
    try {
      addLog("📡 Carregando todas as contas de anúncios...");
      const accounts = await fetchAdAccounts(accessToken);
      setAdAccounts(accounts);
      addLog(`✅ ${accounts.length} conta(s) encontrada(s)`);
    } catch (err: unknown) {
      addLog(`❌ Erro ao carregar contas: ${err instanceof Error ? err.message : "Erro"}`);
    }
  };

  const loadAudiences = async () => {
    if (!accessToken || !selectedAccount) return;
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

  const loadWhatsappNumbers = async () => {
    if (!accessToken) return;
    setLoadingWhatsappNumbers(true);
    setWhatsappNumbers([]);
    setSelectedWhatsappId("");
    try {
      const adAccId = selectedAccount;
      const pageId = identityPageId;
      addLog(`📡 Buscando números de WhatsApp (ad_account=${adAccId || "none"}, page_id=${pageId || "none"})...`);
      const nums = await fetchWhatsAppNumbers(accessToken, adAccId || undefined, pageId || undefined);
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
      } else {
        addLog("⚠️ Nenhum número de WhatsApp encontrado. Verifique se o Business Manager tem um WhatsApp Business Account vinculado.");
      }
    } catch (err: unknown) {
      addLog(`❌ Erro ao buscar WhatsApp: ${err instanceof Error ? err.message : "Erro"}`);
    } finally {
      setLoadingWhatsappNumbers(false);
    }
  };

  const loadMessageTemplates = async () => {
    try {
      addLog("📡 [modelos] Carregando biblioteca global de modelos de mensagens...");
      const { data, error } = await supabase
        .from("message_templates")
        .select("id, name, greeting, ready_message")
        .order("created_at", { ascending: false });
      if (!error && data) {
        setMessageTemplates(data);
        addLog(`✅ [modelos] ${data.length} modelo(s) encontrado(s) — escopo: global do usuário (sem filtro por conta)`);
      } else {
        addLog(`⚠️ [modelos] Erro ao carregar: ${error?.message || "Desconhecido"}`);
      }
    } catch {}
  };

  const handleSaveTemplate = async () => {
    if (!templateName.trim()) { toast.error("Digite um nome para o modelo."); return; }
    setSavingTemplate(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast.error("Faça login primeiro."); return; }
      const { error } = await supabase.from("message_templates").insert({
        user_id: user.id, name: templateName.trim(), greeting: greetingText, ready_message: readyMessage,
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
      addLog(`📡 [imported] Buscando modelos de mensagem da conta ${selectedAccount}...`);
      const list = await fetchImportedMetaTemplates(accessToken, selectedAccount);
      setImportedTemplates(list);
      addLog(`✅ [imported] ${list.length} modelo(s) extraído(s) da conta`);
      if (list.length === 0) toast.info("Nenhum modelo encontrado. As campanhas anteriores podem não ter usado 'Modelo de mensagem' ou não há campanhas WhatsApp nessa conta.");
    } catch (e: any) {
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
    setCreatives(prev => [...prev, { id: nextCreativeId(), type: "instagram", link: "", name: "", validation: null }]);
  };
  const removeCreative = (id: string) => {
    setCreatives(prev => prev.length <= 1 ? prev : prev.filter(c => c.id !== id));
  };
  const updateCreative = (id: string, updates: Partial<CreativeItem>) => {
    setCreatives(prev => prev.map(c => c.id === id ? { ...c, ...updates, validation: updates.link !== undefined || updates.type !== undefined ? null : c.validation } : c));
  };

  const handleValidateCreative = async (creativeId: string) => {
    const cr = creatives.find(c => c.id === creativeId);
    if (!cr?.link || !accessToken) return;
    setValidatingCreative(true);
    addLog(`🔍 Validando criativo "${cr.name || cr.link}" (${cr.type})...`);
    try {
      const result = await validateCreative({
        access_token: accessToken, ad_account_id: selectedAccount, creative_link: cr.link, creative_type: cr.type,
        ig_account_id: identityIgActorId || undefined,
      });
      updateCreative(creativeId, { validation: result });
      if (result.ok) addLog(`✅ Criativo validado (source: ${result.source || "api"})`);
      else addLog(`❌ Criativo inválido: ${result.error}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      addLog(`❌ Erro ao validar criativo: ${msg}`);
      updateCreative(creativeId, { validation: { ok: false, error: msg } });
    } finally {
      setValidatingCreative(false);
    }
  };

  const selectedAud = audiences.find((a) => a.id === selectedAudience);
  const selectedAudienceName = selectedAud?.name || "";
  const selectedPreset = PRESETS.find(p => p.id === preset)!;
  const isFase3 = selectedPreset.requires_whatsapp;
  const selectedWhatsapp = whatsappNumbers.find(n => n.id === selectedWhatsappId);

  const computedCampaignName = campaignStructure === "new" && campaignNameInput && selectedAudienceName && budget
    ? generateCampaignName({ presetLabel: selectedPreset.fase, publicName: selectedAudienceName, budget: Number(budget), campaignName: campaignNameInput })
    : null;
  const computedAdsetName = adsetNameInput && selectedAudienceName
    ? generateAdsetName({ publicName: selectedAudienceName, adsetName: adsetNameInput })
    : null;
  const generatedName = computedCampaignName || "";

  // Structure descriptions
  const structureDescription = distributionStructure === "CBO"
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
      addLog,
    });
    return { valid: result.valid, errors: result.errors };
  };

  const fase3Valid = () => fase3Validate().valid;

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

    if (!selectedAccount || !selectedAudience || !budget) {
      toast.error("Preencha todos os campos antes de validar.");
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
      toast.error("Preencha nome e link de todos os criativos.");
      return;
    }
    const fase3Result = fase3Validate();
    if (!fase3Result.valid) {
      fase3Result.errors.forEach(err => toast.error(err));
      return;
    }
    if (!scheduleValid()) {
      toast.error("Preencha data e hora do agendamento.");
      return;
    }
    addLog(`⏱️ [validate] Checagens locais: ${Math.round(performance.now() - t0)}ms`);

    // Validate creatives that haven't been validated yet — IN PARALLEL
    let finalCreatives = creatives;
    const creativesToValidate = creatives.filter(cr => !cr.validation?.ok);
    if (creativesToValidate.length > 0) {
      setValidatingCreative(true);
      const tCr = performance.now();
      addLog(`🔍 [validate] Validando ${creativesToValidate.length} criativo(s) em paralelo (${creatives.length - creativesToValidate.length} já validados, pulando)...`);

      const results = await Promise.allSettled(
        creativesToValidate.map(async (cr) => {
          const tSingle = performance.now();
          addLog(`🔍 [validate-creative] "${cr.name}" (${cr.type}) — iniciando...`);
          const result = await validateCreative({
            access_token: accessToken, ad_account_id: selectedAccount, creative_link: cr.link, creative_type: cr.type,
            ig_account_id: identityIgActorId || undefined,
          });
          addLog(`⏱️ [validate-creative] "${cr.name}" — ${Math.round(performance.now() - tSingle)}ms — ${result.ok ? "✅ OK" : `❌ ${result.error}`} (source: ${result.source || "api"})`);
          return { id: cr.id, name: cr.name, result };
        })
      );

      const validationMap = new Map<string, CreativeItem["validation"]>();
      let hasError = false;
      for (const r of results) {
        if (r.status === "fulfilled") {
          validationMap.set(r.value.id, r.value.result);
          if (!r.value.result.ok) {
            toast.error(`Criativo "${r.value.name}" inválido`);
            hasError = true;
          }
        } else {
          hasError = true;
          addLog(`❌ [validate-creative] Erro: ${r.reason}`);
        }
      }
      setCreatives(prev => prev.map(c => validationMap.has(c.id) ? { ...c, validation: validationMap.get(c.id)! } : c));
      addLog(`⏱️ [validate] Criativos validados em ${Math.round(performance.now() - tCr)}ms`);
      setValidatingCreative(false);
      if (hasError) return;

      // Build up-to-date list since React state still holds pre-update snapshot
      finalCreatives = creatives.map(c => validationMap.has(c.id) ? { ...c, validation: validationMap.get(c.id)! } : c);
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
    checks.push({ label: "Público", ok: !!selectedAudience, detail: `${selectedAudience} (${selectedAud?.type || "unknown"})` });
    checks.push({ label: "Orçamento", ok: Number(budget) > 0, detail: budget ? `R$${budget}` : "ausente" });
    checks.push({ label: "Nome Gerado", ok: !!generatedName || campaignStructure === "existing", detail: generatedName || (campaignStructure === "existing" ? "campanha existente" : "ausente") });
    checks.push({ label: "Identidade (Página)", ok: !!identityPageId, detail: identityPageName || "ausente" });
    checks.push({ label: "Identidade (Instagram)", ok: !!identityIgActorId, detail: identityIgUsername ? `@${identityIgUsername}` : (identityIgActorId || "ausente") });
    checks.push({ label: "Criativos", ok: finalCreatives.every(c => c.validation?.ok), detail: `${finalCreatives.filter(c => c.validation?.ok).length}/${finalCreatives.length} validados` });
    if (isFase3) {
      checks.push({ label: "WhatsApp", ok: !!selectedWhatsappId, detail: selectedWhatsapp?.display || "ausente" });
      checks.push({ label: "CTA", ok: true, detail: "WHATSAPP_MESSAGE (automático)" });
      if (useCustomMessage) {
        checks.push({ label: "Saudação", ok: !!greetingText.trim(), detail: greetingText.trim() ? `"${greetingText.substring(0, 30)}..."` : "ausente" });
        checks.push({ label: "Mensagem Pronta", ok: !!readyMessage.trim(), detail: readyMessage.trim() ? `"${readyMessage.substring(0, 30)}..."` : "ausente" });
      } else {
        checks.push({ label: "Modelo de Conversa", ok: !!selectedTemplateId, detail: selectedTemplateId || "nenhum selecionado" });
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

      // Promoted object: must have internal WhatsApp ID
      const hasInternalId = !!(identityWhatsappId || selectedWhatsappId);
      checks.push({ label: "promoted_object (WhatsApp ID interno)", ok: hasInternalId, detail: hasInternalId ? (identityWhatsappId || selectedWhatsappId) : "ausente — sem ID interno de WhatsApp" });

      // Promoted object: must have phone number for display
      const hasPhone = !!(selectedWhatsapp?.phone);
      checks.push({ label: "promoted_object (telefone)", ok: hasPhone, detail: hasPhone ? selectedWhatsapp!.phone : "ausente" });

      addLog(`🔍 [validate] ═══ VALIDAÇÃO ESTRUTURAL FASE 3 ═══`);
      addLog(`🔍 [validate] Campaign: objective=${campaignObj}`);
      addLog(`🔍 [validate] AdSet: optimization_goal=${adsetOpt}, destination_type=${adsetDest}`);
      addLog(`🔍 [validate] Attribution: CLICK_THROUGH / 1 dia`);
      addLog(`🔍 [validate] Promoted Object: page_id=${identityPageId}, whatsapp_id=${identityWhatsappId || selectedWhatsappId}, phone=${selectedWhatsapp?.phone || "N/A"}`);
      addLog(`🔍 [validate] CTA: WHATSAPP_MESSAGE (fixo)`);
      addLog(`🔍 [validate] ═══ FIM VALIDAÇÃO ESTRUTURAL ═══`);
    }

    const allValid = checks.every(c => c.ok);
    addLog(`⏱️ [validate] Checagens completas: ${Math.round(performance.now() - tLocal)}ms`);

    // === BUILD AND STORE THE PUBLISH PAYLOAD ===
    if (allValid) {
      const schedule = buildSchedule();
      const payload: Record<string, unknown> = {
        access_token: accessToken,
        ad_account_id: selectedAccount,
        audience_id: selectedAudience,
        audience_type: selectedAud?.type || "custom",
        audience_name: selectedAudienceName,
        targeting_spec: selectedAud?.targeting_spec || null,
        creatives: finalCreatives.map(c => ({ type: c.type, link: c.link, name: c.name })),
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
        whatsapp_number_id: isFase3 ? selectedWhatsappId : undefined,
        location_targeting: isFase3 ? buildLocationTargeting() : undefined,
        cta_text: undefined,
        greeting_text: greetingText || undefined,
        ready_message: readyMessage || undefined,
        imported_template_json: importedRawJson || undefined,
        schedule,
        utm_template: UTM_TEMPLATE,
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
    setPublishResult(null);
    addLog(`🚀 [publish] Usando payload previamente validado (NÃO remontando)`);
    addLog(`📋 [publish] Preset: ${selectedPreset.label}`);
    addLog(`📋 [publish] Estrutura: ${distributionStructure}`);
    addLog(`📋 [publish] Criativos: ${creatives.length}`);
    if (isFase3) {
      addLog(`📋 [publish] FASE 3: attribution=CLICK_THROUGH/1d (fixo no backend)`);
    }

    try {
      // Use the EXACT payload built during validation — no reconstruction
      const result = await publishAd(validatedPayload);
      setPublishResult(result);
      if (result.logs) {
        for (const l of result.logs) addLog(`  [${l.step}] ${l.status}${l.detail ? ` — ${l.detail}` : ""}`);
      }
      if (result.ok) {
        addLog(`✅ Publicado! Campaign: ${result.campaign_id}`);
        toast.success("Anúncio(s) publicado(s) com sucesso!");
        // Clear validated payload after successful publish
        setValidatedPayload(null);
      } else {
        const stepLabel = result.step || "desconhecido";
        const msg = result.error_message || result.error || "Erro desconhecido";
        const isWarning = result.warning || stepLabel === "idempotency";
        addLog(`${isWarning ? "⚠️" : "❌"} Falha no step "${stepLabel}": ${msg}`);
        if (result.error_user_title) addLog(`   Título: ${result.error_user_title}`);
        if (result.error_user_msg) addLog(`   Detalhe: ${result.error_user_msg}`);
        if (isWarning) toast.warning(msg);
        else toast.error(`Falha ao publicar (${stepLabel})`);
      }
    } catch (err: unknown) {
      let parsed: PublishResult | null = null;
      if (err && typeof err === "object" && "context" in err) {
        try {
          const ctx = (err as any).context;
          if (ctx && typeof ctx === "object") parsed = ctx as PublishResult;
        } catch {}
      }
      if (!parsed && err && typeof err === "object") {
        try {
          const raw = typeof err === "string" ? JSON.parse(err) : (err as any).message ? JSON.parse((err as any).message) : null;
          if (raw && typeof raw === "object" && ("step" in raw || "error_message" in raw)) parsed = raw;
        } catch {}
      }
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
    }
  };

  const copyReport = () => {
    navigator.clipboard.writeText(logs.join("\n"));
    toast.success("Relatório copiado!");
  };

  const handleDiagnostic = async () => {
    if (!accessToken || !selectedAccount) {
      toast.error("Selecione uma conta de anúncios primeiro.");
      return;
    }
    setDiagnosticLoading(true);
    setDiagnosticResult(null);
    setDiagnosticOpen(true);
    addLog("🔬 [diagnostic] Buscando TODAS as campanhas existentes (payload bruto)...");
    try {
      const result = await runCampaignDiagnostic(accessToken, selectedAccount);
      setDiagnosticResult(result);
      if (result.ok) {
        addLog(`✅ [diagnostic] ${result.total_campaigns} campanha(s) capturada(s) com payload completo`);
        toast.success(`Diagnóstico: ${result.total_campaigns} campanha(s) capturada(s)`);
      } else {
        addLog(`❌ [diagnostic] Erro: ${result.error}`);
        toast.error(`Diagnóstico falhou: ${result.error}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro";
      addLog(`❌ [diagnostic] Erro: ${msg}`);
      toast.error(`Diagnóstico falhou: ${msg}`);
    } finally {
      setDiagnosticLoading(false);
    }
  };

  const copyDiagnostic = () => {
    if (diagnosticResult) {
      navigator.clipboard.writeText(JSON.stringify(diagnosticResult, null, 2));
      toast.success("Diagnóstico copiado!");
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
            <Label className="font-display font-semibold text-sm">Conta de Anúncios ({adAccounts.length})</Label>
            <SearchableSelect
              options={adAccounts}
              value={selectedAccount}
              onValueChange={setSelectedAccount}
              placeholder="Selecione a conta"
              searchPlaceholder="Pesquisar por nome ou ID..."
            />
          </Card>

          {/* Identity */}
          {selectedAccount && (
            <Card className="glass-card p-6 space-y-3">
              <Label className="font-display font-semibold text-sm">Identidade da Conta</Label>
              {identityLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Carregando identidade...
                </div>
              ) : identityLoaded ? (
                identityError && !identityIgActorId ? (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3">
                    <p className="text-xs text-destructive font-medium">
                      Conta sem Instagram Business válido para FASE 1.
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-1">{identityError}</p>
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
                      <p className="text-xs font-mono text-muted-foreground"><strong>IG Actor ID:</strong> {identityIgActorId}</p>
                    )}
                    {!identityIgActorId && (
                      <p className="text-xs text-warning">⚠️ Sem Instagram Business vinculado (FASE 1 bloqueada)</p>
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
                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Objetivo: {selectedPreset.objective} | Otimização: {selectedPreset.optimization_goal} | Destino: {selectedPreset.destination_type}
            </p>
          </Card>

          {/* Distribution Structure (ABO / CBO) */}
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
                  <SearchableSelect
                    options={campaigns.map(c => ({ id: c.id, name: `${c.name} (${c.status})` }))}
                    value={selectedCampaign}
                    onValueChange={setSelectedCampaign}
                    placeholder="Selecione a campanha"
                    searchPlaceholder="Pesquisar campanha..."
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">Nenhuma campanha encontrada</p>
                )}
              </div>
            )}
          </Card>

          {/* Names */}
          <Card className="glass-card p-6 space-y-4">
            <Label className="font-display font-semibold text-sm">Nomes</Label>
            {campaignStructure === "new" && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Nome da Campanha</Label>
                <Input
                  placeholder='Ex: "Campanha Tráfego - Joelho"'
                  value={campaignNameInput}
                  onChange={(e) => setCampaignNameInput(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
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
            <div className="flex items-center justify-between">
              <Label className="font-display font-semibold text-sm">
                Criativos ({creatives.length})
              </Label>
              <Button variant="outline" size="sm" className="gap-1 text-xs" onClick={addCreative}>
                <PlusCircle className="w-3.5 h-3.5" /> Adicionar criativo
              </Button>
            </div>

            {creatives.map((cr, idx) => (
              <div key={cr.id} className="border border-border/50 rounded-lg p-4 space-y-3 relative">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Criativo {idx + 1}</span>
                  {creatives.length > 1 && (
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => removeCreative(cr.id)}>
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
                    onClick={() => updateCreative(cr.id, { type: "instagram", link: "" })}
                  >
                    <Instagram className="w-3.5 h-3.5" /> Instagram
                  </Button>
                  <Button
                    variant={cr.type === "drive" ? "default" : "outline"}
                    size="sm"
                    className="flex-1 gap-1 text-xs"
                    onClick={() => updateCreative(cr.id, { type: "drive", link: "" })}
                  >
                    <HardDrive className="w-3.5 h-3.5" /> Drive
                  </Button>
                </div>

                {/* Link + validate */}
                <div className="flex gap-2">
                  <Input
                    placeholder={cr.type === "instagram" ? "https://instagram.com/..." : "https://drive.google.com/..."}
                    value={cr.link}
                    onChange={(e) => updateCreative(cr.id, { link: e.target.value })}
                    className="flex-1 text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleValidateCreative(cr.id)}
                    disabled={!cr.link || validatingCreative}
                    className="shrink-0"
                  >
                    {validatingCreative ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  </Button>
                </div>

                {/* Validation feedback */}
                {cr.validation && !cr.validation.ok && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-md p-2">
                    <p className="text-[10px] text-destructive font-medium">{cr.validation.error}</p>
                  </div>
                )}
                {cr.validation?.ok && (
                  <div className="bg-success/10 border border-success/30 rounded-md p-2">
                    <p className="text-[10px] text-success font-medium">✅ Validado</p>
                  </div>
                )}
              </div>
            ))}
          </Card>

          {/* Audience */}
          <Card className="glass-card p-6 space-y-4">
            <Label className="font-display font-semibold text-sm">
              Público {audiences.length > 0 && `(${audiences.length})`}
            </Label>
            {loadingAudiences ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Carregando públicos...
              </div>
            ) : audiences.length > 0 ? (
              <SearchableSelect
                options={audiences}
                value={selectedAudience}
                onValueChange={setSelectedAudience}
                placeholder="Selecione o público"
                searchPlaceholder="Pesquisar público por nome..."
              />
            ) : selectedAccount ? (
              <div className="flex items-center gap-2 text-sm text-warning">
                <AlertTriangle className="w-4 h-4" /> Nenhum público encontrado
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Selecione uma conta primeiro</p>
            )}
          </Card>


          {/* Budget */}
          <Card className="glass-card p-6 space-y-4">
            <Label className="font-display font-semibold text-sm">{budgetLabel}</Label>
            <Input
              type="number"
              placeholder="50"
              min="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
            {minBudget && (
              <p className="text-xs font-medium text-warning">
                Mínimo permitido pelo Meta: R$ {minBudget}
              </p>
            )}
            {distributionStructure === "ABO" && creatives.length > 1 && (
              <p className="text-[10px] text-muted-foreground">
                Cada conjunto terá R$ {budget || "0"}/dia × {creatives.length} conjuntos = R$ {(Number(budget || 0) * creatives.length).toFixed(2)}/dia total
              </p>
            )}
          </Card>

          {/* ============ FASE 3 EXTRA FIELDS ============ */}
          {isFase3 && (
            <Card className="glass-card p-6 space-y-5 border-accent/30">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-5 h-5 text-accent" />
                <Label className="font-display font-semibold text-sm">Configurações FASE 3 — WhatsApp</Label>
              </div>

              <WhatsAppNumberSelector
                numbers={whatsappNumbers}
                loading={loadingWhatsappNumbers}
                selectedId={selectedWhatsappId}
                onSelect={setSelectedWhatsappId}
              />

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
                    <Input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> Hora</Label>
                    <Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
                  </div>
                </div>
                <Separator className="opacity-30" />
                <p className="text-[10px] text-muted-foreground">Data de término (opcional)</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Data de término</Label>
                    <Input type="date" value={scheduleEndDate} onChange={(e) => setScheduleEndDate(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Hora de término</Label>
                    <Input type="time" value={scheduleEndTime} onChange={(e) => setScheduleEndTime(e.target.value)} />
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* Summary */}
          {(computedCampaignName || computedAdsetName || creatives.some(c => c.name) || isFase3) && (
            <Card className="glass-card p-4 glow-primary space-y-2">
              <Label className="font-display text-xs text-muted-foreground mb-1 block">Resumo</Label>

              {/* Structure */}
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">{selectedPreset.label}</Badge>
                <Badge variant="outline" className="text-[10px]">{distributionStructure}</Badge>
                <Badge variant="secondary" className="text-[10px]">{structureDescription}</Badge>
              </div>

              {campaignStructure === "new" && computedCampaignName && (
                <p className="text-xs font-mono text-primary break-all"><strong>Campanha:</strong> {computedCampaignName}</p>
              )}
              {campaignStructure === "existing" && selectedCampaign && (
                <p className="text-xs font-mono text-muted-foreground break-all"><strong>Campanha:</strong> {campaigns.find(c => c.id === selectedCampaign)?.name || selectedCampaign}</p>
              )}

              {/* ABO: show numbered adsets */}
              {distributionStructure === "ABO" && creatives.length > 1 ? (
                creatives.map((cr, idx) => (
                  <div key={cr.id} className="text-[10px] text-muted-foreground pl-2 border-l border-border/50">
                    <p><strong>Conjunto {idx + 1}:</strong> [{selectedAudienceName}] - {adsetNameInput || "Conjunto"} {String(idx + 1).padStart(2, "0")}</p>
                    <p className="pl-2"><strong>Anúncio:</strong> {cr.name || `Criativo ${idx + 1}`}</p>
                  </div>
                ))
              ) : (
                <>
                  {computedAdsetName && <p className="text-xs font-mono text-primary break-all"><strong>Conjunto:</strong> {computedAdsetName}</p>}
                  {creatives.map((cr, idx) => (
                    <p key={cr.id} className="text-xs font-mono text-primary break-all"><strong>Anúncio {creatives.length > 1 ? idx + 1 : ""}:</strong> {cr.name || `Criativo ${idx + 1}`}</p>
                  ))}
                </>
              )}

              <Separator className="opacity-20" />

              {/* FASE 3 summary */}
              {isFase3 && (
                <>
                  {selectedWhatsapp && <p className="text-[10px] text-muted-foreground"><strong>WhatsApp:</strong> {selectedWhatsapp.display}</p>}
                  {includedLocations.length > 0 && <p className="text-[10px] text-muted-foreground"><strong>Incluir:</strong> {includedLocations.map(l => l.display || l.name).join(", ")}</p>}
                  {excludedLocations.length > 0 && <p className="text-[10px] text-muted-foreground"><strong>Excluir:</strong> {excludedLocations.map(l => l.display || l.name).join(", ")}</p>}
                  {isFase3 && <p className="text-[10px] text-muted-foreground"><strong>CTA:</strong> WHATSAPP_MESSAGE (automático)</p>}
                  {(greetingText || readyMessage) && (
                    <p className="text-[10px] text-muted-foreground"><strong>Mensagem:</strong> {greetingText ? `"${greetingText}" + ` : ""}{readyMessage ? `"${readyMessage}"` : "modelo selecionado"}</p>
                  )}
                </>
              )}

              {scheduleEnabled && scheduleDate && scheduleTime && (
                <p className="text-[10px] text-muted-foreground"><strong>Início agendado:</strong> {scheduleDate} às {scheduleTime}</p>
              )}

              <p className="text-[10px] font-mono text-muted-foreground break-all"><strong>UTM:</strong> {UTM_TEMPLATE}</p>
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
                <div key={i} className="flex items-center justify-between text-xs">
                  <span>{c.label}</span>
                  <span className={c.ok ? "text-success" : "text-destructive"}>{c.detail}</span>
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

          {/* Actions */}
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleValidate} disabled={loading || validatingCreative} className="flex-1 gap-2">
              {(loading || validatingCreative) ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Validar
            </Button>
            <Button onClick={handlePublish} disabled={loading || !validatedPayload || !validationResult?.valid || (!!minBudget && Number(budget) < minBudget)} className="flex-1 gap-2 glow-primary">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Publicar
            </Button>
          </div>

          {/* Diagnostic Button */}
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={handleDiagnostic}
              disabled={diagnosticLoading || !selectedAccount}
              className="flex-1 gap-2 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
            >
              {diagnosticLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Settings2 className="w-4 h-4" />}
              🔬 Diagnóstico Completo
            </Button>
            {diagnosticResult && (
              <Button variant="ghost" size="sm" onClick={copyDiagnostic} className="gap-1 text-xs">
                <Copy className="w-3.5 h-3.5" /> Copiar JSON
              </Button>
            )}
          </div>

          {/* Diagnostic Result */}
          {diagnosticOpen && diagnosticResult && (
            <Card className="glass-card p-4 border-amber-500/30 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-display font-semibold text-amber-400">
                  🔬 Diagnóstico: {diagnosticResult.total_campaigns} campanha(s) — Payload Bruto
                </p>
                <Button variant="ghost" size="sm" onClick={() => setDiagnosticOpen(false)} className="h-6 w-6 p-0">
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Capturado em: {diagnosticResult.fetched_at}</p>
              {diagnosticResult.logs && diagnosticResult.logs.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Logs do diagnóstico ({diagnosticResult.logs.length})</summary>
                  <pre className="mt-2 max-h-[200px] overflow-auto rounded bg-background/50 p-2 font-mono whitespace-pre-wrap break-all text-foreground/70">
                    {diagnosticResult.logs.join("\n")}
                  </pre>
                </details>
              )}
              <div className="max-h-[500px] overflow-auto rounded bg-background/50 p-3">
                <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground/80">
                  {JSON.stringify(diagnosticResult.diagnostic, null, 2)}
                </pre>
              </div>
            </Card>
          )}



          {publishResult && publishResult.ok && (
            <Card className="glass-card p-4 border-success/30 glow-primary space-y-2">
              <p className="text-sm font-display font-semibold text-success">✅ Publicado com sucesso!</p>
              <div className="space-y-1 text-xs font-mono">
                <p>Campaign ID: {publishResult.campaign_id}</p>
                {publishResult.adsets_created && <p>AdSets criados: {publishResult.adsets_created}</p>}
                {publishResult.ads_created && <p>Ads criados: {publishResult.ads_created}</p>}
              </div>
            </Card>
          )}

          {publishResult && !publishResult.ok && (
            <Card className="glass-card p-4 border-destructive/30 space-y-3">
              <p className="text-sm font-display font-semibold text-destructive">
                ❌ Falha na etapa: <span className="font-mono">{publishResult.step || "desconhecido"}</span>
              </p>
              <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3 space-y-1">
                <p className="text-xs text-destructive font-medium">{publishResult.error_message || publishResult.error}</p>
                {publishResult.error_user_title && <p className="text-xs text-destructive">{publishResult.error_user_title}</p>}
                {publishResult.error_user_msg && <p className="text-xs text-muted-foreground">{publishResult.error_user_msg}</p>}
              </div>
              {(publishResult.campaign_id || publishResult.adset_id) && (
                <div className="space-y-1 text-xs font-mono text-muted-foreground">
                  {publishResult.campaign_id && <p>Campaign: {publishResult.campaign_id}</p>}
                  {publishResult.adset_id && <p>AdSet: {publishResult.adset_id}</p>}
                </div>
              )}
            </Card>
          )}

          {/* Logs */}
          <Card className="glass-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="font-display font-semibold text-xs text-muted-foreground">LOGS</Label>
              <Button variant="ghost" size="sm" onClick={copyReport} className="h-7 text-xs gap-1">
                <Copy className="w-3 h-3" /> Copiar
              </Button>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {logs.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nenhum log ainda...</p>
              ) : logs.map((log, i) => (
                <p key={i} className="text-xs font-mono text-muted-foreground">{log}</p>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
