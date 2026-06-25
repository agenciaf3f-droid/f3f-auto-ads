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
  return `${prefix} - ${campaignName}`;
}

// L.T (low-ticket) tem formato próprio (TESTE e CRIATIVO fixos):
// [PRODUTO] [L.T] [dd/mm] [ABO|CBO] [TESTE] [CRIATIVO] -
export function generateLtCampaignName({
  productName,
  presetLabel,
  structure,
  date,
}: {
  productName: string;
  presetLabel: string;
  structure: string;      // ABO | CBO
  date?: string;          // dd/mm
}) {
  let d = date;
  if (!d) {
    const now = new Date();
    d = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  return `[${productName}] [${presetLabel}] [${d}] [${structure}] [TESTE] [CRIATIVO] -`;
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
