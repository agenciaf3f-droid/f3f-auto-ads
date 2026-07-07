import { supabase } from "@/integrations/supabase/client";

// Retorna true se o usuário logado está em public.app_admins.
// RLS garante que SELECT só retorna a linha do próprio user — então a presença da linha já é o teste.
export async function isCurrentUserAdmin(): Promise<boolean> {
  const { data, error } = await supabase
    .from("app_admins")
    .select("user_id")
    .maybeSingle();
  if (error) return false;
  return !!data;
}

export async function inviteUser(email: string, name: string) {
  const { data, error } = await supabase.functions.invoke("admin-invite-user", {
    body: { email, name },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data as { ok: true; user_id: string };
}

export type AppUser = {
  id: string;
  email: string | null;
  name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  is_admin: boolean;
};

// Lista os gestores (membros) do app. Só admin (gate na edge).
export async function listAppUsers(): Promise<AppUser[]> {
  const { data, error } = await supabase.functions.invoke("admin-list-users", { body: {} });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return (data?.users ?? []) as AppUser[];
}

// Remove um gestor (apaga do Auth). Só admin; a edge barra auto-remoção.
export async function removeAppUser(userId: string) {
  const { data, error } = await supabase.functions.invoke("admin-remove-user", {
    body: { user_id: userId },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data as { ok: true };
}
