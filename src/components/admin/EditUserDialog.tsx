import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { updateAppUser, type AppUser } from "@/lib/admin";

// Modal de edição de gestor (admin). Email é somente-leitura — trocar de email não é suportado
// aqui (mudaria a identidade do login central F3F). Senha é opcional: em branco = não altera.
export default function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AppUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user: currentUser } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const isSelf = !!user && user.id === currentUser?.id;

  useEffect(() => {
    if (!user) return;
    setName(user.name || "");
    setPassword("");
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    if (name.trim().length < 2) {
      toast.error("Nome precisa ter pelo menos 2 caracteres");
      return;
    }
    if (password && password.length < 8) {
      toast.error("A senha precisa ter pelo menos 8 caracteres");
      return;
    }
    setSaving(true);
    try {
      const result = await updateAppUser({
        user_id: user.id,
        name: name.trim(),
        password: password || undefined,
      });
      // `warning` vem primeiro: a edge o usa também pra falha na revogação de sessão, que
      // NÃO mexe em central_synced. Sem checar aqui, um reset em que a sessão não caiu
      // apareceria como sucesso puro e o admin acharia que deslogou o gestor.
      if (result.warning) {
        toast.warning(result.warning);
      } else if (result.central_synced === false) {
        toast.warning("Salvo, mas a senha não propagou para os outros sistemas F3F. Avise o admin.");
      } else {
        toast.success("Gestor atualizado");
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erro ao atualizar gestor");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Editar gestor</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          <div className="space-y-1.5">
            <Label htmlFor="edit-user-email">Email</Label>
            <Input id="edit-user-email" value={user?.email || ""} disabled />
            <p className="text-xs text-muted-foreground">O email não pode ser alterado por aqui.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-user-name">Nome</Label>
            <Input
              id="edit-user-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Maria Silva"
              minLength={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-user-password">Nova senha</Label>
            <Input
              id="edit-user-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Deixe em branco para não alterar"
              minLength={8}
            />
            <p className="text-xs text-muted-foreground">
              Mínimo 8 caracteres. Ao trocar a senha, as sessões são encerradas — o acesso
              antigo cai em até 1 hora (quando o token atual expirar).
            </p>
            {isSelf && password && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                Esta é a sua própria conta: trocar a senha aqui vai encerrar a sua sessão também.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
