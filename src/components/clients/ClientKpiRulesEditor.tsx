import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { PRESET_BUCKETS, METRIC_REGISTRY, type PresetBucket } from "@/lib/meta-insights";
import {
  listClientKpiRules,
  upsertKpiRule,
  deleteKpiRule,
  type ClientAdAccount,
  type ClientKpiRule,
} from "@/lib/clients";

export default function ClientKpiRulesEditor({ adAccounts }: { adAccounts: ClientAdAccount[] }) {
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
                onChanged={() => load(accountId)}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function BucketRules({
  bucket,
  accountId,
  rules,
  onChanged,
}: {
  bucket: PresetBucket;
  accountId: string;
  rules: ClientKpiRule[];
  onChanged: () => void;
}) {
  const usedMetrics = new Set(rules.map((r) => r.metric_key));
  const available = METRIC_REGISTRY.filter((m) => !usedMetrics.has(m.key));

  const [metric, setMetric] = useState("");
  const [comparator, setComparator] = useState<">" | "<">(">");
  const [threshold, setThreshold] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (!metric || threshold.trim() === "" || Number.isNaN(Number(threshold))) {
      toast.error("Escolha a métrica e um valor numérico");
      return;
    }
    setSaving(true);
    try {
      await upsertKpiRule({
        client_ad_account_id: accountId,
        preset_bucket: bucket,
        metric_key: metric,
        comparator,
        threshold_value: Number(threshold),
      });
      setMetric(""); setThreshold(""); setComparator(">");
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

  const metricLabel = (key: string) => METRIC_REGISTRY.find((m) => m.key === key)?.label || key;

  return (
    <div className="space-y-3 pt-2">
      {rules.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma regra para {bucket}.</p>}
      {rules.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-sm rounded-md border px-3 py-2">
          <span className="flex-1">
            {metricLabel(r.metric_key)} <span className="text-muted-foreground">{r.comparator === ">" ? "acima de" : "abaixo de"}</span>{" "}
            <span className="font-medium">{r.threshold_value}</span> → <span className="text-destructive">{r.label_if_triggered}</span>
          </span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(r.id)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {available.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 pt-1">
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
          <Input
            type="number"
            step="any"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="valor"
            className="w-[110px]"
          />
          <Button size="sm" onClick={add} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            <span className="ml-1">Adicionar</span>
          </Button>
        </div>
      )}
    </div>
  );
}
