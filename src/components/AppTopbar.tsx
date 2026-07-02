import { Link } from "react-router-dom";
import { LogOut, User, Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";

export default function AppTopbar() {
  const { user, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="border-b border-border/40 bg-background/85 backdrop-blur-xl sticky top-0 z-40">
      <div className="px-4 h-16 flex items-center justify-between gap-4">

        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Link to="/" className="md:hidden flex items-center shrink-0 group">
            <img src="/logo.png" alt="F3F ADS" className="h-8 w-auto transition-transform group-hover:scale-105" />
          </Link>
        </div>

        <div className="flex items-center gap-1.5">
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
