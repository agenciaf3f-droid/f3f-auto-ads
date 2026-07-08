import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cacheDiscovery } from "../_shared/discovery-cache.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token, ad_account_id } = await req.json();

    type Audience = { id: string; name: string; type: "custom" | "saved"; targeting_spec?: any };

    // Os dois loops de paginação são independentes (cursores próprios, sem estado
    // compartilhado) → rodam em paralelo. Lista final = custom ++ saved (mesma ordem de antes).
    const fetchCustom = async (): Promise<Audience[]> => {
      const out: Audience[] = [];
      let customUrl: string | null = `https://graph.facebook.com/v25.0/${ad_account_id}/customaudiences?fields=id,name&limit=200&access_token=${access_token}`;
      while (customUrl) {
        const res = await fetch(customUrl);
        const data = await res.json();
        if (data.data) {
          for (const a of data.data) {
            out.push({ id: a.id, name: a.name, type: "custom" });
          }
        }
        customUrl = data.paging?.next || null;
      }
      return out;
    };

    const fetchSaved = async (): Promise<Audience[]> => {
      const out: Audience[] = [];
      let savedUrl: string | null = `https://graph.facebook.com/v25.0/${ad_account_id}/saved_audiences?fields=id,name,targeting&limit=200&access_token=${access_token}`;
      while (savedUrl) {
        const res = await fetch(savedUrl);
        const data = await res.json();
        if (data.data) {
          for (const a of data.data) {
            out.push({ id: a.id, name: a.name, type: "saved", targeting_spec: a.targeting || null });
          }
        }
        savedUrl = data.paging?.next || null;
      }
      return out;
    };

    const [customAudiences, savedAudiences] = await Promise.all([fetchCustom(), fetchSaved()]);
    const audiences: Audience[] = [...customAudiences, ...savedAudiences];

    // Guard non-empty: este loop não checa data.error → erro transiente da Meta vira []
    // "sucesso". Sem guard, [] clobbaria cache bom (reader do front confiaria no vazio).
    if (audiences.length) await cacheDiscovery("audiences", ad_account_id, audiences);

    return new Response(JSON.stringify({ audiences }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
