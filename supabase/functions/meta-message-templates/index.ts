import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Lista templates "Modelo de mensagem" extraídos de creatives WHATSAPP existentes
// na conta de anúncios. Meta não expõe esses templates via API direta — a única forma
// é varrer creatives publicados que contêm o JSON `page_welcome_message` embutido.

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
    const { access_token, ad_account_id, max_adsets = 60 } = await req.json();
    if (!access_token || !ad_account_id) {
      return new Response(JSON.stringify({ error: "access_token e ad_account_id são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Paginar TODOS os adsets WHATSAPP da conta (até max_adsets)
    const ctwAdsets: any[] = [];
    let nextUrl: string | null = `https://graph.facebook.com/v25.0/${ad_account_id}/adsets?fields=id,destination_type&limit=300&access_token=${access_token}`;
    while (nextUrl && ctwAdsets.length < max_adsets) {
      const r = await fetch(nextUrl);
      const data = await r.json();
      if (data.error) {
        return new Response(JSON.stringify({ error: data.error.message }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      for (const a of (data.data || [])) {
        if (a.destination_type === "WHATSAPP") ctwAdsets.push(a);
        if (ctwAdsets.length >= max_adsets) break;
      }
      nextUrl = data?.paging?.next || null;
    }

    const seen = new Map<string, TemplateRow>();
    let errorsDuringScan = 0;
    let errorSample: string | null = null;

    // Busca em paralelo em chunks
    const chunkSize = 10;
    for (let i = 0; i < ctwAdsets.length; i += chunkSize) {
      const chunk = ctwAdsets.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (aset: any) => {
        const adsRes = await fetch(
          `https://graph.facebook.com/v25.0/${aset.id}/ads?fields=creative{name,object_story_spec{video_data{page_welcome_message},link_data{page_welcome_message}},page_welcome_message}&limit=5&access_token=${access_token}`,
        );
        const adsData = await adsRes.json();
        if (adsData?.error) {
          errorsDuringScan++;
          if (!errorSample) errorSample = `${adsData.error.code || "?"}: ${adsData.error.message || "erro desconhecido"}`;
          return;
        }
        for (const ad of (adsData?.data || [])) {
          const pwm = ad.creative?.page_welcome_message
            || ad.creative?.object_story_spec?.video_data?.page_welcome_message
            || ad.creative?.object_story_spec?.link_data?.page_welcome_message;
          if (!pwm) continue;
          try {
            const parsed = JSON.parse(pwm);
            const tplId = String(parsed.template_id || "inline");
            const text = parsed.text_format?.message?.text || parsed.image_format?.message?.text || "";
            const autofill = parsed.text_format?.message?.autofill_message?.content || "";
            const qrTitle = parsed.image_format?.message?.quick_replies?.[0]?.title || null;
            // Dedupe by template_id when present (mais confiável que por texto)
            const key = tplId !== "inline" ? `tpl:${tplId}` : `inline:${text}::${autofill}::${qrTitle || ""}`;
            if (!seen.has(key) && (text || autofill || tplId !== "inline")) {
              seen.set(key, {
                key,
                template_id: tplId,
                welcome_text: text,
                autofill,
                quick_reply: qrTitle,
                sample_ad_name: (ad.creative?.name || "").substring(0, 80),
                raw_json: pwm,
              });
            }
          } catch { /* ignore */ }
        }
      }));
    }

    const templates = Array.from(seen.values());

    // Se TODOS os fetches falharam → provável rate limit. Surfa erro claro pro frontend.
    const error_summary = (templates.length === 0 && errorsDuringScan > 0 && ctwAdsets.length > 0 && errorsDuringScan >= ctwAdsets.length)
      ? `Meta rate-limit ou erro em todas as ${ctwAdsets.length} chamadas. Sample: ${errorSample}`
      : null;

    return new Response(JSON.stringify({
      templates,
      scanned_adsets: ctwAdsets.length,
      errors_during_scan: errorsDuringScan,
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
