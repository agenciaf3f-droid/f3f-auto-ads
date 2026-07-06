// Helper de envio de texto no WhatsApp via UAZAPI (instância única da agência).
// Espelha o formato de _shared/email.ts: config-getter + função de envio que
// retorna { ok } | { ok:false, reason }. Token da instância vem SEMPRE de secret.

type UazapiConfig =
  | { ok: true; baseUrl: string; token: string }
  | { ok: false; reason: string };

function getUazapiConfig(): UazapiConfig {
  const baseUrl = Deno.env.get("UAZAPI_BASE_URL");
  const token = Deno.env.get("UAZAPI_INSTANCE_TOKEN");
  if (!baseUrl) return { ok: false, reason: "UAZAPI_BASE_URL ausente" };
  if (!token) return { ok: false, reason: "UAZAPI_INSTANCE_TOKEN ausente" };
  // Remove barra final pra montar o path de forma previsível.
  return { ok: true, baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

// Envia uma mensagem de texto pro grupo/número informado.
// `groupId` é o JID (ex.: "...@g.us") ou número aceito pela UAZAPI.
export async function sendWhatsAppText({
  groupId,
  text,
}: {
  groupId: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const config = getUazapiConfig();
  if (!config.ok) {
    console.log(`[uazapi] Envio desativado (${config.reason})`);
    return { ok: false, reason: config.reason };
  }
  const { baseUrl, token } = config;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/send/text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        token,
      },
      body: JSON.stringify({ number: groupId, text, linkPreview: true }),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[uazapi] Falha de rede:", reason);
    return { ok: false, reason };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[uazapi] HTTP ${res.status}: ${detail.slice(0, 500)}`);
    return { ok: false, reason: `UAZAPI HTTP ${res.status}` };
  }

  return { ok: true };
}
