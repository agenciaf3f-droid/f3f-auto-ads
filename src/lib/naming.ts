export function generateCampaignName({
  presetLabel,
  publicName,
  budget,
  campaignName,
  date,
}: {
  presetLabel: string;
  publicName: string;
  budget: number;
  campaignName: string;
  date?: string;
}) {
  const d = date || new Date().toISOString().slice(0, 10);
  const prefix = `[${presetLabel}] [GERENCIADOR] [${d}] [${publicName}] [R$${budget}]`;
  return campaignName.trim() ? `${prefix} - ${campaignName}` : prefix;
}

// L.T (low-ticket) tem formato próprio (TESTE e CRIATIVO fixos):
// [NOMENCLATURA] [L.T] [dd/mm] [ABO|CBO] [TESTE] [CRIATIVO] - SUFIXO
export function generateLtCampaignName({
  nomenclatura,
  presetLabel,
  structure,
  date,
  suffix,
}: {
  nomenclatura: string;
  presetLabel: string;
  structure: string;      // ABO | CBO
  date?: string;          // dd/mm
  suffix?: string;        // texto livre após o traço (opcional; vazio = termina em "-")
}) {
  let d = date;
  if (!d) {
    const now = new Date();
    d = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const prefix = `[${nomenclatura}] [${presetLabel}] [${d}] [${structure}] [TESTE] [CRIATIVO] -`;
  return suffix?.trim() ? `${prefix} ${suffix.trim()}` : prefix;
}

export function generateAdsetName({
  publicName,
  adsetName,
}: {
  publicName: string;
  adsetName: string;
}) {
  return `[${publicName}] - ${adsetName}`;
}

export function generateAdName_v2({
  adName,
}: {
  adName: string;
}) {
  return adName;
}

// Legacy compat
export function generateNames({
  presetLabel,
  publicName,
  budget,
  campaignName,
  adsetName,
  adName,
  date,
}: {
  presetLabel: string;
  publicName: string;
  budget: number;
  campaignName: string;
  adsetName: string;
  adName: string;
  date?: string;
}) {
  return {
    campaign: generateCampaignName({ presetLabel, publicName, budget, campaignName, date }),
    adset: generateAdsetName({ publicName, adsetName }),
    ad: generateAdName_v2({ adName }),
  };
}

// Keep backward compat
export function generateAdName({
  mode,
  publicName,
  budget,
  creativeName,
  date,
}: {
  mode: string;
  publicName: string;
  budget: number;
  creativeName: string;
  date?: string;
}) {
  const d = date || new Date().toISOString().slice(0, 10);
  return `[FASE 1] [${mode}] [${d}] [${publicName}] [R$${budget}] - [${creativeName}]`;
}
