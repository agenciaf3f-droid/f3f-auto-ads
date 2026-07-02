import { useEffect, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { fetchAdAccounts } from "@/lib/meta-api";
import {
  fetchClientInsights,
  aggregateByAccountBucket,
  bucketKey,
  evaluateRule,
  getMetricDef,
  PRESET_BUCKETS,
  OTHER_BUCKET,
  type AggregatedBucket,
  type DateRangeSelection,
  type PresetBucket,
} from "@/lib/meta-insights";
import { listClientKpiRules, type ClientAdAccount, type ClientKpiRule } from "@/lib/clients";
import DateRangeSelector from "./DateRangeSelector";

const formatValue = (unit: string, v: number): string => {
  if (unit === "percent") return `${v.toFixed(2)}%`;
  if (unit === "count") return String(Math.round(v));
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export default function ClientKpiDashboard({
  adAccounts,
  accessToken,
}: {
  adAccounts: ClientAdAccount[];
  accessToken?: string;
}) {
  const [range, setRange] = useState<DateRangeSelection>({ mode: "preset", preset: "last_30d" });
  const [loading, setLoading] = useState(false);
  const [aggregates, setAggregates] = useState<Map<string, AggregatedBucket>>(new Map());
  const [rulesByAccount, setRulesByAccount] = useState<Record<string, ClientKpiRule[]>>({});
  const [errors, setErrors] = useState<{ ad_account_id: string; message: string }[]>([]);
  const [currencyById, setCurrencyById] = useState<Record<string, string>>({});

  const adAccountIds = adAccounts.map((a) => a.ad_account_id);

  useEffect(() => {
    if (!accessToken || adAccounts.length === 0) return;
    if (range.mode === "custom" && (!range.since || !range.until)) return;

    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [{ insights, errors: errs }, rulesLists] = await Promise.all([
          fetchClientInsights(accessToken, adAccountIds, range),
          Promise.all(adAccounts.map((a) => listClientKpiRules(a.id).then((r) => [a.id, r] as const))),
        ]);
        if (cancelled) return;
        setAggregates(aggregateByAccountBucket(insights));
        setErrors(errs);
        setRulesByAccount(Object.fromEntries(rulesLists));
      } catch (e) {
        if (!cancelled) toast.error((e as Error).message || "Erro ao carregar métricas");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, range, adAccounts.map((a) => a.id).join(",")]);

  // currency por conta (badge) — busca 1x
  useEffect(() => {
    if (!accessToken) return;
    fetchAdAccounts(accessToken)
      .then((accs: { id: string; currency?: string | null }[]) => {
        setCurrencyById(Object.fromEntries(accs.map((a) => [a.id, a.currency || ""])));
      })
      .catch(() => {});
  }, [accessToken]);

  if (!accessToken) {
    return <p className="text-sm text-muted-foreground">Conecte a conta Meta em Configurações para ver as métricas.</p>;
  }
  if (adAccounts.length === 0) {
    return <p className="text-sm text-muted-foreground">Vincule uma conta de anúncio para ver o dashboard.</p>;
  }

  return (
    <div className="space-y-4">
      <DateRangeSelector value={range} onChange={setRange} />

      {errors.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-1">
          {errors.map((e) => (
            <div key={e.ad_account_id} className="flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span><span className="font-mono">{e.ad_account_id}</span>: {e.message}</span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando métricas…
        </div>
      ) : (
        <div className="space-y-4">
          {adAccounts.map((acc) => (
            <AccountCard
              key={acc.id}
              account={acc}
              currency={currencyById[acc.ad_account_id]}
              rules={rulesByAccount[acc.id] || []}
              aggregates={aggregates}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountCard({
  account,
  currency,
  rules,
  aggregates,
}: {
  account: ClientAdAccount;
  currency?: string;
  rules: ClientKpiRule[];
  aggregates: Map<string, AggregatedBucket>;
}) {
  const bucketsWithRules = PRESET_BUCKETS.filter((b) => rules.some((r) => r.preset_bucket === b));
  // Decisão #9: campanhas sem preset reconhecido caem em "Outros" — não avaliadas por
  // KPI, mas exibidas como total à parte para não sumirem silenciosamente.
  const other = aggregates.get(bucketKey(account.ad_account_id, OTHER_BUCKET));

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="font-display font-semibold text-sm">{account.ad_account_name || account.ad_account_id}</h3>
        {currency && <Badge variant="outline" className="text-[10px]">{currency}</Badge>}
      </div>

      {bucketsWithRules.length === 0 && !other ? (
        <p className="text-xs text-muted-foreground">Nenhuma regra de KPI configurada para esta conta.</p>
      ) : (
        <div className="space-y-3">
          {bucketsWithRules.map((bucket) => (
            <BucketBlock
              key={bucket}
              bucket={bucket}
              rules={rules.filter((r) => r.preset_bucket === bucket)}
              agg={aggregates.get(bucketKey(account.ad_account_id, bucket))}
            />
          ))}
          {other && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground border-t pt-2">
              <span className="font-semibold uppercase tracking-wide">Outros</span>
              <span>{other.campaignCount} camp. fora dos presets</span>
              <span className="ml-auto tabular-nums">
                gasto {other.spend.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BucketBlock({
  bucket,
  rules,
  agg,
}: {
  bucket: PresetBucket;
  rules: ClientKpiRule[];
  agg?: AggregatedBucket;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">{bucket}</span>
        {agg ? (
          <span className="text-[11px] text-muted-foreground">{agg.campaignCount} camp.</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">sem dados na janela</span>
        )}
      </div>
      <div className="space-y-1">
        {rules.map((rule) => {
          const def = getMetricDef(rule.metric_key);
          const evalr = evaluateRule(rule, agg);
          return (
            <div key={rule.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1 text-muted-foreground">{def?.label || rule.metric_key}</span>
              {evalr.computable && evalr.value !== null ? (
                <>
                  <span className="font-medium tabular-nums">{formatValue(def?.unit || "currency", evalr.value)}</span>
                  {evalr.triggered ? (
                    <Badge className="gap-1 bg-destructive/10 text-destructive border-destructive/20" variant="outline">
                      <XCircle className="h-3 w-3" /> {rule.label_if_triggered}
                    </Badge>
                  ) : (
                    <Badge className="gap-1 bg-success/10 text-success border-success/20" variant="outline">
                      <CheckCircle2 className="h-3 w-3" /> ok
                    </Badge>
                  )}
                </>
              ) : (
                <span className="text-xs text-muted-foreground">sem dados</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
