import { useEffect, useState } from "react";
import { Gauge, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fetchMetaStatus, fetchCampaigns, fetchCampaignInsights, pauseCampaign } from "@/lib/meta-api";
import { fetchClientKpiConfigs } from "@/lib/client-kpi-contract";
import { compareKpis, isDismissalActive, type OptimizationViolation } from "@/lib/optimization-engine";
import { getMetricDef } from "@/lib/meta-insights";

export default function OtimizacoesPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [violations, setViolations] = useState<OptimizationViolation[]>([]);
  const [accountErrors, setAccountErrors] = useState<string[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [pausingId, setPausingId] = useState<string | null>(null);
  const [confirmCampaign, setConfirmCampaign] = useState<OptimizationViolation | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const status = await fetchMetaStatus();
        if (!status.connected || !status.access_token) {
          if (!cancelled) setViolations([]);
          return;
        }
        if (!cancelled) setAccessToken(status.access_token);

        const configs = await fetchClientKpiConfigs();
        if (configs.length === 0) {
          if (!cancelled) setViolations([]);
          return;
        }

        const { data: { user } } = await supabase.auth.getUser();
        const { data: actioned } = await supabase
          .from("optimization_actions")
          .select("campaign_id, action, created_at")
          .eq("user_id", user?.id ?? "");
        // "paused" continua excluído pra sempre (evita flicker antes da Meta propagar a pausa).
        // "dismissed" (Manter) só silencia por 3 dias a partir do created_at — depois disso a
        // campanha volta a ficar elegível pra reaparecer se ainda estiver fora do KPI.
        const actionedIds = new Set(
          (actioned || [])
            .filter((row) => row.action === "paused" || (row.action === "dismissed" && isDismissalActive(row.created_at)))
            .map((row) => row.campaign_id)
        );

        const found: OptimizationViolation[] = [];
        const failedAccounts: string[] = [];
        for (const config of configs) {
          try {
            const campaigns = await fetchCampaigns(status.access_token, config.adAccountId);
            if (campaigns.length === 0) continue;

            const insights = await fetchCampaignInsights(status.access_token, campaigns.map((c: { id: string }) => c.id));

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
              continue;
            }

            const accountViolations = compareKpis(campaigns, insights, config);
            found.push(...accountViolations.filter((v) => !actionedIds.has(v.campaignId)));
          } catch (e) {
            console.error(`Falha ao avaliar otimizações da conta ${config.adAccountId} (${config.clientName})`, e);
            failedAccounts.push(config.clientName);
          }
        }

        if (!cancelled) {
          setViolations(found);
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
  }, [toast]);

  async function recordAction(violation: OptimizationViolation, action: "dismissed" | "paused") {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("optimization_actions").insert({
      user_id: user.id,
      campaign_id: violation.campaignId,
      ad_account_id: violation.adAccountId,
      action,
      metric_snapshot: { metric: violation.metric, actual: violation.actual, limit: violation.limit, operator: violation.operator },
    });
    setViolations((prev) => prev.filter((v) => v.campaignId !== violation.campaignId));
  }

  async function handleManter(violation: OptimizationViolation) {
    await recordAction(violation, "dismissed");
    toast({ title: "Campanha mantida", description: violation.campaignName });
  }

  async function handleDesligar(violation: OptimizationViolation) {
    if (!accessToken) return;
    setPausingId(violation.campaignId);
    try {
      await pauseCampaign(accessToken, violation.campaignId);
    } catch (e) {
      toast({ variant: "destructive", title: "Erro ao pausar campanha", description: (e as Error).message });
      setPausingId(null);
      setConfirmCampaign(null);
      return;
    }

    // A campanha já foi pausada de verdade na Meta neste ponto — o resto é só bookkeeping local.
    // Uma falha aqui não pode virar um falso "erro ao pausar" pro usuário.
    toast({ title: "Campanha pausada", description: violation.campaignName });
    setPausingId(null);
    setConfirmCampaign(null);

    try {
      await recordAction(violation, "paused");
    } catch (e) {
      console.error("Falha ao registrar pausa em optimization_actions (campanha já pausada na Meta)", e);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <div className="mb-8 fade-in-up">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 rounded-md bg-accent/15 border border-accent/20 flex items-center justify-center">
            <Gauge className="w-3.5 h-3.5 text-accent" />
          </div>
          <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Otimizações
          </span>
        </div>
        <h1 className="font-display text-2xl font-bold tracking-tight mb-1.5">
          Campanhas fora do <span className="text-gradient">limite</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Campanhas que estouraram um limite de KPI configurado na aba Clientes aparecem aqui.
        </p>
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

      {!loading && violations.length === 0 && accountErrors.length === 0 && (
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

      <div className="space-y-3">
        {violations.map((v, i) => (
          <Card
            key={v.campaignId}
            className="border-l-[3px] border-l-destructive/70 bg-destructive/[0.015] fade-in-up"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <CardHeader>
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-md bg-destructive/10 border border-destructive/20 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-base truncate">{v.campaignName}</CardTitle>
                  <p className="text-xs text-muted-foreground truncate">{v.clientName}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm mb-4">
                O KPI <strong>{getMetricDef(v.metric)?.label ?? v.metric}</strong> está em{" "}
                <strong>{v.actual.toFixed(2)}</strong> —{" "}
                {v.operator === ">" ? "acima" : "abaixo"} do limite de <strong>{v.limit}</strong>{" "}
                definido para este cliente. Essa campanha está performando fora do esperado.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => handleManter(v)}>
                  Manter
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
        ))}
      </div>

      <AlertDialog open={!!confirmCampaign} onOpenChange={(open) => !open && setConfirmCampaign(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pausar campanha?</AlertDialogTitle>
            <AlertDialogDescription>
              "{confirmCampaign?.campaignName}" vai ser pausada de verdade na Meta e para de veicular imediatamente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmCampaign && handleDesligar(confirmCampaign)}>
              Pausar campanha
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
