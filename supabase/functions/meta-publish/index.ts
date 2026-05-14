import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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
  const res = await fetch(url, init);
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

  const pageCheck = await fetchJsonWithTiming(
    `https://graph.facebook.com/v25.0/${params.pageId}?fields=id,name&access_token=${params.accessToken}`,
  );
  checks.page = { elapsed_ms: pageCheck.elapsedMs, status: pageCheck.status, response: pageCheck.data };
  if (pageCheck.data?.error) {
    return {
      ok: false,
      error_message: `Sem acesso à Página ${params.pageId}: ${pageCheck.data.error.message}`,
      checks,
    };
  }

  // Em v25 o subfield whatsapp_business_account não existe mais no node de phone.
  // Query só campos válidos. Se Meta rejeitar o phone na criação do adset, o erro vai
  // aparecer no passo certo — não tentamos cross-validar via WABA aqui.
  const phoneCheck = await fetchJsonWithTiming(
    `https://graph.facebook.com/v25.0/${params.whatsappPhoneId}?fields=id,display_phone_number,verified_name&access_token=${params.accessToken}`,
  );
  checks.whatsapp_phone = { elapsed_ms: phoneCheck.elapsedMs, status: phoneCheck.status, response: phoneCheck.data };
  if (phoneCheck.data?.error) {
    return {
      ok: false,
      error_message: `WhatsApp Phone ID inválido/inacessível (${params.whatsappPhoneId}): ${phoneCheck.data.error.message}`,
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
  if (t.age_min !== 18) errors.push(`age_min deve ser 18, encontrado: ${t.age_min}`);
  if (t.age_max !== 65) errors.push(`age_max deve ser 65, encontrado: ${t.age_max}`);
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
  ): Promise<{ mediaId?: string; permalink?: string; pageId?: string; igActorId?: string; error?: string }> => {
    let url: string | null = `https://graph.facebook.com/v25.0/${igActorId}/media?fields=id,shortcode,permalink&limit=100&access_token=${accessToken}`;
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
        console.log(`[ig_media_resolve] FOUND media_id=${found.id}, ig_actor=${igActorId}, scanned=${scanned}`);
        logs.push({ step: "ig_media_resolve", status: "success", ts: ts(), detail: `media_id=${found.id}, ig_actor=${igActorId}, scanned=${scanned}` });
        return { mediaId: found.id, permalink: found.permalink, pageId, igActorId };
      }
      url = data.paging?.next || null;
    }
    return {};
  };

  let resolvedMedia: { mediaId?: string; permalink?: string; pageId?: string; igActorId?: string; error?: string } = {};

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
  let downloadUrl = driveLink;
  const fileIdMatch = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (fileIdMatch) downloadUrl = `https://drive.google.com/uc?export=download&id=${fileIdMatch[1]}`;
  const fileRes = await fetch(downloadUrl, { redirect: "follow" });
  if (!fileRes.ok) return { error: "Falha ao baixar arquivo do Drive." };
  const contentType = fileRes.headers.get("content-type") || "";
  const contentDisp = fileRes.headers.get("content-disposition") || "";
  const fileBlob = await fileRes.blob();

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
  console.log(`[drive-upload] ct=${contentType}, disp_hint=${filenameSaysVideo}, magic_video=${bytesSayVideo} => isVideo=${isVideo}`);

  if (isVideo) {
    const formData = new FormData();
    formData.append("access_token", accessToken);
    formData.append("file_url", downloadUrl);
    const uploadRes = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/advideos`, { method: "POST", body: formData });
    const uploadData = await uploadRes.json();
    if (uploadData.error) return { error: uploadData.error.message };
    return { video_id: uploadData.id };
  } else {
    const formData = new FormData();
    formData.append("access_token", accessToken);
    formData.append("filename", "creative.jpg");
    formData.append("bytes", await blobToBase64(fileBlob));
    const uploadRes = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/adimages`, { method: "POST", body: formData });
    const uploadData = await uploadRes.json();
    if (uploadData.error) return { error: uploadData.error.message };
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
      call_to_action: { type: "VISIT_PROFILE", value: { link: igProfileLink } },
    };

    console.log(`[FASE1-creative] OK: media=${result.instagram_media_id}, ig=${resolvedIgActor}, CTA=VISIT_PROFILE`);
    logs.push({ step: "fase1_creative", status: "success", ts: ts(), detail: `media=${result.instagram_media_id}, CTA=VISIT_PROFILE` });
    return { spec };

  } else if (isDriveLink) {
    const result = await uploadDriveCreative(accessToken, adAccountId, creativeLink);
    if (result.error) return { error: result.error };

    if (result.image_hash) {
      const linkData: Record<string, any> = {
        image_hash: result.image_hash,
        message: creativeName,
        link: igProfileLink,
        call_to_action: { type: "VISIT_PROFILE", value: { link: igProfileLink } },
      };
      const storySpec: Record<string, any> = { page_id: pageId, link_data: linkData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE1-creative] OK: image_hash, CTA=VISIT_PROFILE, link=${igProfileLink}`);
      logs.push({ step: "fase1_creative", status: "success", ts: ts(), detail: `image_hash=${result.image_hash}, CTA=VISIT_PROFILE` });
      return { spec: { object_story_spec: storySpec } };

    } else if (result.video_id) {
      // Wait for video processing and get thumbnail
      let thumbnailField: Record<string, string> = {};
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        const vidRes = await fetch(`https://graph.facebook.com/v25.0/${result.video_id}?fields=status,picture&access_token=${accessToken}`);
        const vidData = await vidRes.json();
        if (vidData.picture) {
          try {
            const thumbRes = await fetch(vidData.picture);
            if (thumbRes.ok) {
              const thumbBlob = await thumbRes.blob();
              const thumbB64 = await blobToBase64(thumbBlob);
              const imgForm = new FormData();
              imgForm.append("access_token", accessToken);
              imgForm.append("filename", "video_thumb.jpg");
              imgForm.append("bytes", thumbB64);
              const imgUpRes = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/adimages`, { method: "POST", body: imgForm });
              const imgUpData = await imgUpRes.json();
              if (imgUpData.images) { const firstKey = Object.keys(imgUpData.images)[0]; thumbnailField = { image_hash: imgUpData.images[firstKey].hash }; }
            }
          } catch {}
          if (!thumbnailField.image_hash) thumbnailField = { image_url: vidData.picture };
          break;
        }
      }

      const videoData: Record<string, any> = {
        video_id: result.video_id,
        ...thumbnailField,
        message: creativeName,
        call_to_action: { type: "VISIT_PROFILE", value: { link: igProfileLink } },
      };
      const storySpec: Record<string, any> = { page_id: pageId, video_data: videoData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE1-creative] OK: video_id=${result.video_id}, CTA=VISIT_PROFILE`);
      logs.push({ step: "fase1_creative", status: "success", ts: ts(), detail: `video_id=${result.video_id}, CTA=VISIT_PROFILE` });
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

    // Aguardar processing (15s max)
    let thumbnailField: Record<string, string> = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const vidRes = await fetch(`https://graph.facebook.com/v25.0/${result.video_id}?fields=picture&access_token=${accessToken}`);
      const vidData = await vidRes.json();
      if (vidData.picture) { thumbnailField = { image_url: vidData.picture }; break; }
    }

    const videoData: Record<string, any> = {
      video_id: result.video_id,
      ...thumbnailField,
      message: creativeName,
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
        message: creativeName,
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
      // Aguardar processing + thumbnail (mesmo padrão do FASE 1 Drive video)
      let thumbnailField: Record<string, string> = {};
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        const vidRes = await fetch(`https://graph.facebook.com/v25.0/${result.video_id}?fields=status,picture&access_token=${accessToken}`);
        const vidData = await vidRes.json();
        if (vidData.picture) {
          try {
            const thumbRes = await fetch(vidData.picture);
            if (thumbRes.ok) {
              const thumbBlob = await thumbRes.blob();
              const thumbB64 = await blobToBase64(thumbBlob);
              const imgForm = new FormData();
              imgForm.append("access_token", accessToken);
              imgForm.append("filename", "video_thumb.jpg");
              imgForm.append("bytes", thumbB64);
              const imgUpRes = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/adimages`, { method: "POST", body: imgForm });
              const imgUpData = await imgUpRes.json();
              if (imgUpData.images) { const firstKey = Object.keys(imgUpData.images)[0]; thumbnailField = { image_hash: imgUpData.images[firstKey].hash }; }
            }
          } catch {}
          if (!thumbnailField.image_hash) thumbnailField = { image_url: vidData.picture };
          break;
        }
      }

      const videoData: Record<string, any> = {
        video_id: result.video_id,
        ...thumbnailField,
        message: creativeName,
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
        message: readyMessage || creativeName,
        link: waLink,
        call_to_action: callToAction,
        page_welcome_message: welcomeMessageJson,
      };
      const storySpec: Record<string, any> = { page_id: pageId, link_data: linkData };
      if (igActorId) storySpec.instagram_user_id = igActorId;
      console.log(`[FASE3-creative] OK (drive/image): hash=${result.image_hash}`);
      logs.push({ step: "fase3_creative", status: "success", ts: ts(), detail: `source=drive/image, hash=${result.image_hash}, CTA=WHATSAPP_MESSAGE` });
      return { spec: { object_story_spec: storySpec } };

    } else if (result.video_id) {
      // Wait for thumbnail
      let thumbnailField: Record<string, string> = {};
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        const vidRes = await fetch(`https://graph.facebook.com/v25.0/${result.video_id}?fields=status,picture&access_token=${accessToken}`);
        const vidData = await vidRes.json();
        if (vidData.picture) {
          try {
            const thumbRes = await fetch(vidData.picture);
            if (thumbRes.ok) {
              const thumbBlob = await thumbRes.blob();
              const thumbB64 = await blobToBase64(thumbBlob);
              const imgForm = new FormData();
              imgForm.append("access_token", accessToken);
              imgForm.append("filename", "video_thumb.jpg");
              imgForm.append("bytes", thumbB64);
              const imgUpRes = await fetch(`https://graph.facebook.com/v25.0/${adAccountId}/adimages`, { method: "POST", body: imgForm });
              const imgUpData = await imgUpRes.json();
              if (imgUpData.images) { const firstKey = Object.keys(imgUpData.images)[0]; thumbnailField = { image_hash: imgUpData.images[firstKey].hash }; }
            }
          } catch {}
          if (!thumbnailField.image_hash) thumbnailField = { image_url: vidData.picture };
          break;
        }
      }

      const videoData: Record<string, any> = {
        video_id: result.video_id,
        ...thumbnailField,
        message: readyMessage || creativeName,
        call_to_action: callToAction,
        page_welcome_message: welcomeMessageJson,
      };
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
  const respond = (body: Record<string, any>, status = 200) =>
    new Response(JSON.stringify({ ...body, logs }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

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

    const structure = distribution_structure || "ABO";
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
      console.log(`[publish]   CTA: VISIT_PROFILE (automatic)`);
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

    // --- Resolve ALL creatives using preset-specific builder ---
    logs.push({ step: "resolve_creatives", status: "start", ts: ts(), detail: `${creativesList.length} creative(s), builder=${presetLabel}` });
    const resolvedCreatives: { spec: Record<string, any>; name: string }[] = [];

    for (let ci = 0; ci < creativesList.length; ci++) {
      const cr = creativesList[ci];
      console.log(`[publish] creative ${ci + 1}/${creativesList.length}: type=${cr.type}, name=${cr.name}, builder=${presetLabel}`);

      let result: { spec?: Record<string, any>; error?: string };

      if (isVideoEngagementPreset) {
        // ── FASE 2: vídeo Drive ou IG re-upload (precisa video_id pra criar exclusion audience) ──
        result = await buildFase2Creative(
          access_token, ad_account_id, cr.link, cr.type, cr.name,
          pageId, igActorId,
          logs,
        );
      } else if (isWebsitePreset) {
        // ── FASE 3 LP: creative com link pra site externo + pixel ──
        result = await buildFase3LpCreative(
          access_token, ad_account_id, cr.link, cr.type, cr.name,
          pageId, igActorId,
          lp_url || "",
          logs,
        );
      } else if (isWhatsAppPreset) {
        // ── FASE 3: dedicated builder ──
        result = await buildFase3Creative(
          access_token, ad_account_id, cr.link, cr.type, cr.name,
          pageId, igActorId,
          whatsapp_number || "",  // phone display for WA link
          greeting_text, ready_message,
          imported_template_json,
          logs,
        );
      } else if (isIgProfilePreset) {
        // ── FASE 1: dedicated builder ──
        result = await buildFase1Creative(
          access_token, ad_account_id, cr.link, cr.type, cr.name,
          pageId, igActorId,
          identity?.instagram_username || undefined,
          logs,
        );
      } else {
        // ── GENERIC fallback ──
        result = await buildFase1Creative(
          access_token, ad_account_id, cr.link, cr.type, cr.name,
          pageId, igActorId,
          identity?.instagram_username || undefined,
          logs,
        );
      }

      if (result.error) {
        logs.push({ step: "resolve_creatives", status: "error", ts: ts(), detail: `creative ${ci + 1} "${cr.name}": ${result.error}` });
        return respond({ ok: false, step: "resolve_creative", error_message: result.error });
      }
      resolvedCreatives.push({ spec: result.spec!, name: cr.name });
    }
    logs.push({ step: "resolve_creatives", status: "success", ts: ts(), detail: `${resolvedCreatives.length} resolved` });

    const targeting = buildTargeting(audience_type || "custom", audience_id, targeting_spec, location_targeting);
    const finalCampaignName = campaign_name || generated_name || "Campaign";

    // ══════════════════════════════════════════════════════════════════
    //  CAMPAIGN BUILDER
    // ══════════════════════════════════════════════════════════════════
    let campaignId: string;
    if (existing_campaign_id) {
      logs.push({ step: "campaign", status: "success", ts: ts(), detail: `existing: ${existing_campaign_id}` });
      campaignId = existing_campaign_id;
    } else {
      logs.push({ step: "campaign", status: "start", ts: ts() });
      const resolvedCampaignObjective = isWhatsAppPreset ? fase3CampaignObjective : (preset?.objective || "OUTCOME_TRAFFIC");
      // FASE 3: campaign MÍNIMA — WhatsApp pertence EXCLUSIVAMENTE ao adset
      const campaignPayload: Record<string, any> = {
        name: finalCampaignName,
        objective: resolvedCampaignObjective,
        status: "PAUSED",
        special_ad_categories: [],
        buying_type: "AUCTION",
        smart_promotion_type: "GUIDED_CREATION",
        access_token,
      };

      if (structure === "CBO") {
        campaignPayload.daily_budget = Math.round(Number(budget) * 100);
        console.log(`[publish] CAMPAIGN BUDGET (CBO): ${campaignPayload.daily_budget} cents`);
      }

      if (schedule?.start_time) campaignPayload.start_time = schedule.start_time;

      // Validação: bloquear se qualquer campo proibido existir na campaign
      const forbiddenCampaignKeys = ["promoted_object", "page_id", "whatsapp_phone_number", "whats_app_business_phone_number_id", "destination_type", "optimization_goal", "billing_event", "targeting", "attribution_spec", "is_adset_budget_sharing_enabled"];
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
      logs.push({ step: "campaign", status: "success", ts: ts(), detail: `id=${campaignId} | response=${JSON.stringify(campaignData)}` });
    }

    // ══════════════════════════════════════════════════════════════════
    //  ADSET BUILDERS — completely isolated per preset
    // ══════════════════════════════════════════════════════════════════

    // === FASE 1 AdSet builder ===
    const buildFase1Adset = (name: string): Record<string, any> => {
      // FASE 1 adset:
      // - advantage_audience FORÇADO = 0 (override user input)
      // - promoted_object DEVE ter { page_id, instagram_profile_id } — sem instagram_profile_id
      //   o ad falha #1346001/#100/2446391 quando o connected user não é admin direto da Page
      //   (cenário típico: agência conectada via Business Manager).
      // - sem attribution_spec
      const promotedObject: Record<string, any> = { page_id: pageId };
      if (igActorId) promotedObject.instagram_profile_id = igActorId;
      const p: Record<string, any> = {
        name,
        campaign_id: campaignId,
        billing_event: "IMPRESSIONS",
        optimization_goal: "PROFILE_VISIT",
        bid_strategy: preset?.bid_strategy || "LOWEST_COST_WITHOUT_CAP",
        targeting: { ...targeting, targeting_automation: { advantage_audience: 0 } },
        status: "ACTIVE",
        destination_type: "INSTAGRAM_PROFILE",
        promoted_object: promotedObject,
        access_token,
      };
      if (structure === "ABO") {
        p.daily_budget = Math.round(Number(budget) * 100);
      }
      if (schedule?.start_time) p.start_time = schedule.start_time;
      else p.start_time = new Date().toISOString();
      if (schedule?.end_time) p.end_time = schedule.end_time;

      console.log(`[FASE1-adset] ── FIXED: destination=INSTAGRAM_PROFILE, optimization=PROFILE_VISIT, advantage_audience=0`);
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

      // age
      fase3Targeting.age_min = 18;
      fase3Targeting.age_max = 65;

      // custom_audiences vs saved_audiences — tratar tipo corretamente
      const audienceType = body.audience_type || "custom";
      if (audience_id) {
        if (audienceType === "saved" && targeting_spec) {
          // Saved audience: mesclar targeting_spec (interests, behaviors, etc.)
          const savedTargeting = { ...targeting_spec };
          delete savedTargeting.age_min;
          delete savedTargeting.age_max;
          delete savedTargeting.geo_locations;
          delete savedTargeting.targeting_automation;
          delete savedTargeting.targeting_optimization;
          delete savedTargeting.brand_safety_content_filter_levels;
          Object.assign(fase3Targeting, savedTargeting);
          console.log(`[FASE3-adset] audience type=saved, merged targeting_spec fields`);
        } else {
          // Custom audience: enviar como custom_audiences
          fase3Targeting.custom_audiences = [{ id: audience_id, name: audienceName || "" }];
          console.log(`[FASE3-adset] audience type=custom, id=${audience_id}`);
        }
      } else if (targeting?.custom_audiences) {
        fase3Targeting.custom_audiences = targeting.custom_audiences;
      }

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
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        daily_budget: String(Math.round(Number(budget) * 100)),
        destination_type: "WHATSAPP",
        promoted_object: promotedObject,
        targeting: fase3Targeting,
        attribution_spec: attributionSpec,
        access_token,
      };
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
      lpTargeting.targeting_automation = {
        advantage_audience: 0,
        individual_setting: { age: 0, gender: 0 },
      };

      const p: Record<string, any> = {
        campaign_id: campaignId,
        name,
        status: "ACTIVE",
        billing_event: "IMPRESSIONS",
        optimization_goal: "OFFSITE_CONVERSIONS",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        destination_type: "WEBSITE",
        promoted_object: {
          pixel_id: String(pixel_id),
          custom_event_type: String(custom_event_type || "LEAD"),
        },
        attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 7 }],
        targeting: lpTargeting,
        access_token,
      };
      if (structure === "ABO") p.daily_budget = Math.round(Number(budget) * 100);
      if (schedule?.start_time) p.start_time = schedule.start_time;
      else p.start_time = new Date().toISOString();
      if (schedule?.end_time) p.end_time = schedule.end_time;

      console.log(`[FASE3-LP-adset] promoted_object: ${JSON.stringify(p.promoted_object)} | destination=WEBSITE | URL=${lp_url}`);
      return { payload: p };
    };

    // === FASE 2 AdSet builder ===
    // Cada chamada recebe uma audience inclusion + audience exclusion.
    // optimization_goal=THRUPLAY, destination_type=ON_VIDEO, opt audience por adset
    const buildFase2Adset = (name: string, includedAudienceId: string, excludedAudienceId: string | null): { payload?: Record<string, any>; error?: string } => {
      if (!includedAudienceId) {
        return { error: "FASE 2 requer audience_id de inclusão por adset." };
      }
      const f2Targeting: Record<string, any> = {
        custom_audiences: [{ id: includedAudienceId }],
        geo_locations: { countries: ["BR"], location_types: ["home", "recent"] },
        targeting_automation: { advantage_audience: 0, individual_setting: { age: 0, gender: 0 } },
      };
      if (excludedAudienceId) {
        f2Targeting.excluded_custom_audiences = [{ id: excludedAudienceId }];
      }
      const p: Record<string, any> = {
        campaign_id: campaignId,
        name,
        status: "ACTIVE",
        billing_event: "IMPRESSIONS",
        optimization_goal: "THRUPLAY",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        destination_type: "ON_VIDEO",
        targeting: f2Targeting,
        attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
        access_token,
      };
      if (structure === "ABO") p.daily_budget = Math.round(Number(budget) * 100);
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
        const blame = adData.error.blame_field_specs ? JSON.stringify(adData.error.blame_field_specs) : "none";
        const errDetail = `${adData.error.message} | code=${adData.error.code} | subcode=${adData.error.error_subcode} | blame=${blame}`;
        console.log(`[ad_${idx}] full_error: ${JSON.stringify(adData.error)}`);
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

        const retryable = normalizedError.code === 2;
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
      // Drive: video_id em object_story_spec.video_data. IG: source_instagram_media_id flat.
      const driveVideoId = cr.spec?.object_story_spec?.video_data?.video_id;
      const igMediaId = cr.spec?.source_instagram_media_id;

      // 1. Cria audience de exclusão VV50% — APENAS pra Drive (precisa video_id válido).
      // Pra IG link: skipa (Meta não permite criar audience VV50% de IG media direto).
      let exclusionAudienceId: string | null = null;
      if (driveVideoId) {
        logs.push({ step: "fase2_exclusion_audience", status: "start", ts: ts(), detail: `criando VV50% audience pro video=${driveVideoId}` });
        const exclNameRaw = `VV50% [${(cr.name || "video").substring(0, 20)} - ${new Date().toISOString().slice(0,10)}]`;
        const exclName = exclNameRaw.length > 50 ? exclNameRaw.substring(0, 50) : exclNameRaw;
        const exclRuleLegacy = JSON.stringify([
          { event_name: "video_view_50_percent", object_id: Number(driveVideoId) },
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
            logs.push({ step: "fase2_exclusion_audience", status: "warning", ts: ts(), detail: `⚠️ Continuando SEM audience de exclusão. Crie manualmente no Meta UI.` });
          } else {
            exclusionAudienceId = exclData.id;
            logs.push({ step: "fase2_exclusion_audience", status: "success", ts: ts(), detail: `id=${exclusionAudienceId}` });
          }
        } catch (e) {
          logs.push({ step: "fase2_exclusion_audience", status: "warning", ts: ts(), detail: `⚠️ Skipped (timeout/erro): ${(e as Error).message}` });
        }
      } else {
        logs.push({ step: "fase2_exclusion_audience", status: "skipped", ts: ts(), detail: `IG link não suporta VV50% audience direto. Crie manualmente.` });
      }

      // 2. Cria 1 creative compartilhado
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
          name: `${cr.name} - ${adsetNum}`,
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

    if (structure === "CBO") {
      const adsetPayloadName = adset_name || `${generated_name || "Campaign"} - AdSet`;
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
      const adsetId = adsetResult.id!;
      adsetIds.push(adsetId);
      adsetsCreated = 1;

      for (let i = 0; i < resolvedCreatives.length; i++) {
        await createCreativeAndAd(resolvedCreatives[i], i + 1, adsetId);
      }
    } else {
      // ABO: N AdSets, 1 Ad each
      for (let i = 0; i < resolvedCreatives.length; i++) {
        const cr = resolvedCreatives[i];
        const idx = i + 1;
        const adsetNum = String(idx).padStart(2, "0");
        const baseAdsetName = adset_name || `${generated_name || "Campaign"} - AdSet`;
        const adsetPayloadName = resolvedCreatives.length > 1 ? `${baseAdsetName} ${adsetNum}` : baseAdsetName;

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
