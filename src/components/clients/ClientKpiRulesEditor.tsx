import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { PRESET_BUCKETS, METRIC_REGISTRY, getMetricDef, formatMetricValue, type PresetBucket } from "@/lib/meta-insights";
import {
  listClientKpiRules,
  upsertKpiRule,
  deleteKpiRule,
  type ClientAdAccount,
  type ClientKpiRule,
  type ClientLtProduct,
} from "@/lib/clients";

// Aceita o valor digitado com vírgula OU ponto decimal ("20,90" ou "20.90"). O gestor BR digita
// com vírgula; um <input type="number"> comeria a vírgula (value vira "" e Number("") === 0),
// salvando 0 silenciosamente. Thresholds de KPI são valores pequenos (CPC, custo por conversa),
// então não há separador de milhar a tratar.
function parseThreshold(raw: string): number {
  return Number(raw.trim().replace(",", "."));
}

export default function ClientKpiRulesEditor({ adAccounts, products }: { adAccounts: ClientAdAccount[]; products: ClientLtProduct[] }) {
  const [accountId, setAccountId] = useState<string>(adAccounts[0]?.id || "");
  const [rules, setRules] = useState<ClientKpiRule[]>([]);
  const [loading, setLoading] = useState(false);

  const load = (accId: string) => {
    if (!accId) return;
    setLoading(true);
    listClientKpiRules(accId)
      .then(setRules)
      .catch(() => toast.error("Erro ao carregar regras"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(accountId); }, [accountId]);

  if (adAccounts.length === 0) {
    return <p className="text-sm text-muted-foreground">Vincule uma conta de anúncio ao cliente para configurar KPIs.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Conta de anúncio</label>
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {adAccounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.ad_account_name || a.ad_account_id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">Cada conta tem seus próprios limites de KPI, independentes das outras.</p>
      </div>

      <Tabs defaultValue="FASE 1">
        <TabsList className="grid grid-cols-4 w-full">
          {PRESET_BUCKETS.map((b) => <TabsTrigger key={b} value={b} className="text-xs">{b}</TabsTrigger>)}
        </TabsList>
        {PRESET_BUCKETS.map((bucket) => (
          <TabsContent key={bucket} value={bucket}>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando…
              </div>
            ) : (
              <BucketRules
                bucket={bucket}
                accountId={accountId}
                rules={rules.filter((r) => r.preset_bucket === bucket)}
                products={products}
                onChanged={() => load(accountId)}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

const metricLabel = (key: string) => METRIC_REGISTRY.find((m) => m.key === key)?.label || key;

// Linha de uma regra existente. A meta boa é editada/removida aqui, direto na linha — o form de
// criação (BucketRules.add) só cria a meta ruim; "boa" é sempre um passo posterior e opcional.
function RuleRow({
  rule,
  accountId,
  bucket,
  onChanged,
  onRemove,
}: {
  rule: ClientKpiRule;
  accountId: string;
  bucket: PresetBucket;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const [editingGood, setEditingGood] = useState(false);
  const [goodComparator, setGoodComparator] = useState<">" | "<">(rule.good_comparator || "<");
  const [goodThreshold, setGoodThreshold] = useState(rule.good_threshold_value != null ? String(rule.good_threshold_value) : "");
  const [saving, setSaving] = useState(false);
  const unit = getMetricDef(rule.metric_key)?.unit;
  const hasGood = rule.good_comparator != null && rule.good_threshold_value != null;

  // Sempre reenvia os campos "ruim" já existentes da própria `rule` — upsert reescreve a linha
  // inteira, e essa edição só deve tocar good_comparator/good_threshold_value.
  const persistGood = async (comparator: ">" | "<" | null, value: number | null) => {
    setSaving(true);
    try {
      await upsertKpiRule({
        client_ad_account_id: accountId,
        preset_bucket: bucket,
        metric_key: rule.metric_key,
        comparator: rule.comparator,
        threshold_value: rule.threshold_value,
        label_if_triggered: rule.label_if_triggered,
        campaign_name_filter: rule.campaign_name_filter,
        good_comparator: comparator,
        good_threshold_value: value,
      });
      setEditingGood(false);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message || "Erro ao salvar meta boa");
    } finally {
      setSaving(false);
    }
  };

  const saveGood = () => {
    const parsed = parseThreshold(goodThreshold);
    if (goodThreshold.trim() === "" || Number.isNaN(parsed)) {
      toast.error("Escolha um valor numérico pra meta boa");
      return;
    }
    persistGood(goodComparator, parsed);
  };

  return (
    <div className="flex flex-col gap-1.5 text-sm rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="flex-1">
          {metricLabel(rule.metric_key)} <span className="text-muted-foreground">{rule.comparator === ">" ? "acima de" : "abaixo de"}</span>{" "}
          <span className="font-medium">{formatMetricValue(rule.threshold_value, unit)}</span> → <span className="text-destructive">{rule.label_if_triggered}</span>
          {rule.preset_bucket === "L.T" && rule.campaign_name_filter && (
            <Badge variant="outline" className="ml-2 text-[10px]">produto: {rule.campaign_name_filter}</Badge>
          )}
        </span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {hasGood && !editingGood && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] border-success/30 text-success">
            bom {rule.good_comparator === ">" ? "acima de" : "abaixo de"} {formatMetricValue(rule.good_threshold_value, unit)}
          </Badge>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => setEditingGood(true)}>editar</Button>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-muted-foreground" disabled={saving} onClick={() => persistGood(null, null)}>
            remover
          </Button>
        </div>
      )}

      {!hasGood && !editingGood && (
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] w-fit text-success" onClick={() => setEditingGood(true)}>
          + definir meta boa
        </Button>
      )}

      {editingGood && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Select value={goodComparator} onValueChange={(v) => setGoodComparator(v as ">" | "<")}>
            <SelectTrigger className="w-[110px] h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value=">">acima de</SelectItem>
              <SelectItem value="<">abaixo de</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            {unit === "currency" && <span className="text-xs text-muted-foreground">R$</span>}
            <Input
              type="text"
              inputMode="decimal"
              value={goodThreshold}
              onChange={(e) => setGoodThreshold(e.target.value)}
              placeholder={unit === "currency" ? "0,00" : "valor"}
              className="w-[90px] h-7 text-xs"
            />
            {unit === "percent" && <span className="text-xs text-muted-foreground">%</span>}
          </div>
          <Button size="sm" className="h-7" onClick={saveGood} disabled={saving}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Salvar"}
          </Button>
          <Button variant="ghost" size="sm" className="h-7" disabled={saving} onClick={() => setEditingGood(false)}>Cancelar</Button>
        </div>
      )}
    </div>
  );
}

function BucketRules({
  bucket,
  accountId,
  rules,
  products,
  onChanged,
}: {
  bucket: PresetBucket;
  accountId: string;
  rules: ClientKpiRule[];
  products: ClientLtProduct[];
  onChanged: () => void;
}) {
  const [metric, setMetric] = useState("");
  const [comparator, setComparator] = useState<">" | "<">(">");
  const [threshold, setThreshold] = useState("");
  const [productName, setProductName] = useState("");
  const [saving, setSaving] = useState(false);
  const isLt = bucket === "L.T";

  // Para L.T a "métrica usada" é por produto: cpc pode existir pra [DDX] e pra [OUTRO] na mesma
  // conta. FASE 1/2/3 não têm produto, então o dedup é por métrica só.
  const usedMetrics = new Set(
    rules
      .filter((r) => !isLt || (r.campaign_name_filter || "").trim().toLowerCase() === productName.trim().toLowerCase())
      .map((r) => r.metric_key),
  );
  const available = METRIC_REGISTRY.filter((m) => !usedMetrics.has(m.key) && (!m.buckets || m.buckets.includes(bucket)));
  const selectedUnit = getMetricDef(metric)?.unit;

  const add = async () => {
    const parsedThreshold = parseThreshold(threshold);
    if (!metric || threshold.trim() === "" || Number.isNaN(parsedThreshold)) {
      toast.error("Escolha a métrica e um valor numérico");
      return;
    }
    if (isLt && productName.trim() === "") {
      toast.error("Informe o nome do produto pra essa regra L.T reconhecer as campanhas certas");
      return;
    }
    setSaving(true);
    try {
      await upsertKpiRule({
        client_ad_account_id: accountId,
        preset_bucket: bucket,
        metric_key: metric,
        comparator,
        threshold_value: parsedThreshold,
        campaign_name_filter: isLt ? productName.trim() : null,
      });
      setMetric(""); setThreshold(""); setComparator(">"); setProductName("");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message || "Erro ao salvar regra");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try { await deleteKpiRule(id); onChanged(); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-3 pt-2">
      {rules.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma regra para {bucket}.</p>}
      {rules.map((r) => (
        <RuleRow key={r.id} rule={r} accountId={accountId} bucket={bucket} onChanged={onChanged} onRemove={() => remove(r.id)} />
      ))}

      {isLt && products.length === 0 ? (
        <p className="text-sm text-muted-foreground">Cadastre produtos L.T na aba "Produtos L.T" antes de criar regras.</p>
      ) : (
        <div className="space-y-2 pt-1">
          {isLt && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Produto</label>
              <Select value={productName} onValueChange={setProductName}>
                <SelectTrigger className="w-[180px]"><SelectValue placeholder="Escolha o produto" /></SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.product_name}>{p.product_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {available.length > 0 ? (
            <div className="flex flex-wrap items-end gap-2">
              <Select value={metric} onValueChange={setMetric}>
                <SelectTrigger className="w-[220px]"><SelectValue placeholder="Métrica" /></SelectTrigger>
                <SelectContent>
                  {available.map((m) => (
                    <SelectItem key={m.key} value={m.key}>
                      <span className="flex items-center gap-1.5">
                        {m.label}
                        {!m.verified && <Badge variant="outline" className="text-[9px]">pendente</Badge>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={comparator} onValueChange={(v) => setComparator(v as ">" | "<")}>
                <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value=">">acima de</SelectItem>
                  <SelectItem value="<">abaixo de</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                {selectedUnit === "currency" && <span className="text-xs text-muted-foreground">R$</span>}
                <Input
                  type="text"
                  inputMode="decimal"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder={selectedUnit === "currency" ? "0,00" : "valor"}
                  className="w-[90px]"
                />
                {selectedUnit === "percent" && <span className="text-xs text-muted-foreground">%</span>}
              </div>
              <Button size="sm" onClick={add} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                <span className="ml-1">Adicionar</span>
              </Button>
            </div>
          ) : (
            isLt && productName && (
              <p className="text-[11px] text-muted-foreground">Todas as métricas já têm regra para "{productName}". Escolha outro produto para adicionar mais.</p>
            )
          )}
        </div>
      )}
    </div>
  );
}
