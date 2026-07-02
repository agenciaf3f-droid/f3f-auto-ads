import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Lista TODOS os "Modelo de mensagem" (page_welcome_message) criados na conta de anúncios.
// Meta não expõe esses templates via API direta — eles ficam embutidos no JSON
// `page_welcome_message` de cada CRIATIVO. Varremos a biblioteca de criativos da conta
// (/adcreatives, paginado), que traz TODOS os criativos independente do status/idade do
// anúncio — antes varríamos por adset (cap 60 conjuntos × 5 ads), o que pegava só os
// primeiros/recentes ("só os ativos"). Criativos não-WhatsApp não têm page_welcome_message
// e são naturalmente ignorados.

type TemplateRow = {
  key: string;
  template_id: string;
  welcome_text: string;
  autofill: string;
  quick_reply: string | null;
  sample_ad_name: string;
  raw_json: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id, max_creatives = 2000 } = await req.json();
    if (!access_token || !ad_account_id) {
      return new Response(JSON.stringify({ error: "access_token e ad_account_id são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const seen = new Map<string, TemplateRow>();
    let scannedCreatives = 0;
    let parseErrors = 0;
    let errorSample: string | null = null;
    let listError: string | null = null;

    // page_welcome_message pode vir no topo do criativo OU dentro do object_story_spec
    // (video_data/link_data) — mesmos campos que a versão antiga lia por ad.
    const fields = "id,name,page_welcome_message,object_story_spec{video_data{page_welcome_message},link_data{page_welcome_message}}";
    let nextUrl: string | null =
      `https://graph.facebook.com/v25.0/${ad_account_id}/adcreatives?fields=${encodeURIComponent(fields)}&limit=200&access_token=${access_token}`;

    while (nextUrl && scannedCreatives < max_creatives) {
      const r = await fetch(nextUrl);
      const data = await r.json();
      if (data.error) {
        const isRate = [4, 17, 32].includes(Number(data.error.code)) || /request limit/i.test(data.error.message || "");
        // Nada varrido ainda → surfa erro claro (200 + lista vazia; templates são opcionais).
        if (scannedCreatives === 0) {
          return new Response(JSON.stringify({
            templates: [],
            scanned_creatives: 0,
            scanned_adsets: 0, // compat com log do frontend
            errors_during_scan: 1,
            error_sample: `${data.error.code || "?"}: ${data.error.message || ""}`,
            error_summary: isRate
              ? "Limite de requisições do Meta atingido. Aguarde alguns minutos e clique em Buscar de novo (ou digite a mensagem manualmente)."
              : `Erro ao listar criativos: ${data.error.message}`,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // Já temos alguns → degrada gracioso com o que juntou.
        listError = `${data.error.code || "?"}: ${data.error.message || ""}`;
        break;
      }

      for (const cr of (data.data || [])) {
        scannedCreatives++;
        const pwm = cr.page_welcome_message
          || cr.object_story_spec?.video_data?.page_welcome_message
          || cr.object_story_spec?.link_data?.page_welcome_message;
        if (!pwm) continue;
        try {
          const parsed = JSON.parse(pwm);
          const tplId = String(parsed.template_id || "inline");
          const text = parsed.text_format?.message?.text || parsed.image_format?.message?.text || "";
          const autofill = parsed.text_format?.message?.autofill_message?.content || "";
          const qrTitle = parsed.image_format?.message?.quick_replies?.[0]?.title || null;
          // Dedupe por CONTEÚDO (welcome_text + autofill + quick_reply): Meta reusa
          // template_id pra variações; queremos cada variação distinta.
          const key = `${text}::${autofill}::${qrTitle || ""}`;
          if (!seen.has(key) && (text || autofill || tplId !== "inline")) {
            seen.set(key, {
              key,
              template_id: tplId,
              welcome_text: text,
              autofill,
              quick_reply: qrTitle,
              sample_ad_name: (cr.name || "").substring(0, 80),
              raw_json: pwm,
            });
          }
        } catch {
          parseErrors++;
          if (!errorSample) errorSample = "page_welcome_message inválido (JSON)";
        }
        if (scannedCreatives >= max_creatives) break;
      }
      nextUrl = data?.paging?.next || null;
    }

    const templates = Array.from(seen.values());
    const cappedWithMore = scannedCreatives >= max_creatives && !!nextUrl;
    const error_summary = listError
      ? `Parcial: erro ao paginar criativos após ${scannedCreatives} varridos. Sample: ${listError}`
      : cappedWithMore
        ? `Limite de ${max_creatives} criativos varridos atingido — pode haver mais modelos além disso.`
        : null;

    return new Response(JSON.stringify({
      templates,
      scanned_creatives: scannedCreatives,
      scanned_adsets: scannedCreatives, // compat com log do frontend (scanned=...)
      errors_during_scan: parseErrors,
      error_sample: errorSample,
      error_summary,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
