import { Link, useLocation } from "react-router-dom";
import { Settings, LogOut, User, Sun, Moon, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useEffect, useState } from "react";
import { fetchMetaStatus } from "@/lib/meta-api";
import { isCurrentUserAdmin } from "@/lib/admin";

function MetaStatusDot() {
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    const cached = sessionStorage.getItem("meta_status_cache");
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        const age = Date.now() - (parsed._cachedAt || 0);
        if (age < 5 * 60 * 1000) {
          setConnected(!!parsed.connected);
          return;
        }
      } catch { /* ignore */ }
    }
    fetchMetaStatus()
      .then((s) => setConnected(!!s.connected))
      .catch(() => setConnected(false));
  }, []);

  if (connected === null) return null;

  return (
    <span
      title={connected ? "Meta conectado" : "Meta desconectado"}
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
        connected ? "bg-success animate-pulse-glow" : "bg-destructive"
      }`}
    />
  );
}

export default function Header() {
  const location = useLocation();
  const { user, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    isCurrentUserAdmin().then(setIsAdmin).catch(() => setIsAdmin(false));
  }, [user]);

  return (
    <header className="border-b border-border/40 bg-background/85 backdrop-blur-xl sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-4">

        {/* Brand */}
        <Link to="/" className="flex items-center shrink-0 group">
          <img src="/logo.png" alt="F3F ADS" className="h-7 w-auto transition-transform group-hover:scale-105" />
        </Link>

        {/* Right cluster */}
        <div className="flex items-center gap-1.5">
          <nav className="flex gap-1 mr-1">
            <Link to="/">
              <Button
                variant={location.pathname === "/" ? "secondary" : "ghost"}
                size="sm"
                className="text-sm h-9 px-3.5 font-medium"
              >
                Publicar
              </Button>
            </Link>
            <Link to="/settings">
              <Button
                variant={location.pathname === "/settings" ? "secondary" : "ghost"}
                size="sm"
                className="text-sm h-9 px-3.5 gap-1.5 font-medium"
              >
                <MetaStatusDot />
                <Settings className="w-3.5 h-3.5" />
                Config
              </Button>
            </Link>
            {isAdmin && (
              <Link to="/admin">
                <Button
                  variant={location.pathname === "/admin" ? "secondary" : "ghost"}
                  size="sm"
                  className="text-sm h-9 px-3.5 gap-1.5 font-medium"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Admin
                </Button>
              </Link>
            )}
          </nav>

          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
            title={theme === "light" ? "Modo escuro" : "Modo claro"}
          >
            {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </Button>

          {user && (
            <div className="flex items-center gap-1.5 pl-2 ml-1 border-l border-border/50">
              <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground px-1">
                <User className="w-3.5 h-3.5" />
                <span className="max-w-[140px] truncate">{user.email}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={signOut}
                className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                title="Sair"
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
