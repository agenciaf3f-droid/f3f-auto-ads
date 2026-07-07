import { useAuth } from "@/contexts/AuthContext";
import LoginPage from "@/pages/LoginPage";
import FirstLoginPassword from "@/pages/FirstLoginPassword";
import { Loader2 } from "lucide-react";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  // Gestor convidado com senha provisória: força criar nova senha antes de usar o app.
  if (user.user_metadata?.must_change_password) return <FirstLoginPassword />;

  return <>{children}</>;
}
