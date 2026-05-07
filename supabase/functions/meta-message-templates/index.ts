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

    const adsetsRes = await fetch(
      `https://graph.facebook.com/v25.0/${ad_account_id}/adsets?fields=id,destination_type&limit=300&access_token=${access_token}`,
    );
    const adsetsData = await adsetsRes.json();
    if (adsetsData.error) {
      return new Response(JSON.stringify({ error: adsetsData.error.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ctwAdsets = (adsetsData.data || [])
      .filter((a: any) => a.destination_type === "WHATSAPP")
      .slice(0, max_adsets);

    const seen = new Map<string, TemplateRow>();

    // Busca em paralelo (chunks de 8 pra não passar do rate limit)
    const chunkSize = 8;
    for (let i = 0; i < ctwAdsets.length; i += chunkSize) {
      const chunk = ctwAdsets.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (aset: any) => {
        const adsRes = await fetch(
          `https://graph.facebook.com/v25.0/${aset.id}/ads?fields=creative{name,object_story_spec{video_data{page_welcome_message},link_data{page_welcome_message}},page_welcome_message}&limit=2&access_token=${access_token}`,
        );
        const adsData = await adsRes.json();
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
            const key = `${text}::${autofill}::${qrTitle || ""}`;
            if (!seen.has(key) && (text || autofill)) {
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
    return new Response(JSON.stringify({ templates, scanned_adsets: ctwAdsets.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
