import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Megaphone, Users, Settings } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { fetchMetaStatus } from "@/lib/meta-api";

type NavItem = {
  label: string;
  to: string;
  icon: typeof Megaphone;
};

const NAV_ITEMS: NavItem[] = [
  { label: "Campanhas", to: "/", icon: Megaphone },
  { label: "Clientes", to: "/clientes", icon: Users },
  { label: "Config", to: "/settings", icon: Settings },
];

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
      className={`inline-block w-2 h-2 rounded-full shrink-0 ml-auto ${
        connected ? "bg-success animate-pulse-glow" : "bg-destructive"
      }`}
    />
  );
}

export default function AppSidebar() {
  const location = useLocation();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link to="/" className="flex items-center px-2 py-1.5 group">
          <img src="/logo.png" alt="F3F ADS" className="h-7 w-auto transition-transform group-hover:scale-105" />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {NAV_ITEMS.map((item) => {
              const isActive = location.pathname === item.to;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    tooltip={item.label}
                    className="data-[active=true]:border-l-2 data-[active=true]:border-sidebar-primary data-[active=true]:bg-sidebar-primary/10 data-[active=true]:text-sidebar-primary"
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
                      {item.to === "/settings" && <MetaStatusDot />}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
