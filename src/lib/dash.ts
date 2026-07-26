import { supabase } from "@/integrations/supabase/client";

// CRUD fino sobre a tabela `dash` (aba Dash — conteúdo IG por cliente, teste rápido). Mesmo
// estilo de src/lib/clients.ts.

export interface DashItem {
  id: string;
  user_id: string;
  client_id: string;
  ig_media_id: string;
  media_type: string | null;
  media_product_type: string | null;
  posted_at: string | null;
  like_count: number | null;
  comments_count: number | null;
  views_count: number | null;
  caption: string | null;
  permalink: string | null;
  student_name: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export async function listDashItems(clientId: string): Promise<DashItem[]> {
  const { data, error } = await supabase
    .from("dash")
    .select("*")
    .eq("client_id", clientId)
    .order("posted_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as DashItem[];
}

export async function updateStudentName(id: string, studentName: string): Promise<void> {
  const { error } = await supabase.from("dash").update({ student_name: studentName || null }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function syncDashContent(
  clientId: string,
  accessToken: string,
  igAccountId: string,
): Promise<{ ok: true; synced: number; views_rate_limited?: boolean; views_warning?: string | null }> {
  const { data, error } = await supabase.functions.invoke("meta-ig-content-sync", {
    body: { access_token: accessToken, client_id: clientId, ig_account_id: igAccountId },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data;
}
