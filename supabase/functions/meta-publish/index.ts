import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractDriveFileId, buildDriveApiUrl } from "../_shared/drive.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface StepLog {
  step: string;
  status: "start" | "success" | "error";
  ts: string;
  detail?: string;
}

function ts() { return new Date().toISOString(); }

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePayload(obj: Record<string, any>): Record<string, any> {
  const clean = { ...obj };
  delete clean.access_token;
  delete clean.app_secret;
  return clean;
}

function formatMetaError(err: any) {
  return {
    error_message: err?.message || "Erro desconhecido",
    error_code: err?.code || null,
    error_subcode: err?.error_subcode || null,
    error_user_msg: err?.error_user_msg || "",
    error_user_title: err?.error_user_title || "",
    raw_error: err || null,
  };
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForHash(item));
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeForHash((value as Record<string, unknown>)[key]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return value;
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildAdsetFingerprintInput(args: {
  adsetPayload: Record<string, any>;
  adAccountId: string;
  presetLabel: string;
  structure: string;
}) {
  const cleanAdset = sanitizePayload({ ...args.adsetPayload });
  delete cleanAdset.campaign_id;

  return normalizeForHash({
    type: "adset_publish",
    preset: args.presetLabel,
    structure: args.structure,
    ad_account_id: args.adAccountId,
    adset_payload: cleanAdset,
  });
}

async function fetchJsonWithTiming(url: string, init?: RequestInit): Promise<{ data: any; elapsedMs: number; status: number }> {
  const startedAt = Date.now();
  const mergedInit: RequestInit = {
    ...(init || {}),
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  };
  const res = await fetch(url, mergedInit);
  const elapsedMs = Date.now() - startedAt;

  try {
    const data = await res.json();
    return { data, elapsedMs, status: res.status };
  } catch {
    return {
      elapsedMs,
      status: res.status,
      data: {
        error: {
          message: "Resposta não-JSON da Meta API",
          code: "NON_JSON_RESPONSE",
          error_subcode: null,
        },
      },
    };
  }
}

async function acquireAdsetDedupeLock(params: {
  db: any;
  userId: string;
  fingerprint: string;
  windowMinutes: number;
  requestPayload: Record<string, any>;
  stepLabel: string;
  presetLabel: string;
}) {
  const sinceIso = new Date(Date.now() - params.windowMinutes * 60 * 1000).toISOString();
  const filterJson = { kind: "adset_publish", fingerprint: params.fingerprint };

  const { data: existing, error: existingError } = await params.db
    .from("publish_jobs")
    .select("id, status, created_at")
    .eq("user_id", params.userId)
    .contains("request_json", filterJson)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1);

  if (existingError) {
    console.log(`[idempotency] lookup error (${params.stepLabel}): ${existingError.message}`);
  }

  const latest = existing?.[0];
  if (latest) {
    const isInProgress = latest.status === "in_progress";
    const warningMessage = isInProgress
      ? `Publicação duplicada bloqueada: já existe uma execução em andamento para este payload (fingerprint=${params.fingerprint.slice(0, 12)}).`
      : `Publicação duplicada bloqueada: este payload já foi enviado recentemente. Aguarde ${params.windowMinutes} minutos para reenviar.`;

    return {
      allowed: false,
      warningMessage,
      existingJobId: latest.id,
      existingStatus: latest.status,
    };
  }

  const requestJson = {
    kind: "adset_publish",
    preset: params.presetLabel,
    step: params.stepLabel,
    fingerprint: params.fingerprint,
    payload: params.requestPayload,
    started_at: ts(),
  };

  const { data: inserted, error: insertError } = await params.db
    .from("publish_jobs")
    .insert({
      user_id: params.userId,
      status: "in_progress",
      request_json: requestJson,
    })
    .select("id, created_at")
    .single();

  if (insertError || !inserted) {
    console.log(`[idempotency] insert error (${params.stepLabel}): ${insertError?.message || "unknown"}`);
    return {
      allowed: false,
      warningMessage: "Não foi possível registrar o lock de idempotência. Tente novamente em instantes.",
    };
  }

  const { data: runningRows } = await params.db
    .from("publish_jobs")
    .select("id")
    .eq("user_id", params.userId)
    .eq("status", "in_progress")
    .contains("request_json", filterJson)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(2);

  if (runningRows?.length && runningRows[0].id !== inserted.id) {
    await params.db
      .from("publish_jobs")
      .update({
        status: "dedupe_blocked",
        response_json: {
          reason: "concurrent_duplicate",
          winner_job_id: runningRows[0].id,
          blocked_at: ts(),
        },
      })
      .eq("id", inserted.id);

    return {
      allowed: false,
      warningMessage: `Publicação duplicada concorrente bloqueada: já existe uma execução ativa para este payload (fingerprint=${params.fingerprint.slice(0, 12)}).`,
    };
  }

  return { allowed: true, lockId: inserted.id };
}

async function finalizeAdsetDedupeLock(params: {
  db: any;
  lockId?: string;
  status: string;
  response: Record<string, any>;
}) {
  if (!params.lockId) return;

  const { error } = await params.db
    .from("publish_jobs")
    .update({
      status: params.status,
      response_json: {
        ...params.response,
        finalized_at: ts(),
      },
    })
    .eq("id", params.lockId);

  if (error) {
    console.log(`[idempotency] finalize error: ${error.message}`);
  }
}

async function runFase3SanityChecks(params: {
  accessToken: string;
  adAccountId: string;
  pageId: string;
  whatsappPhoneId: string;
}) {
  const checks: Record<string, any> = {};

  // Em v25 o subfield whatsapp_business_account não existe mais no node de phone.
  // Query só campos válidos. Se Meta rejeitar o phone na criação do adset, o erro vai
  // aparecer no passo certo — não tentamos cross-validar via WABA aqui.
  const [pageCheck, phoneCheck] = await Promise.all([
    fetchJsonWithTiming(
      `https://graph.facebook.com/v25.0/${params.pageId}?fields=id,name&access_token=${params.accessToken}`,
    ),
    fetchJsonWithTiming(
      `https://graph.facebook.com/v25.0/${params.whatsappPhoneId}?fields=id,display_phone_number,verified_name&access_token=${params.accessToken}`,
    ),
  ]);

  // Rate limit / transitório (#4 app, #17 user, #2, etc.): se a pré-checagem já bate nisso,
  // TODAS as chamadas seguintes também batem — prosseguir só estoura o timeout da edge. Falha
  // RÁPIDO com mensagem clara pro gestor aguardar (não prossegue pra não dar non-2xx opaco).
  const isTransient = (err: any) =>
    !!err && (err.is_transient === true || [1, 2, 4, 17, 32, 341, 613].includes(Number(err.code)));
  const rateLimitMsg = (e: any) =>
    `Limite de requisições da Meta atingido (${e.message}). Aguarde ~15 min e publique de novo — não é erro de configuração.`;

  checks.page = { elapsed_ms: pageCheck.elapsedMs, status: pageCheck.status, response: pageCheck.data };
  if (pageCheck.data?.error) {
    const e = pageCheck.data.error;
    return {
      ok: false,
      rate_limited: isTransient(e),
      error_message: isTransient(e) ? rateLimitMsg(e) : `Sem acesso à Página ${params.pageId}: ${e.message}`,
      checks,
    };
  }

  checks.whatsapp_phone = { elapsed_ms: phoneCheck.elapsedMs, status: phoneCheck.status, response: phoneCheck.data };
  if (phoneCheck.data?.error) {
    const e = phoneCheck.data.error;
    return {
      ok: false,
      rate_limited: isTransient(e),
      error_message: isTransient(e) ? rateLimitMsg(e) : `WhatsApp Phone ID inválido/inacessível (${params.whatsappPhoneId}): ${e.message}`,
      checks,
    };
  }

  return { ok: true, checks };
}

function cleanTargeting(t: Record<string, any>): Record<string, any> {
  const clean = { ...t };
  delete clean.targeting_optimization;
  delete clean.brand_safety_content_filter_levels;
  return clean;
}

function validateFase3PromotedObject(promotedObject: Record<string, any>) {
  // Meta v25: promoted_object FASE 3 aceita { page_id, smart_pse_enabled, whatsapp_phone_number }.
  // NÃO incluir whats_app_business_phone_number_id (Meta rejeita com 2446886).
  const requiredKeys = ["page_id", "whatsapp_phone_number"];
  // pixel_id + custom_event_type adicionados pra suportar FASE 3 VENDAS ZAP (otimização compra)
  const allowedKeys = [...requiredKeys, "smart_pse_enabled", "pixel_id", "custom_event_type"];
  const keys = Object.keys(promotedObject || {});
  const unexpectedKeys = keys.filter((k) => !allowedKeys.includes(k));
  const missingRequired = requiredKeys.filter((k) => !promotedObject?.[k] && promotedObject?.[k] !== false);

  if (unexpectedKeys.length > 0 || missingRequired.length > 0) {
    return {
      ok: false,
      keys,
      unexpectedKeys,
      missingRequired,
      message: "promoted_object inválido",
    };
  }

  return { ok: true, keys, message: "VALIDAÇÃO OK — promoted_object contém page_id + whatsapp_phone_number" };
}

function validateFase3Targeting(t: Record<string, any>) {
  const errors: string[] = [];
  if (typeof t.age_min !== "number" || t.age_min < 13 || t.age_min > 65) errors.push(`age_min inválido (13-65): ${t.age_min}`);
  if (typeof t.age_max !== "number" || t.age_max < 13 || t.age_max > 65) errors.push(`age_max inválido (13-65): ${t.age_max}`);
  if (typeof t.age_min === "number" && typeof t.age_max === "number" && t.age_min > t.age_max) errors.push(`age_min (${t.age_min}) > age_max (${t.age_max})`);
  if (!t.geo_locations?.countries) errors.push("geo_locations.countries ausente");
  if (!t.geo_locations?.location_types) errors.push("geo_locations.location_types ausente");
  if (!t.targeting_automation) errors.push("targeting_automation ausente");
  else {
    if (t.targeting_automation.advantage_audience !== 0) errors.push("advantage_audience deve ser 0");
  }
  return { ok: errors.length === 0, errors };
}

function validateFase3Attribution(attr: any[]) {
  if (!Array.isArray(attr) || attr.length === 0) return { ok: false, error: "attribution_spec ausente" };
  const first = attr[0];
  if (first.event_type !== "CLICK_THROUGH" || first.window_days !== 1) {
    return { ok: false, error: `attribution_spec deve ser CLICK_THROUGH/1d, encontrado: ${first.event_type}/${first.window_days}d` };
  }
  return { ok: true };
}

function buildTargeting(audienceType: string, audienceId: string, targetingSpec: any, locationTargeting?: { included?: any[]; excluded?: any[] }) {
  let base: Record<string, any>;
  if (audienceType === "saved" && targetingSpec) {
    base = cleanTargeting({ ...targetingSpec });
  } else {
    base = {
      custom_audiences: [{ id: audienceId }],
      geo_locations: { countries: ["BR"] },
    };
  }
  // age_range só é válido com targeting_automation ativado (Advantage+ Audience).
  // Todos os presets forçam advantage_audience=0, então removemos age_range —
  // age_min/age_max (campos manuais) cobrem o targeting de idade.
  delete base.age_range;

  if (locationTargeting?.included && locationTargeting.included.length > 0) {
    const geo: Record<string, any> = {};
    const countries: string[] = [];
    const regions: { key: string }[] = [];
    const cities: { key: string }[] = [];
    for (const loc of locationTargeting.included) {
      if (loc.type === "country") countries.push(loc.country_code || loc.key);
      else if (loc.type === "region") regions.push({ key: loc.key });
      else if (loc.type === "city") cities.push({ key: loc.key });
      else regions.push({ key: loc.key });
    }
    if (countries.length) geo.countries = countries;
    if (regions.length) geo.regions = regions;
    if (cities.length) geo.cities = cities;
    base.geo_locations = geo;

    if (locationTargeting.excluded && locationTargeting.excluded.length > 0) {
      const exCountries: string[] = [];
      const exRegions: { key: string }[] = [];
      const exCities: { key: string }[] = [];
      for (const loc of locationTargeting.excluded) {
        if (loc.type === "country") exCountries.push(loc.country_code || loc.key);
        else if (loc.type === "region") exRegions.push({ key: loc.key });
        else if (loc.type === "city") exCities.push({ key: loc.key });
        else exRegions.push({ key: loc.key });
      }
      const exGeo: Record<string, any> = {};
      if (exCountries.length) exGeo.countries = exCountries;
      if (exRegions.length) exGeo.regions = exRegions;
      if (exCities.length) exGeo.cities = exCities;
      base.excluded_geo_locations = exGeo;
    }
  }
  return base;
}

// =====================================================================
//  INSTAGRAM MEDIA RESOLUTION (shared by FASE 1 and FASE 3)
// =====================================================================

async function resolveInstagramMediaId(
  accessToken: string,
  adAccountId: string,
  igLink: string,
  knownPageId?: string,
  knownIgActorId?: string,
  logs: StepLog[] = [],
): Promise<{
  instagram_media_id?: string;
  ig_account_id?: string;
  page_id?: string;
  shortcode?: string;
  media_permalink?: string;
  media_type?: string;
  error?: string;
}> {
  const normalizeUrl = (value?: string) => (value || "").trim().toLowerCase().split("?")[0].replace(/\/+$/, "");

  const normalizedLink = normalizeUrl(igLink);
  console.log(`[ig_input] normalized_link=${normalizedLink}`);

  const match = normalizedLink.match(/instagram\.com\/(?:.*\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) {
    const err = "Link inválido: shortcode não encontrado (formatos suportados: /p/, /reel/, /reels/, /tv/).";
    logs.push({ step: "ig_input", status: "error", ts: ts(), detail: err });
    return { error: err };
  }

  const shortcode = match[2];
  console.log(`[ig_input] type=${match[1]}, shortcode=${shortcode}`);
  logs.push({ step: "ig_input", status: "success", ts: ts(), detail: `type=${match[1]}, shortcode=${shortcode}` });

  const shortcodeLc = shortcode.toLowerCase();
  const resolveMediaFromIgActor = async (
    igActorId: string,
    pageId?: string,
  ): Promise<{ mediaId?: string; permalink?: string; pageId?: string; igActorId?: string; mediaType?: string; error?: string }> => {
    let url: string | null = `https://graph.facebook.com/v25.0/${igActorId}/media?fields=id,shortcode,permalink,media_type&limit=100&access_token=${accessToken}`;
    let scanned = 0;
    while (url && scanned < 500) {
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        logs.push({ step: "ig_media_resolve", status: "error", ts: ts(), detail: `ig_actor=${igActorId}, code=${data.error.code}, msg=${data.error.message}` });
        return { error: `Falha ao resolver mídia do IG: ${data.error.message}` };
      }
      const items = data.data || [];
      scanned += items.length;
      const found = items.find((m: any) => {
        const sc = (m.shortcode || "").toLowerCase();
        if (sc === shortcodeLc) return true;
        const permalinkLc = (m.permalink || "").toLowerCase();
        return permalinkLc.includes(`/${shortcodeLc}`);
      });
      if (found) {
        console.log(`[ig_media_resolve] FOUND media_id=${found.id}, type=${found.media_type}, ig_actor=${igActorId}, scanned=${scanned}`);
        logs.push({ step: "ig_media_resolve", status: "success", ts: ts(), detail: `media_id=${found.id}, type=${found.media_type}, ig_actor=${igActorId}, scanned=${scanned}` });
        return { mediaId: found.id, permalink: found.permalink, mediaType: found.media_type, pageId, igActorId };
      }
      url = data.paging?.next || null;
    }
    return {};
  };

  let resolvedMedia: { mediaId?: string; permalink?: string; pageId?: string; igActorId?: string; mediaType?: string; error?: string } = {};

  if (knownIgActorId) {
    resolvedMedia = await resolveMediaFromIgActor(knownIgActorId, knownPageId);
    if (resolvedMedia.error) return { error: resolvedMedia.error };
  }

  if (!resolvedMedia.mediaId && !knownIgActorId) {
    let pagesUrl: string | null = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,instagram_business_account{id}&limit=25&access_token=${accessToken}`;
    while (pagesUrl && !resolvedMedia.mediaId) {
      const pagesRes = await fetch(pagesUrl);
      const pagesData = await pagesRes.json();
      if (pagesData.error) {
        logs.push({ step: "ig_media_resolve", status: "error", ts: ts(), detail: pagesData.error.message });
        return { error: `Falha ao listar páginas: ${pagesData.error.message}` };
      }
      for (const page of pagesData.data || []) {
        if (!page.instagram_business_account?.id) continue;
        const hit = await resolveMediaFromIgActor(page.instagram_business_account.id, page.id);
        if (hit.error) return { error: hit.error };
        if (hit.mediaId) { resolvedMedia = hit; break; }
      }
      pagesUrl = pagesData.paging?.next || null;
    }
  } else if (!resolvedMedia.mediaId && knownIgActorId) {
    const err = `media_id não encontrado para shortcode=${shortcode} na conta IG ${knownIgActorId}.`;
    logs.push({ step: "ig_media_resolve", status: "error", ts: ts(), detail: err });
    return { error: err };
  }

  if (!resolvedMedia.mediaId) {
    const err = `media_id não encontrado para shortcode=${shortcode}.`;
    logs.push({ step: "ig_media_resolve", status: "error", ts: ts(), detail: err });
    return { error: err };
  }

  return {
    instagram_media_id: resolvedMedia.mediaId,
    ig_account_id: resolvedMedia.igActorId || knownIgActorId,
    page_id: resolvedMedia.pageId || knownPageId,
    shortcode,
    media_permalink: resolvedMedia.permalink,
    media_type: resolvedMedia.mediaType,
  };
}

// =====================================================================
//  DRIVE UPLOAD (shared)
// =====================================================================

async function uploadDriveCreative(
  accessToken: string,
  adAccountId: string,
  driveLink: string
): Promise<{ image_hash?: string; video_id?: string; error?: string }> {
  const fileId = extractDriveFileId(driveLink);
  // Candidatos em ordem: Drive API key (bypassa interstitial) → uc?confirm=t → usercontent.
  const driveApiKey = Deno.env.get("GOOGLE_DRIVE_API_KEY");
  const apiUrl = fileId && driveApiKey ? buildDriveApiUrl(fileId, driveApiKey) : null;
  const candidateUrls: string[] = [];
  if (fileId) {
    if (apiUrl) candidateUrls.push(apiUrl);
    candidateUrls.push(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`);
    candidateUrls.push(`https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`);
  } else {
    candidateUrls.push(driveLink);
  }

  // Fast-path SEM buffer na edge: com a API key do Drive, a URL devolve bytes crus
  // (sem o HTML interstitial de vírus/quota). Mandamos file_url e a Meta baixa o
  // vídeo direto — evita carregar vídeos grandes na memória da edge (OOM → worker
  // morto → "Failed to send a request"). Só vale pra vídeo — um probe (Range dos
  // 16 primeiros bytes) decide antes, senão imagem perde ~25s de poll de vídeo à toa.
  if (apiUrl) {
    let looksLikeVideo = true; // probe inconclusivo (erro/timeout) → tenta o fast-path mesmo assim
    try {
      const probe = await fetch(apiUrl, { headers: { Range: "bytes=0-15" }, signal: AbortSignal.timeout(15_000) });
      const probeCt = probe.headers.get("content-type") || "";
      if (probeCt.includes("image")) looksLikeVideo = false;
    } catch (e) {
      console.log(`[drive-upload] probe failed (assumindo vídeo): ${(e as Error).message}`);
    }

    if (looksLikeVideo) {
      try {
        const fd = new FormData();
        fd.append("access_token", accessToken);
        fd.append("file_url", apiUrl);
        const up = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/advideos`, { method: "POST", body: fd });
        const upd = await up.json();
        if (!upd.error && upd.id) {
          const videoId = upd.id;
          let sawError = false;
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 2500));
            try {
              const stRes = await fetch(`https://graph.facebook.com/v25.0/${videoId}?fields=status&access_token=${accessToken}`);
              const stData = await stRes.json();
              const vs = stData?.status?.video_status || stData?.status;
              console.log(`[drive-upload] file_url video ${videoId} poll ${i + 1}: ${JSON.stringify(stData?.status)}`);
              if (vs === "ready") return { video_id: videoId };
              if (vs === "error") { sawError = true; break; }
            } catch (e) { console.log(`[drive-upload] file_url poll error: ${(e as Error).message}`); }
          }
          if (!sawError) return { video_id: videoId }; // ainda processando → assume ok (ad creation reporta se não)
          // Meta processou e deu erro no vídeo criado via file_url — apaga antes
          // de cair no fallback buffered, senão fica órfão na biblioteca da conta.
          try {
            await fetch(`https://graph.facebook.com/v25.0/${videoId}?access_token=${accessToken}`, { method: "DELETE" });
          } catch (e) { console.log(`[drive-upload] falha ao limpar vídeo ${videoId}: ${(e as Error).message}`); }
        } else if (upd.error) {
          console.log(`[drive-upload] file_url /advideos error (fallback buffered): ${JSON.stringify(upd.error)}`);
        }
      } catch (e) {
        console.log(`[drive-upload] file_url path exception (fallback buffered): ${(e as Error).message}`);
      }
    }
    // file_url não resolveu ou não é vídeo → segue pro download buffered abaixo
  }

  const DOWNLOAD_HEADERS: HeadersInit = {
    "User-Agent": "Mozilla/5.0 (compatible; f3f-auto-ads/1.0)",
    "Accept": "*/*",
  };

  let fileRes: Response | null = null;
  let contentType = "";
  let contentDisp = "";
  let fileBlob: Blob | null = null;
  let downloadUrl = candidateUrls[0];

  for (const url of candidateUrls) {
    downloadUrl = url;
    const r = await fetch(url, { redirect: "follow", headers: DOWNLOAD_HEADERS });
    if (!r.ok) { console.log(`[drive-upload] ${url} status=${r.status}`); continue; }
    const ct = r.headers.get("content-type") || "";
    const cd = r.headers.get("content-disposition") || "";
    if (ct.includes("text/html") || ct.includes("text/plain")) {
      // Parse confirm token do HTML pra retry final
      try {
        const html = await r.text();
        const confirmTok = html.match(/confirm=([0-9A-Za-z_-]+)/)?.[1];
        const uuidTok = html.match(/uuid=([0-9A-Fa-f-]+)/)?.[1];
        if (fileId && confirmTok) {
          const retryUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirmTok}${uuidTok ? `&uuid=${uuidTok}` : ""}`;
          console.log(`[drive-upload] retry with parsed confirm=${confirmTok}`);
          const r2 = await fetch(retryUrl, { redirect: "follow", headers: DOWNLOAD_HEADERS });
          const ct2 = r2.headers.get("content-type") || "";
          if (r2.ok && !ct2.includes("text/html")) {
            fileRes = r2; contentType = ct2; contentDisp = r2.headers.get("content-disposition") || ""; fileBlob = await r2.blob(); downloadUrl = retryUrl;
            break;
          }
        }
      } catch (e) { console.log(`[drive-upload] parse html failed: ${(e as Error).message}`); }
      continue;
    }
    fileRes = r; contentType = ct; contentDisp = cd; fileBlob = await r.blob();
    break;
  }

  // Sem fallback file_url: Meta downloada HTML interstitial achando ser vídeo,
  // cria creative WITH_ISSUES (#1487713/#2490446). Falha fast é melhor.
  if (!fileRes || !fileBlob) {
    return { error: `Arquivo do Drive não pôde ser baixado. Causa mais comum: não está público — no Drive, Compartilhar → Acesso geral → "Qualquer pessoa com o link" (Leitor). Se já estiver público: pode ser cota de download temporária do Drive (re-upload o arquivo), arquivo maior que 100MB (reduza o tamanho) ou use o link do Instagram.` };
  }

  // Detecção: content-type, content-disposition (filename) ou magic bytes.
  // Drive normalmente retorna application/octet-stream — precisa fallback.
  const headerSaysVideo = contentType.includes("video");
  const filenameSaysVideo = /\.(mp4|mov|m4v|avi|webm|mkv)(?:["';\s]|$)/i.test(contentDisp);
  let bytesSayVideo = false;
  try {
    const head = new Uint8Array(await fileBlob.slice(0, 16).arrayBuffer());
    // MP4/MOV: bytes 4..8 = "ftyp"
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) bytesSayVideo = true;
    // WebM: 1A 45 DF A3
    if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) bytesSayVideo = true;
  } catch {}
  const isVideo = headerSaysVideo || filenameSaysVideo || bytesSayVideo;
  console.log(`[drive-upload] ct=${contentType}, cd=${contentDisp.substring(0,100)}, magic_video=${bytesSayVideo} => isVideo=${isVideo}`);

  const formatMetaUploadError = (e: any) => {
    const parts = [e.message];
    if (e.code) parts.push(`code=${e.code}`);
    if (e.error_subcode) parts.push(`subcode=${e.error_subcode}`);
    if (e.error_user_msg) parts.push(`user_msg=${e.error_user_msg}`);
    if (e.error_user_title) parts.push(`user_title=${e.error_user_title}`);
    return parts.join(" | ");
  };

  if (isVideo) {
    // Upload bytes direto via multipart em vez de file_url:
    // se passássemos file_url, Meta faria 2º fetch do Drive e poderia hitar interstitial
    // (gerando creative WITH_ISSUES). Bytes locais elimina esse risco.
    const filenameMatch = contentDisp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
    const filename = filenameMatch?.[1] || "creative.mp4";
    const formData = new FormData();
    formData.append("access_token", accessToken);
    formData.append("source", fileBlob, filename);
    const uploadRes = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/advideos`, { method: "POST", body: formData });
    const uploadData = await uploadRes.json();
    if (uploadData.error) {
      console.log(`[drive-upload] /advideos error: ${JSON.stringify(uploadData.error)}`);
      return { error: formatMetaUploadError(uploadData.error) };
    }
    const videoId = uploadData.id;
    // Poll status pra evitar criar creative WITH_ISSUES (#1487713/#2490446).
    // Meta processa async; status="error" significa upload corrompido (ex: file_url HTML).
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const stRes = await fetch(`https://graph.facebook.com/v25.0/${videoId}?fields=status&access_token=${accessToken}`);
        const stData = await stRes.json();
        const vs = stData?.status?.video_status || stData?.status;
        console.log(`[drive-upload] video ${videoId} status poll ${i + 1}: ${JSON.stringify(stData?.status)}`);
        if (vs === "ready") return { video_id: videoId };
        if (vs === "error") {
          return { error: `Meta rejeitou vídeo após processamento (${stData?.status?.processing_progress || "n/a"}). Provável arquivo corrompido ou Drive devolveu HTML pra Meta. Re-upload o arquivo no Drive.` };
        }
      } catch (e) { console.log(`[drive-upload] status poll error: ${(e as Error).message}`); }
    }
    // Timeout polling: assume ok, ad creation vai retornar erro se ainda processando
    return { video_id: videoId };
  } else {
    const formData = new FormData();
    formData.append("access_token", accessToken);
    formData.append("filename", "creative.jpg");
    formData.append("bytes", await blobToBase64(fileBlob));
    const uploadRes = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/adimages`, { method: "POST", body: formData });
    const uploadData = await uploadRes.json();
    if (uploadData.error) {
      console.log(`[drive-upload] /adimages error: ${JSON.stringify(uploadData.error)}`);
      return { error: formatMetaUploadError(uploadData.error) };
    }
    const images = uploadData.images;
    if (images) {
      const firstKey = Object.keys(images)[0];
      return { image_hash: images[firstKey].hash };
    }
    return { error: "Falha ao obter hash da imagem." };
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => { resolve((reader.result as string).split(",")[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Vídeo recém-upado exige thumbnail (image_url/image_hash) no video_data, senão a Meta dá
// erro 100/1443226 "anúncio precisa de miniatura de vídeo". O campo `picture` demora a popular;
// a edge /thumbnails costuma vir antes. Espera processar e devolve image_hash (mais estável).
async function resolveVideoThumbnailField(
  videoId: string,
  accessToken: string,
  adAccountId: string,
): Promise<Record<string, string>> {
  let thumbUri = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const r = await fetch(`https://graph.facebook.com/v25.0/${videoId}?fields=status,picture,thumbnails{uri,is_preferred}&access_token=${accessToken}`);
      const d = await r.json();
      // rate limit / transitório → não adianta martelar (piora o limite e gasta tempo)
      if (d?.error && (d.error.is_transient || [4, 17, 32, 613].includes(Number(d.error.code)))) break;
      const thumbs = d?.thumbnails?.data;
      if (Array.isArray(thumbs) && thumbs.length) {
        const pref = thumbs.find((t: any) => t.is_preferred) || thumbs[0];
        if (pref?.uri) { thumbUri = pref.uri; break; }
      }
      if (d?.picture) { thumbUri = d.picture; break; }
    } catch { /* segue tentando */ }
  }
  if (!thumbUri) return {};
  // Sobe o thumbnail como adimage (image_hash é mais estável que image_url da CDN da Meta).
  try {
    const tr = await fetch(thumbUri);
    if (tr.ok) {
      const b64 = await blobToBase64(await tr.blob());
      const form = new FormData();
      form.append("access_token", accessToken);
      form.append("filename", "video_thumb.jpg");
      form.append("bytes", b64);
      const up = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/adimages`, { method: "POST", body: form });
      const upd = await up.json();
      if (upd?.images) { const k = Object.keys(upd.images)[0]; return { image_hash: upd.images[k].hash }; }
    }
  } catch { /* cai pro image_url */ }
  return { image_url: thumbUri };
}

async function resolvePageAndIg(accessToken: string, adAccountId?: string): Promise<{ pageId?: string; igActorId?: string; error?: string }> {
  async function getAllPages(): Promise<any[]> {
    const allPages: any[] = [];
    let url: string | null = `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,instagram_business_account{id}&limit=25&access_token=${accessToken}`;
    while (url) {
      const res = await fetch(url);
      const data = await res.json();
      if (data.data) allPages.push(...data.data);
      url = data.paging?.next || null;
      if (allPages.length >= 300) break;
    }
    return allPages;
  }

  if (adAccountId) {
    try {
      const igRes = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/instagram_accounts?fields=id,username&limit=25&access_token=${accessToken}`);
      const igData = await igRes.json();
      if (igData.data && igData.data.length > 0) {
        const igActorId = igData.data[0].id;
        const allPages = await getAllPages();
        let pageId: string | undefined;
        for (const page of allPages) {
          if (page.instagram_business_account?.id === igActorId) { pageId = page.id; break; }
        }
        if (!pageId && allPages.length > 0) pageId = allPages[0].id;
        return { pageId, igActorId };
      }
    } catch (e) {
      console.log(`[publish] resolvePageAndIg failed: ${e.message}`);
    }
  }

  const allPages = await getAllPages();
  if (allPages.length === 0) return { error: "Nenhuma página encontrada." };
  const pageId = allPages[0].id;
  let igActorId: string | undefined;
  for (const page of allPages) {
    if (page.instagram_business_account?.id) { igActorId = page.instagram_business_account.id; break; }
  }
  return { pageId, igActorId };
}

// =====================================================================
//  FASE 1 CREATIVE BUILDER — Instagram Profile Traffic
// =====================================================================

async function buildFase1Creative(
  accessToken: string,
  adAccountId: string,
  creativeLink: string,
  creativeType: string,
  creativeName: string,
  pageId: string,
  igActorId: string | undefined,
  igUsername: string | undefined,
  logs: StepLog[],
): Promise<{ spec?: Record<string, any>; error?: string }> {
  const igProfileLink = igUsername ? `https://www.instagram.com/${igUsername}/` : `https://www.instagram.com/`;
  const isIgLink = creativeType === "instagram" || (!creativeType && creativeLink?.includes("instagram.com"));
  const isDriveLink = creativeType === "drive" || (!creativeType && (creativeLink?.includes("drive.google.com") || creativeLink?.includes("docs.google.com")));

  console.log(`[FASE1-creative] type=${creativeType}, isIg=${isIgLink}, isDrive=${isDriveLink}`);

  if (isIgLink) {
    const result = await resolveInstagramMediaId(accessToken, adAccountId, creativeLink, pageId, igActorId, logs);
    if (result.error) return { error: result.error };
    if (!result.instagram_media_id) return { error: "instagram_media_id não resolvido." };

    const resolvedIgActor = result.ig_account_id || igActorId;
    if (!resolvedIgActor) return { error: "instagram_user_id não disponível." };

    // FASE 1 IG-link: spec mínima para boostar IG media existente.
    // page_id NÃO pode ir no top-level do creative — Meta retorna #3 "capability" error.
    // O binding com a Page é feito via promoted_object.page_id no ADSET.
    const spec: Record<string, any> = {
      source_instagram_media_id: result.instagram_media_id,
      instagram_user_id: resolvedIgActor,
      call_to_action: { type: "VIEW_INSTAGRAM_PROFILE", value: { link: igProfileLink } },
    };

    console.log(`[FASE1-creative] OK: media=${result.instagram_media_id}, ig=${resolvedIgActor}, CTA=VIEW_INSTAGRAM_PROFILE`);
    logs.push({ step: "fase1_creative", status: "success", ts: ts(), detail: `media=${result.instagram_media_id}, CTA=VIEW_INSTAGRAM_PROFILE` });
    return { spec };

  } else if (isDriveLink) {
    const result = await uploadDriveCreative(accessToken, adAccountId, creativeLink);
    if (result.error) return { error: result.error };

    if (result.image_hash) {
      const linkData: Record<string, any> = {
        image_hash: result.image_hash,
        link: igProfileLink,
        call_to_action: { type: "VIEW_INSTAGRAM_PROFILE", value: { link: igProfileLink } },
      };
      const storySpec: Record<string, any> = { page_id: pageId, link_data: linkData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE1-creative] OK: image_hash, CTA=VIEW_INSTAGRAM_PROFILE, link=${igProfileLink}`);
      logs.push({ step: "fase1_creative", status: "success", ts: ts(), detail: `image_hash=${result.image_hash}, CTA=VIEW_INSTAGRAM_PROFILE` });
      return { spec: { object_story_spec: storySpec } };

    } else if (result.video_id) {
      // Vídeo precisa de thumbnail no video_data (senão Meta erro 100/1443226).
      const thumbnailField = await resolveVideoThumbnailField(result.video_id, accessToken, adAccountId);

      const videoData: Record<string, any> = {
        video_id: result.video_id,
        ...thumbnailField,
        call_to_action: { type: "VIEW_INSTAGRAM_PROFILE", value: { link: igProfileLink } },
      };
      const storySpec: Record<string, any> = { page_id: pageId, video_data: videoData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE1-creative] OK: video_id=${result.video_id}, CTA=VIEW_INSTAGRAM_PROFILE`);
      logs.push({ step: "fase1_creative", status: "success", ts: ts(), detail: `video_id=${result.video_id}, CTA=VIEW_INSTAGRAM_PROFILE` });
      return { spec: { object_story_spec: storySpec } };
    }
  }

  return { error: "Link inválido para FASE 1." };
}

// =====================================================================
//  FASE 3 CREATIVE BUILDER — WhatsApp Leads / Conversations
//
//  Structural reference (Ads Manager behavior):
//  - CTA: WHATSAPP_MESSAGE (fixed, never user-editable)
//  - Link: https://api.whatsapp.com/send?phone=<number>&text=<encoded_message>
//  - Message text: greeting + ready_message (from internal template system, NOT WABA)
//  - Creative source (IG post or Drive) only affects the media, NOT the CTA/link
// =====================================================================

function buildWhatsAppLink(phoneNumber: string, greetingText?: string, readyMessage?: string): string {
  const cleanPhone = phoneNumber.replace(/\D/g, "");
  let link = `https://api.whatsapp.com/send?phone=${cleanPhone}`;
  // Build pre-filled message from greeting + ready_message
  const parts: string[] = [];
  if (greetingText?.trim()) parts.push(greetingText.trim());
  if (readyMessage?.trim()) parts.push(readyMessage.trim());
  if (parts.length > 0) {
    link += `&text=${encodeURIComponent(parts.join("\n\n"))}`;
  }
  return link;
}

// page_welcome_message renderiza a TELA DE BOAS-VINDAS antes de abrir o WhatsApp.
// É o mesmo formato que a UI da Meta gera quando o usuário cria/usa um "Modelo de mensagem".
// Estrutura derivada de creatives funcionais inspecionados via API.
function buildPageWelcomeMessageJson(greetingText: string | undefined, readyMessage: string | undefined): string {
  const welcomeText = (greetingText && greetingText.trim()) || "Oi! Como podemos ajudar?";
  const autofill = (readyMessage && readyMessage.trim()) || "Olá! Tenho interesse e queria mais informações.";
  return JSON.stringify({
    type: "VISUAL_EDITOR",
    version: 2,
    landing_screen_type: "welcome_message",
    media_type: "text",
    text_format: {
      customer_action_type: "autofill_message",
      message: {
        autofill_message: { content: autofill },
        text: welcomeText,
      },
    },
    image_format: {
      customer_action_type: "quick_replies",
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "generic", elements: [{ title: "", buttons: [], image_hash: "" }] },
        },
        quick_replies: [{ title: autofill, content_type: "text", response_type: null }],
        text: welcomeText,
      },
    },
    video_format: {
      customer_action_type: "quick_replies",
      message: {
        attachment: { type: "video", payload: { attachment_id: "" } },
        quick_replies: [{ title: autofill, content_type: "text", response_type: null }],
        text: welcomeText,
      },
    },
    ai_generated_icebreaker_toggle_enabled: null,
    user_edit: true,
    surface: "visual_editor_new",
    reengagement_disabled: false,
    reengagement: {
      text: "Olá, {{user_first_name}}! Gostaríamos de fazer um acompanhamento. Você tem alguma pergunta?",
      include_products: true,
    },
    autofill_message_edited: true,
    is_user_editing: false,
    template_version: 0,
  });
}

// =====================================================================
//  FASE 2 CREATIVE BUILDER — Engagement (vídeo Drive ou IG re-upload)
//  Sempre produz spec com object_story_spec.video_data.video_id (precisamos
//  do video_id pra criar a custom audience VV50% de exclusão).
// =====================================================================

async function buildFase2Creative(
  accessToken: string,
  adAccountId: string,
  creativeLink: string,
  creativeType: string,
  creativeName: string,
  pageId: string,
  igActorId: string | undefined,
  logs: StepLog[],
): Promise<{ spec?: Record<string, any>; error?: string; videoId?: string }> {
  const isIgLink = creativeType === "instagram" || (!creativeType && creativeLink?.includes("instagram.com"));
  const isDriveLink = creativeType === "drive" || (!creativeType && (creativeLink?.includes("drive.google.com") || creativeLink?.includes("docs.google.com")));

  // SIMPLIFICADO: pra IG, usa source_instagram_media_id direto (sem upload).
  // Pra Drive, faz upload via uploadDriveCreative (que já existe no projeto).
  // Audience exclusão é tentada DEPOIS — se falhar, segue sem ela.
  if (isIgLink) {
    const result = await resolveInstagramMediaId(accessToken, adAccountId, creativeLink, pageId, igActorId, logs);
    if (result.error) return { error: result.error };
    if (!result.instagram_media_id) return { error: "instagram_media_id não resolvido." };
    const resolvedIgActor = result.ig_account_id || igActorId;
    if (!resolvedIgActor) return { error: "instagram_user_id não disponível." };

    // Spec flat (igual FASE 1 que já funciona) — sem upload, sem video_id.
    const spec: Record<string, any> = {
      source_instagram_media_id: result.instagram_media_id,
      instagram_user_id: resolvedIgActor,
    };
    console.log(`[FASE2-creative] IG flat spec: media=${result.instagram_media_id}, ig=${resolvedIgActor}`);
    logs.push({ step: "fase2_creative", status: "success", ts: ts(), detail: `IG source_instagram_media_id=${result.instagram_media_id}` });
    // Sem videoId disponível (IG media_id != FB video_id), audience VV50% será SKIP.
    return { spec };
  }

  if (isDriveLink) {
    const result = await uploadDriveCreative(accessToken, adAccountId, creativeLink);
    if (result.error) return { error: result.error };
    if (!result.video_id) return { error: "FASE 2 Drive: arquivo precisa ser vídeo (não imagem)." };

    // Vídeo precisa de thumbnail no video_data (senão Meta erro 100/1443226).
    const thumbnailField = await resolveVideoThumbnailField(result.video_id, accessToken, adAccountId);

    const videoData: Record<string, any> = {
      video_id: result.video_id,
      ...thumbnailField,
    };
    const storySpec: Record<string, any> = { page_id: pageId, video_data: videoData };
    if (igActorId) storySpec.instagram_user_id = igActorId;
    console.log(`[FASE2-creative] Drive video: ${result.video_id}`);
    logs.push({ step: "fase2_creative", status: "success", ts: ts(), detail: `Drive video_id=${result.video_id}` });
    return { spec: { object_story_spec: storySpec }, videoId: result.video_id };
  }

  return { error: "Link inválido para FASE 2 (use IG post/reel ou Drive video)." };
}

// =====================================================================
//  FASE 3 LP CREATIVE BUILDER — Leads via Landing Page (URL externa + pixel)
//
//  Diferenças vs FASE 3 (WhatsApp):
//  - link aponta pra URL do site do gestor, não pra api.whatsapp.com
//  - CTA: LEARN_MORE (botão "Saiba mais")
//  - Sem page_welcome_message (não tem tela de boas-vindas Meta)
//  - Aceita IG link (boost de post existente) ou Drive (upload imagem/vídeo)
// =====================================================================

async function buildFase3LpCreative(
  accessToken: string,
  adAccountId: string,
  creativeLink: string,
  creativeType: string,
  creativeName: string,
  pageId: string,
  igActorId: string | undefined,
  lpUrl: string,
  logs: StepLog[],
): Promise<{ spec?: Record<string, any>; error?: string }> {
  if (!lpUrl) return { error: "URL de destino (lp_url) ausente." };
  const callToAction = { type: "LEARN_MORE", value: { link: lpUrl } };

  const isIgLink = creativeType === "instagram" || (!creativeType && creativeLink?.includes("instagram.com"));
  const isDriveLink = creativeType === "drive" || (!creativeType && (creativeLink?.includes("drive.google.com") || creativeLink?.includes("docs.google.com")));

  if (isIgLink) {
    const result = await resolveInstagramMediaId(accessToken, adAccountId, creativeLink, pageId, igActorId, logs);
    if (result.error) return { error: result.error };
    if (!result.instagram_media_id) return { error: "instagram_media_id não resolvido." };
    const resolvedIgActor = result.ig_account_id || igActorId;
    if (!resolvedIgActor) return { error: "instagram_user_id não disponível." };

    const spec: Record<string, any> = {
      source_instagram_media_id: result.instagram_media_id,
      instagram_user_id: resolvedIgActor,
      call_to_action: callToAction,
    };
    console.log(`[FASE3-LP-creative] OK (instagram): media=${result.instagram_media_id}, link=${lpUrl}`);
    logs.push({ step: "fase3lp_creative", status: "success", ts: ts(), detail: `source=instagram, link=${lpUrl}` });
    return { spec };
  }

  if (isDriveLink) {
    const result = await uploadDriveCreative(accessToken, adAccountId, creativeLink);
    if (result.error) return { error: result.error };

    if (result.image_hash) {
      const linkData: Record<string, any> = {
        image_hash: result.image_hash,
        link: lpUrl,
        call_to_action: callToAction,
      };
      const storySpec: Record<string, any> = { page_id: pageId, link_data: linkData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE3-LP-creative] OK (drive/image): hash=${result.image_hash}, link=${lpUrl}`);
      logs.push({ step: "fase3lp_creative", status: "success", ts: ts(), detail: `source=drive/image, hash=${result.image_hash}` });
      return { spec: { object_story_spec: storySpec } };
    }

    if (result.video_id) {
      // Vídeo precisa de thumbnail no video_data (senão Meta erro 100/1443226).
      const thumbnailField = await resolveVideoThumbnailField(result.video_id, accessToken, adAccountId);

      const videoData: Record<string, any> = {
        video_id: result.video_id,
        ...thumbnailField,
        call_to_action: callToAction,
      };
      const storySpec: Record<string, any> = { page_id: pageId, video_data: videoData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE3-LP-creative] OK (drive/video): video_id=${result.video_id}, link=${lpUrl}`);
      logs.push({ step: "fase3lp_creative", status: "success", ts: ts(), detail: `source=drive/video, video_id=${result.video_id}` });
      return { spec: { object_story_spec: storySpec } };
    }
  }

  return { error: "Link inválido para FASE 3 LP." };
}

async function buildFase3Creative(
  accessToken: string,
  adAccountId: string,
  creativeLink: string,
  creativeType: string,
  creativeName: string,
  pageId: string,
  igActorId: string | undefined,
  whatsappPhone: string,  // display phone number for the WA link
  greetingText: string | undefined,
  readyMessage: string | undefined,
  importedTemplateJson: string | undefined,
  logs: StepLog[],
): Promise<{ spec?: Record<string, any>; error?: string }> {
  // ── FIXED by preset ──
  const waLink = buildWhatsAppLink(whatsappPhone, greetingText, readyMessage);
  const callToAction = { type: "WHATSAPP_MESSAGE", value: { link: waLink } };
  // Se user selecionou um modelo importado da própria conta Meta UI, reutiliza o JSON como-está
  // (preserva template_id válido). Caso contrário, geramos um JSON novo a partir de greeting+autofill.
  const welcomeMessageJson = (importedTemplateJson && importedTemplateJson.trim())
    ? importedTemplateJson
    : buildPageWelcomeMessageJson(greetingText, readyMessage);

  console.log(`[FASE3-creative] ═══ FIXED fields ═══`);
  console.log(`[FASE3-creative] CTA: type=WHATSAPP_MESSAGE (fixed by preset)`);
  console.log(`[FASE3-creative] link: ${waLink}`);
  console.log(`[FASE3-creative] greeting: "${greetingText || ""}"`);
  console.log(`[FASE3-creative] ready_message: "${readyMessage || ""}"`);
  console.log(`[FASE3-creative] ═══ VARIABLE fields ═══`);
  console.log(`[FASE3-creative] source: ${creativeType}, name: ${creativeName}`);

  const isIgLink = creativeType === "instagram" || (!creativeType && creativeLink?.includes("instagram.com"));
  const isDriveLink = creativeType === "drive" || (!creativeType && (creativeLink?.includes("drive.google.com") || creativeLink?.includes("docs.google.com")));

  if (isIgLink) {
    // IG source: use source_instagram_media_id + call_to_action
    const result = await resolveInstagramMediaId(accessToken, adAccountId, creativeLink, pageId, igActorId, logs);
    if (result.error) return { error: result.error };
    if (!result.instagram_media_id) return { error: "instagram_media_id não resolvido." };

    const resolvedIgActor = result.ig_account_id || igActorId;
    if (!resolvedIgActor) return { error: "instagram_user_id não disponível para creative FASE 3." };

    const spec: Record<string, any> = {
      source_instagram_media_id: result.instagram_media_id,
      instagram_user_id: resolvedIgActor,
      call_to_action: callToAction,
      page_welcome_message: welcomeMessageJson,
    };

    console.log(`[FASE3-creative] OK (instagram): media=${result.instagram_media_id}, ig=${resolvedIgActor}`);
    logs.push({ step: "fase3_creative", status: "success", ts: ts(), detail: `source=instagram, media=${result.instagram_media_id}, CTA=WHATSAPP_MESSAGE` });
    return { spec };

  } else if (isDriveLink) {
    const result = await uploadDriveCreative(accessToken, adAccountId, creativeLink);
    if (result.error) return { error: result.error };

    if (result.image_hash) {
      const linkData: Record<string, any> = {
        image_hash: result.image_hash,
        link: waLink,
        call_to_action: callToAction,
        page_welcome_message: welcomeMessageJson,
      };
      if (readyMessage) linkData.message = readyMessage;
      const storySpec: Record<string, any> = { page_id: pageId, link_data: linkData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE3-creative] OK (drive/image): hash=${result.image_hash}`);
      logs.push({ step: "fase3_creative", status: "success", ts: ts(), detail: `source=drive/image, hash=${result.image_hash}, CTA=WHATSAPP_MESSAGE` });
      return { spec: { object_story_spec: storySpec } };

    } else if (result.video_id) {
      // Vídeo precisa de thumbnail no video_data (senão Meta erro 100/1443226).
      const thumbnailField = await resolveVideoThumbnailField(result.video_id, accessToken, adAccountId);

      const videoData: Record<string, any> = {
        video_id: result.video_id,
        ...thumbnailField,
        call_to_action: callToAction,
        page_welcome_message: welcomeMessageJson,
      };
      if (readyMessage) videoData.message = readyMessage;
      const storySpec: Record<string, any> = { page_id: pageId, video_data: videoData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE3-creative] OK (drive/video): video_id=${result.video_id}`);
      logs.push({ step: "fase3_creative", status: "success", ts: ts(), detail: `source=drive/video, video_id=${result.video_id}, CTA=WHATSAPP_MESSAGE` });
      return { spec: { object_story_spec: storySpec } };
    }
  }

  return { error: "Link inválido para FASE 3." };
}

// (diagnostic logic is now inline in tryCreateAdsetFase3)

// =====================================================================
//  MAIN HANDLER
// =====================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const logs: StepLog[] = [];
  // Cleanup: se a publicação falhar DEPOIS de criar a campanha, deletamos a campanha
  // pra não acumular órfãs. Só deleta a que NÓS criamos (createdCampaignId), nunca
  // campanha existente selecionada pelo gestor.
  let createdCampaignId: string | null = null;
  let publishToken: string | null = null;
  const respond = async (body: Record<string, any>, status = 200) => {
    if (body && body.ok === false && !body.warning && createdCampaignId && publishToken) {
      try {
        await fetch(`https://graph.facebook.com/v25.0/${createdCampaignId}?access_token=${publishToken}`, { method: "DELETE" });
        body.campaign_deleted = createdCampaignId;
        logs.push({ step: "cleanup", status: "success", ts: ts(), detail: `campanha ${createdCampaignId} deletada após falha` });
        createdCampaignId = null;
      } catch (e) {
        logs.push({ step: "cleanup", status: "error", ts: ts(), detail: `falha ao deletar campanha ${createdCampaignId}: ${(e as Error).message}` });
      }
    }
    return new Response(JSON.stringify({ ...body, logs }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return respond({ ok: false, step: "auth", error_message: "Sessão inválida. Faça login novamente antes de publicar." });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return respond({ ok: false, step: "config", error_message: "Configuração de backend incompleta para idempotência de publish." });
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      return respond({ ok: false, step: "auth", error_message: "Não foi possível validar o usuário autenticado para publicar." });
    }

    const publishUserId = user.id;

    const body = await req.json();
    const {
      access_token, ad_account_id, audience_id, audience_type,
      targeting_spec, budget,
      campaign_name, adset_name, ad_name,
      existing_campaign_id,
      existing_adset_id,
      generated_name,
      preset,
      distribution_structure,
      creatives,
      identity,
      creative_link, creative_type, creative_name,
      whatsapp_number, whatsapp_number_id, location_targeting, cta_text, greeting_text, ready_message,
      imported_template_json,
      lp_url, pixel_id, custom_event_type,
      schedule, utm_template,
    } = body;
    publishToken = typeof access_token === "string" ? access_token : null;

    // Validação de access_token (cobre todos os usos subsequentes)
    if (!access_token || typeof access_token !== "string" || access_token.trim().length === 0) {
      return respond({
        ok: false,
        step: "auth",
        error_message: "access_token inválido ou ausente. Faça login novamente.",
      });
    }

    let structure = distribution_structure || "ABO";
    const isWhatsAppPreset = preset?.destination_type === "WHATSAPP";
    const isIgProfilePreset = preset?.destination_type === "INSTAGRAM_PROFILE";
    const isWebsitePreset = preset?.destination_type === "WEBSITE";
    const isVideoEngagementPreset = preset?.destination_type === "ON_VIDEO" || preset?.optimization_goal === "THRUPLAY";
    // VENDAS via WhatsApp = WhatsApp destination + objective OUTCOME_SALES + pixel/PURCHASE no promoted_object
    const isFase3VendasZap = isWhatsAppPreset && preset?.objective === "OUTCOME_SALES";
    const fase3CampaignObjective = isFase3VendasZap ? "OUTCOME_SALES" : (preset?.objective || "OUTCOME_LEADS");

    // FASE 2 — multiple audience IDs (one adset per audience)
    const fase2AudienceIds: string[] = body.fase2_audiences || [];
    const fase2AudienceNames: string[] = body.fase2_audience_names || [];

    // ══════════════════════════════════════════════════════════════════
    //  PIPELINE LOG: Identify which preset we're running
    // ══════════════════════════════════════════════════════════════════
    const presetLabel = isWhatsAppPreset ? "FASE 3" : isIgProfilePreset ? "FASE 1" : isWebsitePreset ? "FASE 3 LP" : "GENERIC";
    console.log(`[publish] ═══════════════════════════════════════════`);
    console.log(`[publish] PRESET: ${presetLabel}`);
    console.log(`[publish] STRUCTURE: ${structure}`);
    console.log(`[publish] BUDGET: ${budget} (placement: ${structure === "CBO" ? "CAMPAIGN" : "ADSET"})`);
    console.log(`[publish] STATUS POLICY: campaign=PAUSED, adsets=ACTIVE, ads=ACTIVE`);

    if (isWhatsAppPreset) {
      console.log(`[publish] ── FASE 3 FIXED CONFIG ──`);
      console.log(`[publish]   objective: OUTCOME_LEADS (FIXED)`);
      console.log(`[publish]   optimization_goal: CONVERSATIONS (FIXED)`);
      console.log(`[publish]   destination_type: WHATSAPP (FIXED)`);
      console.log(`[publish]   billing_event: IMPRESSIONS (FIXED)`);
      console.log(`[publish]   bid_strategy: LOWEST_COST_WITHOUT_CAP (FIXED)`);
      console.log(`[publish]   CTA: WHATSAPP_MESSAGE (FIXED, not editable)`);
      console.log(`[publish] ── FASE 3 VARIABLE DATA ──`);
      console.log(`[publish]   whatsapp_number (display): ${whatsapp_number}`);
      console.log(`[publish]   whatsapp_number_id (internal): ${whatsapp_number_id} (type=${typeof whatsapp_number_id}, len=${String(whatsapp_number_id || "").length})`);
      console.log(`[publish]   page_id: ${identity?.page_id || "auto-resolve"}`);
      console.log(`[publish]   greeting: "${greeting_text || ""}"`);
      console.log(`[publish]   ready_message: "${ready_message || ""}"`);
      console.log(`[publish]   promoted_object: { page_id, whats_app_business_phone_number_id, whatsapp_phone_number } (EXACTLY 3 fields)`);
    } else if (isIgProfilePreset) {
      console.log(`[publish] ── FASE 1 FIXED CONFIG ──`);
      console.log(`[publish]   objective: OUTCOME_TRAFFIC`);
      console.log(`[publish]   optimization_goal: PROFILE_VISIT`);
      console.log(`[publish]   destination_type: INSTAGRAM_PROFILE`);
      console.log(`[publish]   CTA: VIEW_INSTAGRAM_PROFILE (automatic)`);
      console.log(`[publish]   advantage_audience: DISABLED (enforced)`);
    }
    console.log(`[publish] ═══════════════════════════════════════════`);

    // Build creatives list
    const creativesList: { type: string; link: string; name: string }[] =
      creatives && creatives.length > 0
        ? creatives
        : [{ type: creative_type, link: creative_link, name: creative_name || ad_name || "Ad" }];

    // --- Resolve Page & IG ---
    let pageId: string;
    let igActorId: string | undefined;

    if (identity?.page_id) {
      pageId = identity.page_id;
      igActorId = identity.instagram_actor_id || undefined;
      logs.push({ step: "resolve_page", status: "success", ts: ts(), detail: `identity from frontend: page=${pageId}, ig=${igActorId || "none"}` });

      if (isIgProfilePreset && (!igActorId || isNaN(Number(igActorId)))) {
        const errMsg = `Instagram_actor_id inválido: '${igActorId}'.`;
        logs.push({ step: "validate_identity", status: "error", ts: ts(), detail: errMsg });
        return respond({ ok: false, step: "validate_identity", error_message: errMsg });
      }
    } else {
      logs.push({ step: "resolve_page", status: "start", ts: ts() });
      const pageInfo = await resolvePageAndIg(access_token, ad_account_id);
      if (pageInfo.error) {
        logs.push({ step: "resolve_page", status: "error", ts: ts(), detail: pageInfo.error });
        return respond({ ok: false, step: "resolve_page", error_message: pageInfo.error });
      }
      pageId = pageInfo.pageId!;
      igActorId = pageInfo.igActorId;
      logs.push({ step: "resolve_page", status: "success", ts: ts(), detail: `page=${pageId}, ig=${igActorId || "none"}` });

      if (isIgProfilePreset && (!igActorId || isNaN(Number(igActorId)))) {
        return respond({ ok: false, step: "validate_identity", error_message: `Nenhum Instagram Business válido.` });
      }
    }

    // Anunciante/Pagador verificado (compliance). O erro 100/3858634 ("anunciante ausente")
    // NÃO é resolvido por dsa_beneficiary/dsa_payor em TEXTO LIVRE — em mercados que exigem
    // verificação (BR) a Meta rejeita até o valor recomendado. As campanhas que RODAM nesta
    // conta usam regional_regulation_identities { universal_beneficiary, universal_payer } =
    // ID da entidade VERIFICADA. Puxamos esses ids de um adset existente da conta e replicamos.
    let universalBeneficiary: string | null = null;
    let universalPayer: string | null = null;
    try {
      const aRes = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/adsets?fields=regional_regulation_identities&limit=50&access_token=${access_token}`);
      const aData = await aRes.json();
      for (const it of (aData?.data || [])) {
        const rri = it?.regional_regulation_identities;
        if (rri?.universal_beneficiary) {
          universalBeneficiary = String(rri.universal_beneficiary);
          universalPayer = String(rri.universal_payer || rri.universal_beneficiary);
          break;
        }
      }
    } catch (e) {
      console.log(`[publish] regional_regulation_identities lookup failed: ${(e as Error).message}`);
    }
    // Fallback (contas sem entidade verificada herdável): string DSA (gestor → dsa_recommendations).
    let accountDsaRec: string | null = null;
    try {
      const rRes = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/dsa_recommendations?access_token=${access_token}`);
      const rData = await rRes.json();
      const d = rData?.data?.[0];
      // a API retorna {data:[{beneficiary, payor}]}; versões antigas usam {recommendations:[...]}
      const benef = d?.beneficiary ?? (Array.isArray(d?.recommendations) ? d.recommendations[0] : null);
      if (benef && String(benef).trim()) accountDsaRec = String(benef).trim();
    } catch (e) {
      console.log(`[publish] dsa_recommendations failed: ${(e as Error).message}`);
    }
    const userBenef = (typeof body.dsa_beneficiary === "string" && body.dsa_beneficiary.trim()) ? body.dsa_beneficiary.trim() : "";
    const dsaBeneficiary = userBenef || accountDsaRec || "";
    console.log(`[publish] DSA resolvido: universal_beneficiary="${universalBeneficiary}" universal_payer="${universalPayer}" | fallback_string="${dsaBeneficiary}"`);
    const applyDsa = (p: Record<string, any>) => {
      if (universalBeneficiary) {
        // anunciante verificado por ID — exatamente o que as campanhas que rodam nesta conta usam
        p.regional_regulation_identities = {
          universal_beneficiary: universalBeneficiary,
          universal_payer: universalPayer || universalBeneficiary,
        };
      } else if (dsaBeneficiary) {
        // fallback texto livre (transparência DSA UE / contas sem entidade verificada herdável)
        p.dsa_beneficiary = dsaBeneficiary;
        p.dsa_payor = dsaBeneficiary;
      }
    };

    // --- Resolve ALL creatives using preset-specific builder ---
    logs.push({ step: "resolve_creatives", status: "start", ts: ts(), detail: `${creativesList.length} creative(s), builder=${presetLabel} (parallel)` });

    // Paraleliza resolve dos criativos (cada um pode incluir upload Drive de até 30s).
    // Sequencial fura timeout 150s da edge function com 5+ Drive uploads.
    const buildOne = async (cr: typeof creativesList[number], ci: number): Promise<{ spec?: Record<string, any>; error?: string }> => {
      console.log(`[publish] creative ${ci + 1}/${creativesList.length}: type=${cr.type}, name=${cr.name}, builder=${presetLabel}`);
      if (isVideoEngagementPreset) {
        return buildFase2Creative(access_token, ad_account_id, cr.link, cr.type, cr.name, pageId, igActorId, logs);
      } else if (isWebsitePreset) {
        return buildFase3LpCreative(access_token, ad_account_id, cr.link, cr.type, cr.name, pageId, igActorId, lp_url || "", logs);
      } else if (isWhatsAppPreset) {
        return buildFase3Creative(access_token, ad_account_id, cr.link, cr.type, cr.name, pageId, igActorId, whatsapp_number || "", greeting_text, ready_message, imported_template_json, logs);
      } else {
        // FASE 1 OR generic fallback (mesmo builder)
        return buildFase1Creative(access_token, ad_account_id, cr.link, cr.type, cr.name, pageId, igActorId, identity?.instagram_username || undefined, logs);
      }
    };

    const settled = await Promise.all(creativesList.map((cr, ci) => buildOne(cr, ci)));
    const firstError = settled.findIndex((r) => r.error);
    if (firstError !== -1) {
      const cr = creativesList[firstError];
      const err = settled[firstError].error!;
      logs.push({ step: "resolve_creatives", status: "error", ts: ts(), detail: `creative ${firstError + 1} "${cr.name}": ${err}` });
      return respond({ ok: false, step: "resolve_creative", error_message: err });
    }
    const resolvedCreatives: { spec: Record<string, any>; name: string }[] = settled.map((r, ci) => ({
      spec: r.spec!,
      name: creativesList[ci].name,
    }));
    logs.push({ step: "resolve_creatives", status: "success", ts: ts(), detail: `${resolvedCreatives.length} resolved` });

    const targeting = buildTargeting(audience_type || "custom", audience_id, targeting_spec, location_targeting);
    const finalCampaignName = campaign_name || generated_name || "Campaign";

    // ══════════════════════════════════════════════════════════════════
    //  CAMPAIGN BUILDER
    // ══════════════════════════════════════════════════════════════════
    let campaignId: string;
    // Quando reutilizamos campanha existente, herdamos bid_strategy + bid_amount dela
    // pra evitar Invalid parameter (Meta rejeita adset com strategy diferente da campanha).
    let inheritedBidStrategy: string | null = null;
    let inheritedBidAmount: number | null = null;
    if (existing_campaign_id) {
      logs.push({ step: "campaign", status: "success", ts: ts(), detail: `existing: ${existing_campaign_id}` });
      campaignId = existing_campaign_id;
      try {
        const existRes = await fetch(`https://graph.facebook.com/v25.0/${existing_campaign_id}?fields=bid_strategy,bid_amount,daily_budget,lifetime_budget&access_token=${access_token}`);
        const existData = await existRes.json();
        if (!existData.error) {
          inheritedBidStrategy = existData.bid_strategy || null;
          inheritedBidAmount = typeof existData.bid_amount === "number" ? existData.bid_amount : (existData.bid_amount ? Number(existData.bid_amount) : null);
          // Estrutura é DITADA pela campanha existente, não pela escolha do frontend:
          // se a campanha tem orçamento próprio → CBO (adset NÃO leva budget/bid).
          // Senão → ABO (adset leva budget+bid). Evita erro "Must Use Campaign Bid
          // Strategy" / orçamento conflitante.
          const campHasBudget = !!(existData.daily_budget || existData.lifetime_budget);
          const detectedStructure = campHasBudget ? "CBO" : "ABO";
          if (detectedStructure !== structure) {
            logs.push({ step: "campaign", status: "warning", ts: ts(), detail: `estrutura ajustada p/ ${detectedStructure} (campanha existente é ${detectedStructure}; frontend pediu ${structure})` });
          }
          structure = detectedStructure;
          logs.push({ step: "campaign", status: "success", ts: ts(), detail: `inherited bid_strategy=${inheritedBidStrategy}, bid_amount=${inheritedBidAmount}, structure=${structure}` });
        }
      } catch (e) {
        logs.push({ step: "campaign", status: "error", ts: ts(), detail: `falha ao inferir bid_strategy: ${(e as Error).message}` });
      }
    } else {
      logs.push({ step: "campaign", status: "start", ts: ts() });
      const resolvedCampaignObjective = isWhatsAppPreset ? fase3CampaignObjective : (preset?.objective || "OUTCOME_TRAFFIC");
      // FASE 3: campaign MÍNIMA — WhatsApp pertence EXCLUSIVAMENTE ao adset
      const campaignPayload: Record<string, any> = {
        name: finalCampaignName,
        objective: resolvedCampaignObjective,
        // PAUSED: rollout pra outros gestores exige checkpoint manual antes do
        // gasto começar. Adsets+ads seguem ACTIVE — assim que o gestor conferir
        // e ativar a campanha na Meta, tudo abaixo já está pronto pra rodar.
        status: "PAUSED",
        special_ad_categories: [],
        buying_type: "AUCTION",
        smart_promotion_type: "GUIDED_CREATION",
        access_token,
      };

      if (structure === "CBO") {
        campaignPayload.daily_budget = Math.round(Number(budget) * 100);
        // CBO: bid_strategy vai no nível da CAMPANHA. Sem isso Meta default vira
        // LOWEST_COST_WITH_BID_CAP/TARGET_COST e exige bid_amount no adset.
        campaignPayload.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
        console.log(`[publish] CAMPAIGN BUDGET (CBO): ${campaignPayload.daily_budget} cents, bid_strategy=LOWEST_COST_WITHOUT_CAP`);
      } else {
        // ABO: Meta exige is_adset_budget_sharing_enabled explícito em certas contas
        // (erro 4834011 "É necessário especificar True ou False"). Confirmado via teste
        // direto na conta Mari Eiras (1195005257969003). false = orçamento por adset.
        campaignPayload.is_adset_budget_sharing_enabled = false;
        console.log(`[publish] CAMPAIGN (ABO): is_adset_budget_sharing_enabled=false`);
      }

      if (schedule?.start_time) campaignPayload.start_time = schedule.start_time;

      // Validação: bloquear se qualquer campo proibido existir na campaign
      // (is_adset_budget_sharing_enabled NÃO é proibido — Meta exige no ABO)
      const forbiddenCampaignKeys = ["promoted_object", "page_id", "whatsapp_phone_number", "whats_app_business_phone_number_id", "destination_type", "optimization_goal", "billing_event", "targeting", "attribution_spec"];
      const foundForbidden = forbiddenCampaignKeys.filter(k => k in campaignPayload);
      if (foundForbidden.length > 0) {
        console.log(`[publish] ❌ CAMPAIGN BLOQUEADA: campos proibidos detectados: ${foundForbidden.join(", ")}`);
        return respond({ ok: false, step: "campaign", error_message: `Campos proibidos na campaign: ${foundForbidden.join(", ")}` });
      }

      const campaignKeys = Object.keys(campaignPayload).filter(k => k !== "access_token");
      console.log(`[publish] campaign objective (${presetLabel}): ${resolvedCampaignObjective}`);
      console.log(`[publish] campaign keys: [${campaignKeys.join(", ")}]`);
      console.log(`[publish] ✅ campaign LIMPA — sem campos de WhatsApp/adset/creative`);
      console.log(`[publish] campaign payload final: ${JSON.stringify(sanitizePayload(campaignPayload))}`);

      const campaignRes = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/campaigns`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(campaignPayload),
      });
      const campaignData = await campaignRes.json();
      console.log(`[publish] campaign response: ${JSON.stringify(campaignData)}`);
      if (campaignData.error) {
        const cErr = campaignData.error;
        console.log(`[publish] campaign error details: code=${cErr.code}, subcode=${cErr.error_subcode}, user_title=${cErr.error_user_title || "N/A"}, user_msg=${cErr.error_user_msg || "N/A"}`);
        logs.push({
          step: "campaign",
          status: "error",
          ts: ts(),
          detail: `code=${cErr.code} | subcode=${cErr.error_subcode} | user_title=${cErr.error_user_title || ""} | user_msg=${cErr.error_user_msg || ""} | response=${JSON.stringify(campaignData)}`,
        });
        return respond({ ok: false, step: "campaign", ...formatMetaError(campaignData.error) });
      }
      campaignId = campaignData.id;
      createdCampaignId = campaignId; // só a campanha que NÓS criamos é elegível pra cleanup em falha
      logs.push({ step: "campaign", status: "success", ts: ts(), detail: `id=${campaignId} | response=${JSON.stringify(campaignData)}` });
    }

    // ══════════════════════════════════════════════════════════════════
    //  ADSET BUILDERS — completely isolated per preset
    // ══════════════════════════════════════════════════════════════════

    // === FASE 1 AdSet builder ===
    const buildFase1Adset = (name: string): Record<string, any> => {
      // FASE 1 adset:
      // - advantage_audience FORÇADO = 0 (override user input)
      // - promoted_object SÓ com page_id (formato historicamente funcional, conforme
      //   commit e2da2d5). Adicionar instagram_profile_id causa #1346001 ao linkar o ad
      //   quando user conectado não é admin direto da Page (cenário típico de agência via BM).
      // - sem attribution_spec
      const promotedObject: Record<string, any> = { page_id: pageId };
      const p: Record<string, any> = {
        name,
        campaign_id: campaignId,
        billing_event: "IMPRESSIONS",
        // VISIT_INSTAGRAM_PROFILE (não PROFILE_VISIT): combo coerente com destino
        // INSTAGRAM_PROFILE + CTA VIEW_INSTAGRAM_PROFILE. Confirmado como goal canônico
        // do MCP pra visita de perfil IG. PROFILE_VISIT é genérico (FB ou IG) e a
        // incoerência com destino/CTA IG dispara #1346001 em certas mídias.
        optimization_goal: "VISIT_INSTAGRAM_PROFILE",
        targeting: { ...targeting, targeting_automation: { advantage_audience: 0 } },
        status: "ACTIVE",
        destination_type: "INSTAGRAM_PROFILE",
        promoted_object: promotedObject,
        access_token,
      };
      applyDsa(p);
      // CBO: bid_strategy vive na campanha; adset NÃO declara nem budget nem bid_strategy.
      // ABO: adset tem daily_budget + bid_strategy próprio.
      if (structure === "ABO") {
        p.daily_budget = Math.round(Number(budget) * 100);
        p.bid_strategy = inheritedBidStrategy || preset?.bid_strategy || "LOWEST_COST_WITHOUT_CAP";
        if (inheritedBidStrategy && inheritedBidStrategy !== "LOWEST_COST_WITHOUT_CAP" && inheritedBidAmount) {
          p.bid_amount = inheritedBidAmount;
        }
      }
      if (schedule?.start_time) p.start_time = schedule.start_time;
      else p.start_time = new Date().toISOString();
      if (schedule?.end_time) p.end_time = schedule.end_time;

      console.log(`[FASE1-adset] ── FIXED: destination=INSTAGRAM_PROFILE, optimization=VISIT_INSTAGRAM_PROFILE, advantage_audience=0`);
      console.log(`[FASE1-adset] ── VARIABLE: name="${name}", page=${pageId}, budget=${p.daily_budget || "CBO"}`);
      return p;
    };

    // === FASE 3 AdSet builder ===
    //
    // Meta v25 promoted_object para Click-to-WhatsApp:
    // { page_id, smart_pse_enabled: false, whatsapp_phone_number }.
    // NÃO incluir whats_app_business_phone_number_id (Meta rejeita com 2446886
    // "Página com conta do WhatsApp Business necessária"). Confirmado em adsets
    // funcionais existentes na conta act_344720138940133.
    //
    const buildFase3Adset = (name: string, audienceName?: string): { payload?: Record<string, any>; error?: string } => {
      // ══════════════════════════════════════════════════════════════
      //  PROMOTED_OBJECT
      // ══════════════════════════════════════════════════════════════
      const cleanPhone = String(whatsapp_number || "").replace(/\D/g, "");
      if (!cleanPhone) {
        console.log(`[FASE3-adset] ❌ BLOQUEADO: whatsapp_number vazio`);
        return { error: "whatsapp_phone_number não disponível. Selecione um número de WhatsApp." };
      }
      const promotedObject: Record<string, any> = {
        page_id: pageId,
        smart_pse_enabled: false,
        whatsapp_phone_number: cleanPhone,
      };
      // FASE 3 VENDAS ZAP: adicionar pixel + custom_event_type pra otimizar pra Compras
      if (isFase3VendasZap && pixel_id) {
        promotedObject.pixel_id = String(pixel_id);
        promotedObject.custom_event_type = String(custom_event_type || "PURCHASE");
      }

      const promotedObjectValidation = validateFase3PromotedObject(promotedObject);
      if (!promotedObjectValidation.ok) {
        console.log(`[FASE3-adset] ❌ BLOQUEADO: promoted_object inválido`);
        console.log(`[FASE3-adset] keys: ${JSON.stringify(promotedObjectValidation.keys)}`);
        console.log(`[FASE3-adset] unexpected: ${JSON.stringify(promotedObjectValidation.unexpectedKeys)}`);
        console.log(`[FASE3-adset] missing: ${JSON.stringify(promotedObjectValidation.missingRequired)}`);
        return { error: `promoted_object inválido: ${promotedObjectValidation.message}` };
      }

      // ══════════════════════════════════════════════════════════════
      //  ATTRIBUTION (CLICK_THROUGH / 1 dia)
      // ══════════════════════════════════════════════════════════════
      const attributionSpec = [
        { event_type: "CLICK_THROUGH", window_days: 1 },
      ];

      const attrValidation = validateFase3Attribution(attributionSpec);
      if (!attrValidation.ok) {
        console.log(`[FASE3-adset] ❌ BLOQUEADO: ${attrValidation.error}`);
        return { error: attrValidation.error! };
      }

      // ══════════════════════════════════════════════════════════════
      //  TARGETING (estrutura fixa + conteúdo dinâmico)
      // ══════════════════════════════════════════════════════════════
      const fase3Targeting: Record<string, any> = {};

      // age — default 18-65, mas RESPEITA a idade segmentada no público (saved audience) capturada abaixo
      let fase3AgeMin = 18;
      let fase3AgeMax = 65;

      // custom_audiences vs saved_audiences — tratar tipo corretamente
      const audienceType = body.audience_type || "custom";
      if (audience_id) {
        if (audienceType === "saved" && targeting_spec) {
          // Saved audience: mesclar targeting_spec (interests, behaviors, etc.)
          const savedTargeting = { ...targeting_spec };
          // RESPEITA a idade segmentada no público: age_range (Advantage+) tem prioridade; senão age_min/age_max.
          if (Array.isArray(savedTargeting.age_range) && savedTargeting.age_range.length === 2) {
            fase3AgeMin = Number(savedTargeting.age_range[0]) || fase3AgeMin;
            fase3AgeMax = Number(savedTargeting.age_range[1]) || fase3AgeMax;
          } else {
            if (typeof savedTargeting.age_min === "number") fase3AgeMin = savedTargeting.age_min;
            if (typeof savedTargeting.age_max === "number") fase3AgeMax = savedTargeting.age_max;
          }
          delete savedTargeting.age_min;
          delete savedTargeting.age_max;
          // age_range só vale com Advantage+ ligado; FASE 3 força advantage_audience:0 → remover (senão Meta erro 100/1487079). Idade já capturada acima.
          delete savedTargeting.age_range;
          delete savedTargeting.geo_locations;
          delete savedTargeting.targeting_automation;
          delete savedTargeting.targeting_optimization;
          delete savedTargeting.brand_safety_content_filter_levels;
          Object.assign(fase3Targeting, savedTargeting);
          console.log(`[FASE3-adset] audience type=saved, age=${fase3AgeMin}-${fase3AgeMax}, merged targeting_spec fields`);
        } else {
          // Custom audience: enviar como custom_audiences
          fase3Targeting.custom_audiences = [{ id: audience_id, name: audienceName || "" }];
          console.log(`[FASE3-adset] audience type=custom, id=${audience_id}`);
        }
      } else if (targeting?.custom_audiences) {
        fase3Targeting.custom_audiences = targeting.custom_audiences;
      }

      // aplica idade — default 18-65 ou a segmentação do público
      fase3Targeting.age_min = fase3AgeMin;
      fase3Targeting.age_max = fase3AgeMax;

      // geo_locations
      if (targeting?.geo_locations) {
        fase3Targeting.geo_locations = { ...targeting.geo_locations };
      } else {
        fase3Targeting.geo_locations = { countries: ["BR"] };
      }
      fase3Targeting.geo_locations.location_types = ["home", "recent"];

      // excluded_geo_locations (if present from location selector)
      if (targeting?.excluded_geo_locations) {
        fase3Targeting.excluded_geo_locations = targeting.excluded_geo_locations;
      }

      // targeting_automation — alinha com adset funcional (advantage_audience: 0)
      fase3Targeting.targeting_automation = {
        advantage_audience: 0,
        individual_setting: { age: 0, gender: 0 },
      };

      const targetingValidation = validateFase3Targeting(fase3Targeting);
      if (!targetingValidation.ok) {
        console.log(`[FASE3-adset] ❌ BLOQUEADO: targeting inválido`);
        for (const e of targetingValidation.errors) console.log(`[FASE3-adset]   → ${e}`);
        return { error: `Targeting inválido: ${targetingValidation.errors.join("; ")}` };
      }

      // ══════════════════════════════════════════════════════════════
      //  ADSET PAYLOAD
      // ══════════════════════════════════════════════════════════════
      const p: Record<string, any> = {
        campaign_id: campaignId,
        name,
        status: "ACTIVE",
        billing_event: "IMPRESSIONS",
        optimization_goal: "CONVERSATIONS",
        destination_type: "WHATSAPP",
        promoted_object: promotedObject,
        targeting: fase3Targeting,
        attribution_spec: attributionSpec,
        access_token,
      };
      applyDsa(p);
      if (structure === "ABO") {
        p.daily_budget = String(Math.round(Number(budget) * 100));
        p.bid_strategy = inheritedBidStrategy || "LOWEST_COST_WITHOUT_CAP";
        if (inheritedBidStrategy && inheritedBidStrategy !== "LOWEST_COST_WITHOUT_CAP" && inheritedBidAmount) {
          p.bid_amount = inheritedBidAmount;
        }
      }
      if (schedule?.start_time) p.start_time = schedule.start_time;
      if (schedule?.end_time) p.end_time = schedule.end_time;

      // ══════════════════════════════════════════════════════════════
      //  LOGS OBRIGATÓRIOS
      // ══════════════════════════════════════════════════════════════
      console.log(`[FASE3-adset] ═══ ADSET BUILD ═══`);
      console.log(`[FASE3-adset] billing_event: IMPRESSIONS (FIXED)`);
      console.log(`[FASE3-adset] optimization_goal: CONVERSATIONS (FIXED)`);
      console.log(`[FASE3-adset] destination_type: WHATSAPP (FIXED)`);
      console.log(`[FASE3-adset] bid_strategy: LOWEST_COST_WITHOUT_CAP (FIXED)`);
      console.log(`[FASE3-adset] promoted_object FINAL: ${JSON.stringify(promotedObject)}`);
      console.log(`[FASE3-adset] ${promotedObjectValidation.message}`);
      console.log(`[FASE3-adset] attribution_spec: ${JSON.stringify(attributionSpec)}`);
      console.log(`[FASE3-adset] targeting: ${JSON.stringify(fase3Targeting)}`);
      console.log(`[FASE3-adset] daily_budget: ${p.daily_budget}`);
      console.log(`[FASE3-adset] name: "${name}"`);
      console.log(`[FASE3-adset] ═══ END ADSET BUILD ═══`);

      return { payload: p };
    };

    // === FASE 3 LP AdSet builder (Leads via Landing Page com pixel) ===
    const buildFase3LpAdset = (name: string): { payload?: Record<string, any>; error?: string } => {
      if (!pixel_id || !lp_url) {
        return { error: "FASE 3 LP requer pixel_id e lp_url. Selecione pixel e cole URL do site." };
      }

      const lpTargeting: Record<string, any> = { ...targeting };
      if (lpTargeting.geo_locations && !lpTargeting.geo_locations.location_types) {
        lpTargeting.geo_locations.location_types = ["home", "recent"];
      } else if (!lpTargeting.geo_locations) {
        lpTargeting.geo_locations = { countries: ["BR"], location_types: ["home", "recent"] };
      }

      // L.T: idade/gênero + público Advantage (toggle do sistema).
      // ON  → advantage_audience:1 e age/gender viram SUGESTÃO (Meta expande além).
      // OFF → advantage_audience:0 + individual_setting{0,0} = limites rígidos.
      const ltAdvantage = body.lt_advantage === true || body.lt_advantage === "true";
      const ltAgeMin = Number(body.lt_age_min) || 18;
      const ltAgeMax = Number(body.lt_age_max) || 65;
      const ltGenders: number[] = Array.isArray(body.lt_genders)
        ? body.lt_genders.map(Number).filter((g: number) => g === 1 || g === 2)
        : [];
      lpTargeting.age_min = ltAgeMin;
      lpTargeting.age_max = ltAgeMax;
      if (ltGenders.length === 1) lpTargeting.genders = ltGenders;
      else delete lpTargeting.genders;
      if (ltAdvantage) {
        // Advantage+ ON: idade/gênero são SUGESTÃO (Meta expande além). individual_setting age:0/gender:0
        // marca como NÃO-fixo → permite age_min > 25 como sugestão (senão erro 100/1870188).
        lpTargeting.targeting_automation = {
          advantage_audience: 1,
          individual_setting: { age: 0, gender: 0 },
        };
      } else {
        lpTargeting.targeting_automation = {
          advantage_audience: 0,
          individual_setting: { age: 0, gender: 0 },
        };
      }
      // Advantage+ acha o público sozinho — sem seleção manual na UI. Remove
      // custom_audiences vazias (audience_id="" vira [{id:""}], que o Meta rejeita).
      if (Array.isArray(lpTargeting.custom_audiences)) {
        lpTargeting.custom_audiences = lpTargeting.custom_audiences.filter((a: any) => a?.id);
        if (lpTargeting.custom_audiences.length === 0) delete lpTargeting.custom_audiences;
      }

      const lpEvent = String(custom_event_type || "LEAD");
      // Low-ticket (PURCHASE): attribution richer [CT7d, VT1d, EVV1d] — gabarito MCP/DDX
      // pra otimização de venda. LEAD mantém CT7d simples.
      const lpAttribution = lpEvent === "PURCHASE"
        ? [
            { event_type: "CLICK_THROUGH", window_days: 7 },
            { event_type: "VIEW_THROUGH", window_days: 1 },
            { event_type: "ENGAGED_VIDEO_VIEW", window_days: 1 },
          ]
        : [{ event_type: "CLICK_THROUGH", window_days: 7 }];
      const p: Record<string, any> = {
        campaign_id: campaignId,
        name,
        status: "ACTIVE",
        billing_event: "IMPRESSIONS",
        optimization_goal: "OFFSITE_CONVERSIONS",
        destination_type: "WEBSITE",
        promoted_object: {
          pixel_id: String(pixel_id),
          custom_event_type: lpEvent,
        },
        attribution_spec: lpAttribution,
        targeting: lpTargeting,
        access_token,
      };
      applyDsa(p);
      if (structure === "ABO") {
        p.daily_budget = Math.round(Number(budget) * 100);
        p.bid_strategy = inheritedBidStrategy || "LOWEST_COST_WITHOUT_CAP";
        if (inheritedBidStrategy && inheritedBidStrategy !== "LOWEST_COST_WITHOUT_CAP" && inheritedBidAmount) {
          p.bid_amount = inheritedBidAmount;
        }
      }
      if (schedule?.start_time) p.start_time = schedule.start_time;
      else p.start_time = new Date().toISOString();
      if (schedule?.end_time) p.end_time = schedule.end_time;

      console.log(`[FASE3-LP-adset] promoted_object: ${JSON.stringify(p.promoted_object)} | destination=WEBSITE | URL=${lp_url} | advantage=${ltAdvantage} age=${ltAgeMin}-${ltAgeMax} genders=${JSON.stringify(ltGenders)}`);
      return { payload: p };
    };

    // === FASE 2 AdSet builder ===
    // Cada chamada recebe uma audience inclusion + audience exclusion.
    // optimization_goal=THRUPLAY, destination_type=ON_VIDEO, opt audience por adset
    const buildFase2Adset = (name: string, includedAudienceId: string, excludedAudienceId: string | null): { payload?: Record<string, any>; error?: string } => {
      if (!includedAudienceId) {
        return { error: "FASE 2 requer audience_id de inclusão por adset." };
      }
      // Segmentação manual (vinda do sistema): idade + gênero. genders: [1]=homens,
      // [2]=mulheres, omitido=todos. targeting_relaxation_types {0,0} DESLIGA a
      // "Usar como sugestão" (expansão de público semelhante) — antes vinha ligada
      // por default mesmo com advantage_audience:0.
      const f2AgeMin = Number(body.fase2_age_min) || 18;
      const f2AgeMax = Number(body.fase2_age_max) || 65;
      const f2Genders: number[] = Array.isArray(body.fase2_genders) ? body.fase2_genders.map(Number).filter((g: number) => g === 1 || g === 2) : [];
      const f2Targeting: Record<string, any> = {
        custom_audiences: [{ id: includedAudienceId }],
        geo_locations: { countries: ["BR"], location_types: ["home", "recent"] },
        age_min: f2AgeMin,
        age_max: f2AgeMax,
        targeting_automation: { advantage_audience: 0 },
        targeting_relaxation_types: { lookalike: 0, custom_audience: 0 },
      };
      if (f2Genders.length === 1) f2Targeting.genders = f2Genders;
      if (excludedAudienceId) {
        f2Targeting.excluded_custom_audiences = [{ id: excludedAudienceId }];
      }
      const p: Record<string, any> = {
        campaign_id: campaignId,
        name,
        status: "ACTIVE",
        billing_event: "IMPRESSIONS",
        optimization_goal: "THRUPLAY",
        destination_type: "ON_VIDEO",
        targeting: f2Targeting,
        attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
        access_token,
      };
      applyDsa(p);
      if (structure === "ABO") {
        p.daily_budget = Math.round(Number(budget) * 100);
        p.bid_strategy = inheritedBidStrategy || "LOWEST_COST_WITHOUT_CAP";
        if (inheritedBidStrategy && inheritedBidStrategy !== "LOWEST_COST_WITHOUT_CAP" && inheritedBidAmount) {
          p.bid_amount = inheritedBidAmount;
        }
      }
      if (schedule?.start_time) p.start_time = schedule.start_time;
      else p.start_time = new Date().toISOString();
      if (schedule?.end_time) p.end_time = schedule.end_time;

      console.log(`[FASE2-adset] inclusion=${includedAudienceId}, exclusion=${excludedAudienceId || "—"}, opt=THRUPLAY`);
      return { payload: p };
    };

    // Router
    const buildAdsetPayload = (name: string): { payload?: Record<string, any>; error?: string } => {
      if (isIgProfilePreset) return { payload: buildFase1Adset(name) };
      if (isWhatsAppPreset) return buildFase3Adset(name, body.audience_name);
      if (isWebsitePreset) return buildFase3LpAdset(name);
      // Fallback
      const p: Record<string, any> = {
        name, campaign_id: campaignId,
        billing_event: preset?.billing_event || "IMPRESSIONS",
        optimization_goal: preset?.optimization_goal || "LINK_CLICKS",
        bid_strategy: preset?.bid_strategy || "LOWEST_COST_WITHOUT_CAP",
        targeting, status: "ACTIVE", access_token,
      };
      if (structure === "ABO") p.daily_budget = Math.round(Number(budget) * 100);
      if (schedule?.start_time) p.start_time = schedule.start_time;
      else p.start_time = new Date().toISOString();
      if (schedule?.end_time) p.end_time = schedule.end_time;
      if (preset?.destination_type) p.destination_type = preset.destination_type;
      return { payload: p };
    };

    console.log(`[publish] builder selected: ${presetLabel}`);

    // ══════════════════════════════════════════════════════════════════
    //  CREATE ADSETS + CREATIVES + ADS
    // ══════════════════════════════════════════════════════════════════

    let adsetsCreated = 0;
    let adsCreated = 0;
    let creativesCreated = 0;
    const adsetIds: string[] = [];
    const adIds: string[] = [];
    const failures: { index: number; name: string; step: string; reason: string }[] = [];
    const adsetRetryBackoffMs = [2000, 6000, 15000];
    const maxAdsetAttempts = 3;
    const adsetDedupeWindowMinutes = 10;
    let fase3SanityCache: { contextKey?: string; ok: boolean; error_message?: string; checks?: Record<string, any> } | null = null;

    const createCreativeAndAd = async (cr: { spec: Record<string, any>; name: string }, idx: number, adsetId: string) => {
      const creativePayload: Record<string, any> = { name: `Creative - ${cr.name}`, ...cr.spec, access_token };
      if (utm_template && !isIgProfilePreset) creativePayload.url_tags = utm_template;

      logs.push({ step: `creative_${idx}`, status: "start", ts: ts(), detail: `name=${cr.name}, adset=${adsetId}` });

      const creativeRes = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/adcreatives`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creativePayload),
      });
      const creativeData = await creativeRes.json();

      if (creativeData.error) {
        const errDetail = `${creativeData.error.message} | code=${creativeData.error.code} | subcode=${creativeData.error.error_subcode} | user_title=${creativeData.error.error_user_title || ""} | user_msg=${creativeData.error.error_user_msg || ""}`;
        logs.push({ step: `creative_${idx}`, status: "error", ts: ts(), detail: `${errDetail} | payload=${JSON.stringify(sanitizePayload(creativePayload))}` });
        failures.push({ index: idx, name: cr.name, step: "creative", reason: errDetail });
        return false;
      }

      creativesCreated++;
      logs.push({ step: `creative_${idx}`, status: "success", ts: ts(), detail: `id=${creativeData.id}` });

      const adPayload: Record<string, any> = {
        adset_id: adsetId,
        name: cr.name,
        status: "ACTIVE",
        creative: { creative_id: creativeData.id },
        access_token,
      };

      // FASE 3: add tracking_specs for WhatsApp
      if (isWhatsAppPreset) {
        adPayload.tracking_specs = [
          { "action.type": ["onsite_conversion"] },
          { "action.type": ["messenger"], page: [pageId] },
          { "action.type": ["whatsapp"], page: [pageId] },
        ];
      }
      logs.push({ step: `ad_${idx}`, status: "start", ts: ts(), detail: `name=${cr.name}, creative_id=${creativeData.id}` });

      const adRes = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/ads`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(adPayload),
      });
      const adData = await adRes.json();
      if (adData.error) {
        const e = adData.error;
        const blame = e.blame_field_specs ? JSON.stringify(e.blame_field_specs) : "none";
        const fullError = JSON.stringify(e);
        const errDetail = `${e.message} | code=${e.code} | subcode=${e.error_subcode} | user_title=${e.error_user_title || ""} | user_msg=${e.error_user_msg || ""} | blame=${blame} | full=${fullError}`;
        console.log(`[ad_${idx}] full_error: ${fullError}`);
        logs.push({ step: `ad_${idx}`, status: "error", ts: ts(), detail: errDetail });
        failures.push({ index: idx, name: cr.name, step: "ad", reason: errDetail });
        return false;
      }
      adIds.push(adData.id);
      adsCreated++;
      logs.push({ step: `ad_${idx}`, status: "success", ts: ts(), detail: `id=${adData.id}` });
      return true;
    };

    // ── Standard adset creation (used by ALL presets now) ──
    const createAdset = async (adsetPayload: Record<string, any>, stepLabel: string): Promise<{ id?: string; error?: any; warning?: string }> => {
      let dedupeLockId: string | undefined;

      if (isWhatsAppPreset) {
        const promotedObjectValidation = validateFase3PromotedObject(adsetPayload.promoted_object || {});
        console.log(`[${stepLabel}] promoted_object FINAL enviado: ${JSON.stringify(adsetPayload.promoted_object || {})}`);
        console.log(`[${stepLabel}] promoted_object keys: ${JSON.stringify(promotedObjectValidation.keys)}`);

        if (!promotedObjectValidation.ok) {
          console.log(`[${stepLabel}] ❌ promoted_object inválido`);
          logs.push({
            step: stepLabel,
            status: "error",
            ts: ts(),
            detail: `promoted_object inválido | keys=${JSON.stringify(promotedObjectValidation.keys)} | unexpected=${JSON.stringify(promotedObjectValidation.unexpectedKeys)} | missing=${JSON.stringify(promotedObjectValidation.missingRequired)}`,
          });
          return {
            error: {
              message: "promoted_object inválido",
              code: "LOCAL_VALIDATION",
              error_subcode: "PROMOTED_OBJECT_INVALID",
              error_user_title: "promoted_object inválido",
              error_user_msg: "promoted_object deve conter page_id, whats_app_business_phone_number_id e whatsapp_phone_number",
            },
          };
        }

        console.log(`[${stepLabel}] VALIDAÇÃO OK — promoted_object estrutura correta`);

        const fingerprintInput = buildAdsetFingerprintInput({
          adsetPayload,
          adAccountId: ad_account_id,
          presetLabel,
          structure,
        });
        const fingerprint = await sha256Hex(JSON.stringify(fingerprintInput));
        console.log(`[${stepLabel}] fingerprint: ${fingerprint}`);

        const dedupe = await acquireAdsetDedupeLock({
          db: adminClient,
          userId: publishUserId,
          fingerprint,
          windowMinutes: adsetDedupeWindowMinutes,
          requestPayload: sanitizePayload(adsetPayload),
          stepLabel,
          presetLabel,
        });

        if (!dedupe.allowed) {
          logs.push({
            step: "idempotency",
            status: "error",
            ts: ts(),
            detail: `${dedupe.warningMessage} | step=${stepLabel} | fingerprint=${fingerprint}`,
          });
          return {
            warning: dedupe.warningMessage,
            error: {
              message: dedupe.warningMessage,
              code: "IDEMPOTENCY_BLOCKED",
              error_subcode: null,
              error_user_title: "Publicação duplicada bloqueada",
              error_user_msg: dedupe.warningMessage,
            },
          };
        }

        dedupeLockId = dedupe.lockId;

        const promotedObject = adsetPayload.promoted_object || {};
        // whatsapp_number_id (interno) ainda usado p/ sanity, mas NÃO entra no promoted_object.
        const internalWhatsappPhoneId = String(identity?.whatsapp_phone_id || whatsapp_number_id || "");
        const sanityContextKey = `${ad_account_id}|${String(promotedObject.page_id || "")}|${internalWhatsappPhoneId}`;

        if (!fase3SanityCache || fase3SanityCache.contextKey !== sanityContextKey) {
          logs.push({ step: "fase3_sanity", status: "start", ts: ts(), detail: `Executando sanity checks para page_id=${promotedObject.page_id} e whatsapp_phone_id=${internalWhatsappPhoneId}` });
          const sanity = await runFase3SanityChecks({
            accessToken: access_token,
            adAccountId: ad_account_id,
            pageId: String(promotedObject.page_id || ""),
            whatsappPhoneId: internalWhatsappPhoneId,
          });

          fase3SanityCache = {
            contextKey: sanityContextKey,
            ok: sanity.ok,
            error_message: sanity.ok ? undefined : sanity.error_message,
            checks: sanity.checks,
          };

          logs.push({
            step: "fase3_sanity",
            status: sanity.ok ? "success" : "error",
            ts: ts(),
            detail: `${sanity.ok ? "sanity checks OK" : sanity.error_message} | checks=${JSON.stringify(sanity.checks)}`,
          });
        }

        if (!fase3SanityCache.ok) {
          await finalizeAdsetDedupeLock({
            db: adminClient,
            lockId: dedupeLockId,
            status: "failed",
            response: {
              step: "fase3_sanity",
              error_message: fase3SanityCache.error_message,
              checks: fase3SanityCache.checks,
            },
          });

          return {
            error: {
              message: fase3SanityCache.error_message || "Falha nos sanity checks da FASE 3.",
              code: "SANITY_CHECK_FAILED",
              error_subcode: null,
              error_user_title: "Sanity check bloqueou a publicação",
              error_user_msg: fase3SanityCache.error_message || "Falha de validação de contexto antes da criação do adset.",
            },
          };
        }
      }

      const attemptAudit: Array<Record<string, any>> = [];
      let finalId: string | undefined;
      let finalError: any = null;

      for (let attempt = 1; attempt <= maxAdsetAttempts; attempt++) {
        const attemptTs = ts();
        const payloadForLog = sanitizePayload(adsetPayload);

        logs.push({
          step: stepLabel,
          status: "start",
          ts: attemptTs,
          detail: `attempt_number=${attempt}/${maxAdsetAttempts} | timestamp=${attemptTs} | payload=${JSON.stringify(payloadForLog)}`,
        });

        const { data, elapsedMs } = await fetchJsonWithTiming(
          `https://graph.facebook.com/v25.0/${ad_account_id}/adsets`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(adsetPayload),
          },
        );

        console.log(`[publish] adset response (${stepLabel}) [attempt ${attempt}/${maxAdsetAttempts}]: ${JSON.stringify(data)}`);

        const responseSnapshot = {
          attempt_number: attempt,
          timestamp: attemptTs,
          response_ms: elapsedMs,
          response: data,
          fbtrace_id: data?.error?.fbtrace_id || null,
        };
        attemptAudit.push(responseSnapshot);

        if (!data?.error && data?.id) {
          finalId = data.id;
          logs.push({
            step: stepLabel,
            status: "success",
            ts: ts(),
            detail: `attempt_number=${attempt}/${maxAdsetAttempts} | response_ms=${elapsedMs} | response=${JSON.stringify(data)}`,
          });
          break;
        }

        const normalizedError = data?.error || {
          message: "Resposta inválida da Meta ao criar adset",
          code: "INVALID_RESPONSE",
          error_subcode: null,
          raw_response: data,
        };
        finalError = normalizedError;

        logs.push({
          step: stepLabel,
          status: "error",
          ts: ts(),
          detail: `attempt_number=${attempt}/${maxAdsetAttempts} | response_ms=${elapsedMs} | response=${JSON.stringify(data)}`,
        });

        const retryable = [2, 4, 17].includes(normalizedError.code);
        if (retryable && attempt < maxAdsetAttempts) {
          const backoffMs = adsetRetryBackoffMs[Math.min(attempt - 1, adsetRetryBackoffMs.length - 1)];
          logs.push({
            step: `${stepLabel}_retry`,
            status: "start",
            ts: ts(),
            detail: `code=2 detectado. retry em ${backoffMs}ms (attempt ${attempt + 1}/${maxAdsetAttempts})`,
          });
          await sleep(backoffMs);
          continue;
        }

        break;
      }

      if (finalId) {
        logs.push({
          step: `${stepLabel}_summary`,
          status: "success",
          ts: ts(),
          detail: `attempts=${attemptAudit.length} | outcome=success | adset_id=${finalId} | last_error=none`,
        });

        await finalizeAdsetDedupeLock({
          db: adminClient,
          lockId: dedupeLockId,
          status: "success",
          response: {
            step: stepLabel,
            attempts: attemptAudit,
            outcome: "success",
            adset_id: finalId,
          },
        });

        return { id: finalId };
      }

      logs.push({
        step: `${stepLabel}_summary`,
        status: "error",
        ts: ts(),
        detail: `attempts=${attemptAudit.length} | outcome=failed | last_error=${JSON.stringify(finalError)}`,
      });

      await finalizeAdsetDedupeLock({
        db: adminClient,
        lockId: dedupeLockId,
        status: "failed",
        response: {
          step: stepLabel,
          attempts: attemptAudit,
          outcome: "failed",
          last_error: finalError,
        },
      });

      // 3858634 = compliance_section / "anunciante ausente": exige VERIFICAÇÃO DO ANUNCIANTE
      // no Meta Business Manager (não resolvível por API / por string no payload).
      if (finalError && Number(finalError.error_subcode) === 3858634) {
        finalError = {
          ...finalError,
          error_user_title: "Anunciante não verificado",
          error_user_msg: "Esta conta precisa de um ANUNCIANTE VERIFICADO para veicular no Brasil. " +
            "Não dá pra resolver pelo app: no Meta, vá em Gerenciador de Anúncios → Configurações de Publicidade → " +
            "'Verificações e transparência dos anúncios', conclua a verificação do anunciante/pagador e defina o anunciante padrão da conta. " +
            "Resolva também páginas restritas em facebook.com/accountquality. Depois reenvie a campanha. (erro Meta 3858634)",
        };
      }

      return {
        error: finalError || {
          message: "Falha desconhecida na criação do adset",
          code: "UNKNOWN_ADSET_ERROR",
          error_subcode: null,
        },
      };
    };

    // ── FASE 2 special flow: 1 creative + N adsets (one per audience) ──
    if (isVideoEngagementPreset && fase2AudienceIds.length > 0) {
      if (resolvedCreatives.length !== 1) {
        return respond({ ok: false, step: "publish", error_message: "FASE 2 exige exatamente 1 criativo. Forneça 1 criativo." });
      }
      const cr = resolvedCreatives[0];

      // 1. Cria 1 creative compartilhado PRIMEIRO (precisamos do video_id dele p/ VV50%).
      const creativePayload: Record<string, any> = { name: `Creative - ${cr.name}`, ...cr.spec, access_token };
      if (utm_template) creativePayload.url_tags = utm_template;
      logs.push({ step: "fase2_creative", status: "start", ts: ts() });
      const creativeRes = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/adcreatives`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creativePayload),
      });
      const creativeData = await creativeRes.json();
      if (creativeData.error) {
        logs.push({ step: "fase2_creative", status: "error", ts: ts(), detail: `${creativeData.error.message} | code=${creativeData.error.code}` });
        return respond({ ok: false, step: "creative", campaign_id: campaignId, ...formatMetaError(creativeData.error) });
      }
      const sharedCreativeId = creativeData.id;
      creativesCreated = 1;
      logs.push({ step: "fase2_creative", status: "success", ts: ts(), detail: `id=${sharedCreativeId}` });

      // 2. Extrai o video_id do creative. IG-source (source_instagram_media_id) TAMBÉM
      // expõe video_id ao ler de volta — então VV50% agora funciona p/ IG e Drive.
      let vvVideoId: string | null = cr.spec?.object_story_spec?.video_data?.video_id || null;
      if (!vvVideoId) {
        try {
          const vRes = await fetch(`https://graph.facebook.com/v25.0/${sharedCreativeId}?fields=video_id&access_token=${access_token}`);
          const vData = await vRes.json();
          vvVideoId = vData.video_id || null;
        } catch (e) { logs.push({ step: "fase2_video_id", status: "warning", ts: ts(), detail: `falha lendo video_id: ${(e as Error).message}` }); }
      }
      logs.push({ step: "fase2_video_id", status: vvVideoId ? "success" : "warning", ts: ts(), detail: vvVideoId ? `video_id=${vvVideoId}` : "sem video_id — VV50% pulada" });

      // 3. Cria audience de exclusão VV50% (qualquer fonte — IG ou Drive)
      let exclusionAudienceId: string | null = null;
      if (vvVideoId) {
        logs.push({ step: "fase2_exclusion_audience", status: "start", ts: ts(), detail: `criando VV50% audience pro video=${vvVideoId}` });
        const exclNameRaw = `VV50% [${(cr.name || "video").substring(0, 20)} - ${new Date().toISOString().slice(0,10)}]`;
        const exclName = exclNameRaw.length > 50 ? exclNameRaw.substring(0, 50) : exclNameRaw;
        const exclRuleLegacy = JSON.stringify([
          { event_name: "video_view_50_percent", object_id: Number(vvVideoId) },
        ]);
        const exclForm = new FormData();
        exclForm.append("access_token", access_token);
        exclForm.append("name", exclName);
        exclForm.append("subtype", "ENGAGEMENT");
        exclForm.append("retention_days", "365");
        exclForm.append("rule", exclRuleLegacy);
        try {
          const exclController = new AbortController();
          const exclTimeout = setTimeout(() => exclController.abort(), 15000);
          const exclRes = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/customaudiences`, { method: "POST", body: exclForm, signal: exclController.signal });
          clearTimeout(exclTimeout);
          const exclData = await exclRes.json();
          if (exclData.error) {
            const errDetail = `${exclData.error.message} | code=${exclData.error.code} | subcode=${exclData.error.error_subcode || "-"} | user_msg=${exclData.error.error_user_msg || ""}`;
            logs.push({ step: "fase2_exclusion_audience", status: "error", ts: ts(), detail: errDetail });
            logs.push({ step: "fase2_exclusion_audience", status: "warning", ts: ts(), detail: `⚠️ Continuando SEM audience de exclusão.` });
          } else {
            exclusionAudienceId = exclData.id;
            logs.push({ step: "fase2_exclusion_audience", status: "success", ts: ts(), detail: `id=${exclusionAudienceId}` });
          }
        } catch (e) {
          logs.push({ step: "fase2_exclusion_audience", status: "warning", ts: ts(), detail: `⚠️ Skipped (timeout/erro): ${(e as Error).message}` });
        }
      } else {
        logs.push({ step: "fase2_exclusion_audience", status: "skipped", ts: ts(), detail: `sem video_id — crie a VV50% manual.` });
      }

      // 3. Loop sobre audiences: 1 adset + 1 ad pra cada
      for (let i = 0; i < fase2AudienceIds.length; i++) {
        const audId = fase2AudienceIds[i];
        const audName = fase2AudienceNames[i] || audId;
        const idx = i + 1;
        const adsetPayloadName = `[${audName}] - ${cr.name}`;
        const adsetBuild = buildFase2Adset(adsetPayloadName, audId, exclusionAudienceId);
        if (adsetBuild.error) {
          failures.push({ index: idx, name: audId, step: "adset", reason: adsetBuild.error });
          continue;
        }
        const adsetResult = await createAdset(adsetBuild.payload!, `adset_${idx}`);
        if (adsetResult.warning) {
          return respond({ ok: false, step: "idempotency", campaign_id: campaignId, warning: true, error_message: adsetResult.warning });
        }
        if (adsetResult.error) {
          failures.push({ index: idx, name: audId, step: "adset", reason: adsetResult.error.message || JSON.stringify(adsetResult.error) });
          continue;
        }
        const adsetId = adsetResult.id!;
        adsetIds.push(adsetId);
        adsetsCreated++;

        // Cria 1 ad referenciando o creative compartilhado
        const adPayload = {
          adset_id: adsetId,
          name: `${cr.name} - ${String(idx).padStart(2, "0")}`,
          status: "ACTIVE",
          creative: { creative_id: sharedCreativeId },
          access_token,
        };
        logs.push({ step: `ad_${idx}`, status: "start", ts: ts(), detail: `creative=${sharedCreativeId}, adset=${adsetId}` });
        const adRes = await fetch(`https://graph.facebook.com/v25.0/${ad_account_id}/ads`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(adPayload),
        });
        const adData = await adRes.json();
        if (adData.error) {
          const errDetail = `${adData.error.message} | code=${adData.error.code} | subcode=${adData.error.error_subcode}`;
          logs.push({ step: `ad_${idx}`, status: "error", ts: ts(), detail: errDetail });
          failures.push({ index: idx, name: audId, step: "ad", reason: errDetail });
          continue;
        }
        adIds.push(adData.id);
        adsCreated++;
        logs.push({ step: `ad_${idx}`, status: "success", ts: ts(), detail: `id=${adData.id}` });
      }

      // Skip o restante do fluxo CBO/ABO
      logs.push({ step: "summary", status: failures.length === 0 ? "success" : "error", ts: ts(), detail: `preset=FASE 2, adsets=${adsetsCreated}, creatives=${creativesCreated}, ads=${adsCreated}, failures=${failures.length}, exclusion_audience=${exclusionAudienceId}` });
      return respond({
        ok: failures.length === 0,
        campaign_id: campaignId,
        adsets_created: adsetsCreated,
        ads_created: adsCreated,
        exclusion_audience_id: exclusionAudienceId,
        failures: failures.length > 0 ? failures : undefined,
      });
    }

    // Nome do conjunto: [PUBLICO] {WHATS|PAGINA|SLUG} - NomeCriativo
    // WHATS se WhatsApp; L.T (site) usa o SLUG da página (último segmento da URL,
    // ex: marianaeiraspersona.com/ddx-12/ → DDX-12); senão PAGINA.
    // ABO: 1 criativo por conjunto → inclui nome do criativo.
    // CBO: 1 conjunto, N criativos → sem nome do criativo.
    const lpSlug = (() => {
      if (!isWebsitePreset || !lp_url) return "";
      try {
        const raw = String(lp_url);
        const u = raw.includes("://") ? raw : `https://${raw}`;
        const path = new URL(u).pathname.replace(/\/+$/, "");
        return (path.split("/").filter(Boolean).pop() || "").toUpperCase();
      } catch { return ""; }
    })();
    const chanTag = isWhatsAppPreset ? "WHATS" : isWebsitePreset ? (lpSlug || "PAGINA") : isIgProfilePreset ? "IG" : "PAGINA";
    const audTag = (body.audience_name || adset_name || generated_name || "Público").trim();
    const makeAdsetName = (creativeName?: string) =>
      creativeName ? `[${audTag}] {${chanTag}} - ${creativeName}` : `[${audTag}] {${chanTag}}`;

    if (structure === "CBO") {
      let adsetId: string;
      if (existing_adset_id) {
        // Orquestração por criativo: reusa o adset CBO criado na 1ª chamada
        // (mesma campanha, 1 adset, N criativos espalhados em chamadas separadas).
        adsetId = existing_adset_id;
        adsetIds.push(adsetId);
        logs.push({ step: "adset", status: "success", ts: ts(), detail: `existing adset: ${adsetId}` });
      } else {
        const adsetPayloadName = makeAdsetName();
        const adsetBuild = buildAdsetPayload(adsetPayloadName);
        if (adsetBuild.error) {
          logs.push({ step: "adset", status: "error", ts: ts(), detail: adsetBuild.error });
          return respond({ ok: false, step: "adset", campaign_id: campaignId, error_message: adsetBuild.error });
        }
        const adsetResult = await createAdset(adsetBuild.payload!, "adset");

        if (adsetResult.warning) {
          return respond({
            ok: false,
            step: "idempotency",
            campaign_id: campaignId,
            warning: true,
            error_message: adsetResult.warning,
          });
        }

        if (adsetResult.error) {
          return respond({ ok: false, step: "adset", campaign_id: campaignId, ...formatMetaError(adsetResult.error) });
        }
        adsetId = adsetResult.id!;
        adsetIds.push(adsetId);
        adsetsCreated = 1;
      }

      for (let i = 0; i < resolvedCreatives.length; i++) {
        await createCreativeAndAd(resolvedCreatives[i], i + 1, adsetId);
      }
    } else {
      // ABO: N AdSets, 1 Ad each
      for (let i = 0; i < resolvedCreatives.length; i++) {
        const cr = resolvedCreatives[i];
        const idx = i + 1;
        const adsetPayloadName = makeAdsetName(cr.name);

        const adsetBuild = buildAdsetPayload(adsetPayloadName);
        if (adsetBuild.error) {
          failures.push({ index: idx, name: cr.name, step: "adset", reason: adsetBuild.error });
          continue;
        }
        const adsetResult = await createAdset(adsetBuild.payload!, `adset_${idx}`);

        if (adsetResult.warning) {
          return respond({
            ok: false,
            step: "idempotency",
            campaign_id: campaignId,
            warning: true,
            error_message: adsetResult.warning,
          });
        }

        if (adsetResult.error) {
          failures.push({ index: idx, name: cr.name, step: "adset", reason: adsetResult.error.message });
          continue;
        }
        const adsetId = adsetResult.id!;
        adsetIds.push(adsetId);
        adsetsCreated++;

        await createCreativeAndAd(cr, idx, adsetId);
      }
    }

    // ── Summary ──
    logs.push({ step: "summary", status: adsCreated > 0 ? "success" : "error", ts: ts(), detail: `preset=${presetLabel}, structure=${structure}, adsets=${adsetsCreated}, creatives=${creativesCreated}, ads=${adsCreated}, failures=${failures.length}` });
    if (failures.length > 0) {
      logs.push({ step: "failure_details", status: "error", ts: ts(), detail: failures.map(f => `#${f.index} "${f.name}" failed at ${f.step}: ${f.reason}`).join(" | ") });
    }

    if (adsCreated === 0) {
      return respond({
        ok: false, step: "publish", campaign_id: campaignId,
        error_message: `Nenhum anúncio criado. ${adsetsCreated} adset(s), ${creativesCreated} creative(s). Verifique os logs.`,
        adsets_created: adsetsCreated, ads_created: 0, failures,
      });
    }

    return respond({
      ok: true, campaign_id: campaignId,
      adset_id: adsetIds[0], adsets_created: adsetsCreated,
      creatives_created: creativesCreated, ads_created: adsCreated,
      ad_id: adIds[0], adset_ids: adsetIds, ad_ids: adIds,
      failures: failures.length > 0 ? failures : undefined,
    });
  } catch (e) {
    console.error("[publish] unhandled error", e);
    const stackTrace = e.stack ? e.stack.split("\n").slice(0, 5).join(" | ") : "";
    logs.push({ step: "edge_function_internal", status: "error", ts: ts(), detail: `${e.message} | stack: ${stackTrace}` });
    return respond({
      ok: false,
      step: "edge_function_internal",
      error_message: e.message,
      stack_trace: stackTrace,
      preset_used: isWhatsAppPreset ? "FASE 3" : isIgProfilePreset ? "FASE 1" : "GENERIC",
      structure: structure,
    });
  }
});
