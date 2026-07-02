import { useEffect, useState } from "react";
import { Gauge, Loader2 } from "lucide-react";
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
import { compareKpis, type OptimizationViolation } from "@/lib/optimization-engine";

export default function OtimizacoesPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [violations, setViolations] = useState<OptimizationViolation[]>([]);
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
          .select("campaign_id")
          .eq("user_id", user?.id ?? "");
        const actionedIds = new Set((actioned || []).map((row) => row.campaign_id));

        const found: OptimizationViolation[] = [];
        for (const config of configs) {
          const campaigns = await fetchCampaigns(status.access_token, config.adAccountId);
          if (campaigns.length === 0) continue;

          const insights = await fetchCampaignInsights(status.access_token, campaigns.map((c: { id: string }) => c.id));
          const accountViolations = compareKpis(campaigns, insights, config);
          found.push(...accountViolations.filter((v) => !actionedIds.has(v.campaignId)));
        }

        if (!cancelled) setViolations(found);
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
  }

  async function handleDesligar(violation: OptimizationViolation) {
    if (!accessToken) return;
    setPausingId(violation.campaignId);
    try {
      await pauseCampaign(accessToken, violation.campaignId);
      await recordAction(violation, "paused");
      toast({ title: "Campanha pausada", description: violation.campaignName });
    } catch (e) {
      toast({ variant: "destructive", title: "Erro ao pausar campanha", description: (e as Error).message });
    } finally {
      setPausingId(null);
      setConfirmCampaign(null);
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

      {!loading && violations.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nenhuma otimização pendente. Isso acontece quando não há campanhas fora do limite, ou quando
          nenhum limite de KPI foi configurado ainda na aba Clientes.
        </p>
      )}

      <div className="space-y-3">
        {violations.map((v) => (
          <Card key={v.campaignId}>
            <CardHeader>
              <CardTitle className="text-base">{v.campaignName}</CardTitle>
              <p className="text-xs text-muted-foreground">{v.clientName}</p>
            </CardHeader>
            <CardContent>
              <p className="text-sm mb-4">
                <strong>{v.metric}</strong> em <strong>{v.actual.toFixed(2)}</strong>, limite é{" "}
                {v.operator} {v.limit}.
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
