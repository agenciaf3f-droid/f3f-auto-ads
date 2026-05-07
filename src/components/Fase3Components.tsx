import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Loader2, Phone, MessageCircle, Calendar, Clock, Save, Copy, Pencil, Trash2,
} from "lucide-react";

// ============================================================================
// Types
// ============================================================================

export interface WhatsAppNumber {
  id: string;
  display: string;
  phone: string;
  page_id: string;
  page_name: string;
  status?: string;
  waba_id?: string;
}

export interface MessageTemplate {
  id: string;
  name: string;
  greeting: string;
  ready_message: string;
}

export interface Fase3State {
  whatsappNumbers: WhatsAppNumber[];
  loadingWhatsappNumbers: boolean;
  selectedWhatsappId: string;
  greetingText: string;
  readyMessage: string;
  useCustomMessage: boolean;
  selectedTemplateId: string;
  messageTemplates: MessageTemplate[];
}

export interface Fase3ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// 1. WhatsApp Number Selector
// ============================================================================

interface WhatsAppNumberSelectorProps {
  numbers: WhatsAppNumber[];
  loading: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
}

export function WhatsAppNumberSelector({
  numbers, loading, selectedId, onSelect,
}: WhatsAppNumberSelectorProps) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground flex items-center gap-1">
        <Phone className="w-3.5 h-3.5" /> Número do WhatsApp (obrigatório)
      </Label>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Buscando números...
        </div>
      ) : numbers.length > 0 ? (
        <Select value={selectedId} onValueChange={onSelect}>
          <SelectTrigger><SelectValue placeholder="Selecione o número" /></SelectTrigger>
          <SelectContent>
            {numbers.map((n) => (
              <SelectItem key={n.id} value={n.id}>{n.display}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="bg-warning/10 border border-warning/30 rounded-md p-3">
          <p className="text-xs text-warning font-medium">Nenhum número de WhatsApp conectado encontrado.</p>
          <p className="text-[10px] text-muted-foreground mt-1">Conecte um número no Meta Business Suite.</p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 2. WhatsApp Messages (Greeting + Ready Message + Templates)
// ============================================================================

type ImportedTpl = {
  key: string;
  template_id: string;
  welcome_text: string;
  autofill: string;
  quick_reply: string | null;
  sample_ad_name: string;
  raw_json: string;
};

interface WhatsAppMessagesProps {
  greetingText: string;
  readyMessage: string;
  useCustomMessage: boolean;
  selectedTemplateId: string;
  messageTemplates: MessageTemplate[];
  templateName: string;
  savingTemplate: boolean;
  importedTemplates?: ImportedTpl[];
  loadingImported?: boolean;
  selectedImportedKey?: string;
  onGreetingChange: (text: string) => void;
  onReadyMessageChange: (text: string) => void;
  onUseCustomMessageChange: (value: boolean) => void;
  onSelectTemplate: (id: string) => void;
  onTemplateName: (name: string) => void;
  onSaveTemplate: () => void;
  onDeleteTemplate: (id: string) => void;
  onEditTemplate: (tpl: MessageTemplate) => void;
  onDuplicateTemplate: (tpl: MessageTemplate) => void;
  onLoadImported?: () => void;
  onSelectImported?: (key: string) => void;
}

export function WhatsAppMessages({
  greetingText, readyMessage, useCustomMessage, selectedTemplateId,
  messageTemplates, templateName, savingTemplate,
  importedTemplates = [], loadingImported = false, selectedImportedKey = "",
  onGreetingChange, onReadyMessageChange, onUseCustomMessageChange,
  onSelectTemplate, onTemplateName, onSaveTemplate, onDeleteTemplate,
  onEditTemplate, onDuplicateTemplate,
  onLoadImported, onSelectImported,
}: WhatsAppMessagesProps) {
  return (
    <div className="space-y-3">
      <Label className="text-xs text-muted-foreground">Mensagem de chegada / conversa (obrigatório)</Label>
      <div className="flex items-center gap-3">
        <span
          className={`text-xs cursor-pointer ${useCustomMessage ? "text-primary font-medium" : "text-muted-foreground"}`}
          onClick={() => onUseCustomMessageChange(true)}
        >
          Criar mensagem
        </span>
        <Switch checked={!useCustomMessage} onCheckedChange={(c) => onUseCustomMessageChange(!c)} />
        <span
          className={`text-xs cursor-pointer ${!useCustomMessage ? "text-primary font-medium" : "text-muted-foreground"}`}
          onClick={() => onUseCustomMessageChange(false)}
        >
          Usar existente
        </span>
      </div>

      {useCustomMessage ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Saudação</Label>
            <Input placeholder="Olá! 👋" value={greetingText} onChange={(e) => onGreetingChange(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Mensagem pronta</Label>
            <Textarea placeholder="Gostaria de saber mais sobre..." value={readyMessage} onChange={(e) => onReadyMessageChange(e.target.value)} rows={3} />
          </div>
          <div className="flex gap-2 items-end">
            <div className="flex-1 space-y-1">
              <Label className="text-[10px] text-muted-foreground">Salvar como modelo</Label>
              <Input placeholder="Nome do modelo" value={templateName} onChange={(e) => onTemplateName(e.target.value)} className="text-xs" />
            </div>
            <Button variant="outline" size="sm" onClick={onSaveTemplate} disabled={savingTemplate || !templateName.trim() || !readyMessage.trim()} className="gap-1 shrink-0">
              {savingTemplate ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Salvar
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {messageTemplates.length > 0 ? (
            <div className="space-y-2">
              <Label className="text-[10px] text-muted-foreground">Modelos salvos</Label>
              <Select value={selectedTemplateId} onValueChange={onSelectTemplate}>
                <SelectTrigger><SelectValue placeholder="Selecione um modelo" /></SelectTrigger>
                <SelectContent>
                  {messageTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTemplateId && (() => {
                const tpl = messageTemplates.find(t => t.id === selectedTemplateId);
                return tpl ? (
                  <div className="bg-muted/50 rounded-md p-3 space-y-2">
                    {tpl.greeting && <p className="text-xs"><strong>Saudação:</strong> {tpl.greeting}</p>}
                    <p className="text-xs"><strong>Mensagem:</strong> {tpl.ready_message}</p>
                    <div className="flex gap-1 mt-1">
                      <Button variant="ghost" size="sm" className="text-xs gap-1 h-7" onClick={() => onEditTemplate(tpl)}>
                        <Pencil className="w-3 h-3" /> Editar
                      </Button>
                      <Button variant="ghost" size="sm" className="text-xs gap-1 h-7" onClick={() => onDuplicateTemplate(tpl)}>
                        <Copy className="w-3 h-3" /> Duplicar
                      </Button>
                      <Button variant="ghost" size="sm" className="text-xs text-destructive gap-1 h-7" onClick={() => onDeleteTemplate(tpl.id)}>
                        <Trash2 className="w-3 h-3" /> Remover
                      </Button>
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          ) : (
            <div className="bg-muted/50 rounded-md p-3">
              <p className="text-xs text-muted-foreground">Nenhum modelo salvo. Crie uma mensagem e salve como modelo.</p>
            </div>
          )}

          {/* Modelos importados da conta de anúncios */}
          {onLoadImported && (
            <div className="space-y-2 pt-3 border-t border-border/50">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] text-muted-foreground">Modelos da conta de anúncios (importados da Meta UI)</Label>
                <Button variant="outline" size="sm" onClick={onLoadImported} disabled={loadingImported} className="text-xs h-7">
                  {loadingImported ? <Loader2 className="w-3 h-3 animate-spin" /> : "Buscar"}
                </Button>
              </div>
              {importedTemplates.length > 0 ? (
                <Select value={selectedImportedKey} onValueChange={(v) => onSelectImported?.(v)}>
                  <SelectTrigger><SelectValue placeholder={`${importedTemplates.length} modelo(s) encontrado(s) — selecione`} /></SelectTrigger>
                  <SelectContent>
                    {importedTemplates.map((t) => (
                      <SelectItem key={t.key} value={t.key}>
                        {(t.welcome_text || "(sem saudação)").substring(0, 40)} → {(t.autofill || "(sem autofill)").substring(0, 30)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-[10px] text-muted-foreground italic">Clique em "Buscar" para importar modelos das suas campanhas existentes nesta conta.</p>
              )}
              {selectedImportedKey && (() => {
                const t = importedTemplates.find(x => x.key === selectedImportedKey);
                return t ? (
                  <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded-md p-2.5 space-y-1">
                    <p className="text-[10px]"><strong>Saudação:</strong> {t.welcome_text}</p>
                    <p className="text-[10px]"><strong>Autofill:</strong> {t.autofill}</p>
                    {t.template_id !== "inline" && <p className="text-[9px] text-muted-foreground">template_id: {t.template_id}</p>}
                  </div>
                ) : null;
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 3. Fase 3 Summary Card
// ============================================================================

interface Fase3SummaryProps {
  presetLabel: string;
  distributionStructure: string;
  structureDescription: string;
  selectedAccount: string;
  selectedAudienceName: string;
  budget: string;
  whatsappDisplay: string;
  readyMessage: string;
  creativeCount: number;
}

export function Fase3Summary({
  presetLabel, distributionStructure, structureDescription,
  selectedAccount, selectedAudienceName, budget,
  whatsappDisplay, readyMessage, creativeCount,
}: Fase3SummaryProps) {
  return (
    <div className="bg-accent/10 border border-accent/30 rounded-md p-3 space-y-2 mt-3">
      <p className="text-xs font-medium text-accent-foreground">Resumo FASE 3 — WhatsApp Leads</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
        <span className="text-muted-foreground">Objetivo:</span>
        <span>OUTCOME_LEADS</span>
        <span className="text-muted-foreground">Otimização:</span>
        <span>CONVERSATIONS</span>
        <span className="text-muted-foreground">Destino:</span>
        <span>WHATSAPP</span>
        <span className="text-muted-foreground">WhatsApp:</span>
        <span>{whatsappDisplay || "Não selecionado"}</span>
        <span className="text-muted-foreground">Orçamento:</span>
        <span>R$ {budget || "0"}/dia</span>
        <span className="text-muted-foreground">Criativos:</span>
        <span>{creativeCount}</span>
      </div>
      {readyMessage && (
        <div className="mt-1 p-2 bg-muted/50 rounded border border-border">
          <p className="text-[10px] text-muted-foreground">Mensagem pronta:</p>
          <p className="text-[10px] italic">"{readyMessage.substring(0, 80)}{readyMessage.length > 80 ? "..." : ""}"</p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 4. Validation Helpers
// ============================================================================

export function validateFase3Fields(params: {
  selectedWhatsappId: string;
  useCustomMessage: boolean;
  greetingText: string;
  readyMessage: string;
  selectedTemplateId: string;
  addLog: (msg: string) => void;
}): Fase3ValidationResult {
  const { selectedWhatsappId, useCustomMessage, greetingText, readyMessage, selectedTemplateId, addLog } = params;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!selectedWhatsappId) {
    errors.push("Selecione um número de WhatsApp");
    addLog("❌ [fase3-validate] WhatsApp: ausente");
  } else {
    addLog(`✅ [fase3-validate] WhatsApp: ${selectedWhatsappId}`);
  }

  if (useCustomMessage) {
    addLog(`🔍 [fase3-validate] Modo: Criar mensagem`);
    if (!greetingText.trim()) {
      errors.push("Preencha a saudação da mensagem");
      addLog("❌ [fase3-validate] Saudação: vazia");
    } else {
      addLog(`✅ [fase3-validate] Saudação: "${greetingText.substring(0, 30)}..."`);
    }
    if (!readyMessage.trim()) {
      errors.push("Preencha a mensagem pronta");
      addLog("❌ [fase3-validate] Mensagem pronta: vazia");
    } else {
      addLog(`✅ [fase3-validate] Mensagem pronta: "${readyMessage.substring(0, 30)}..."`);
    }
  } else {
    addLog(`🔍 [fase3-validate] Modo: Usar existente`);
    if (!selectedTemplateId) {
      errors.push("Selecione um modelo de conversa");
      addLog("❌ [fase3-validate] Modelo selecionado: nenhum");
    } else {
      addLog(`✅ [fase3-validate] Modelo selecionado: ${selectedTemplateId}`);
    }
  }

  if (readyMessage && readyMessage.length > 1000) {
    warnings.push("Mensagem pronta muito longa (máximo 1000 caracteres)");
  }

  addLog(`🔍 [fase3-validate] Resultado: ${errors.length === 0 ? "✅ OK" : `❌ ${errors.length} erro(s): ${errors.join("; ")}`}`);
  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================================
// 5. Payload Builder
// ============================================================================

export function buildFase3Payload(params: {
  accessToken: string;
  selectedAccount: string;
  selectedAudience: string;
  audienceType: string;
  audienceName: string;
  targetingSpec: any;
  creatives: any[];
  budget: string;
  campaignName: string;
  adsetName: string;
  existingCampaignId: string;
  generatedName: string;
  distributionStructure: string;
  identity: {
    page_id: string | null;
    page_name: string | null;
    instagram_actor_id: string | null;
    instagram_username: string | null;
    whatsapp_phone_id: string | null;
    whatsapp_phone: string | null;
  };
  preset: any;
  whatsappNumber: string;
  whatsappNumberId: string;
  locationTargeting: any;
  greetingText: string;
  readyMessage: string;
  schedule: any;
  utmTemplate: string;
}): Record<string, unknown> {
  return {
    access_token: params.accessToken,
    ad_account_id: params.selectedAccount,
    audience_id: params.selectedAudience,
    audience_type: params.audienceType,
    audience_name: params.audienceName,
    targeting_spec: params.targetingSpec,
    creatives: params.creatives,
    budget: Number(params.budget),
    campaign_name: params.campaignName,
    adset_name: params.adsetName,
    existing_campaign_id: params.existingCampaignId,
    generated_name: params.generatedName,
    distribution_structure: params.distributionStructure,
    identity: params.identity,
    preset: params.preset,
    whatsapp_number: params.whatsappNumber,
    whatsapp_number_id: params.whatsappNumberId,
    location_targeting: params.locationTargeting,
    greeting_text: params.greetingText,
    ready_message: params.readyMessage,
    schedule: params.schedule,
    utm_template: params.utmTemplate,
  };
}
