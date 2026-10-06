import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  CreditCard,
  FolderKanban,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Menu,
  Mic,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  X,
  Activity,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { LogoMark } from "../Logo";
import { useAuth } from "../../store/auth";
import { avatarColorClass, useLocalProfile } from "../../store/profile";
import { initials } from "../../lib/format";
import { Dropdown } from "../ui/Dropdown";
import { toast } from "../../store/toast";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: string | ReactNode;
  end?: boolean;
}

const workspaceNav: NavItem[] = [
  { to: "/dashboard", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" />, end: true },
  { to: "/agent", label: "Command Center", icon: <Bot className="h-4 w-4" />, badge: "Live" },
  // Drop in any file and talk to Gemini about it — chats and notebooks.
  { to: "/chat", label: "Chat & Files", icon: <Sparkles className="h-4 w-4" /> },
  { to: "/projects", label: "Projects", icon: <FolderKanban className="h-4 w-4" /> },
  { to: "/voices", label: "Voice Library", icon: <Mic className="h-4 w-4" /> },
];

// The agent is the only thing in the app that makes videos.
const createNav: NavItem[] = [{ to: "/agent?tab=generator", label: "Generate Short", icon: <Sparkles className="h-4 w-4" /> }];

const manageNav: NavItem[] = [
  { to: "/agent?tab=activity", label: "Activity", icon: <Activity className="h-4 w-4" /> },
  { to: "/settings", label: "Settings", icon: <SettingsIcon className="h-4 w-4" /> },
  { to: "/help", label: "Help & Docs", icon: <HelpCircle className="h-4 w-4" /> },
];

/** "Minimize the sidebar": the rail, remembered between windows and restarts. */
export const SIDEBAR_COLLAPSED_KEY = "soundwave_sidebar_collapsed";

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const user = auth.user;
  const signOut = auth.signOut;
  const profile = useLocalProfile();
  // The account's name wins when there is a session; otherwise this PC's saved
  // profile names the workspace (both are set on the Profile page).
  const displayName = (user?.name || profile.name || "Creator Workspace").trim();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  // The narrow rail state. Only the desktop sidebar collapses — the phone-sized
  // drawer is already out of the way.
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);

  const toggleCollapsed = () => {
    setCollapsed((was) => {
      const next = !was;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch {}
    void navigate("/agent");
    toast.info("Signed out", "You have been signed out of Soundwave AI.");
  };

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!search.trim()) return;
    void navigate(`/projects?q=${encodeURIComponent(search.trim())}`);
  };

  // Compute clean breadcrumbs
  const getBreadcrumb = () => {
    const path = location.pathname;
    if (path.startsWith("/agent")) return { section: "Workspace", current: "Command Center" };
    if (path.startsWith("/dashboard")) return { section: "Workspace", current: "Overview" };
    if (path.startsWith("/projects")) return { section: "Workspace", current: "Projects" };
    if (path.startsWith("/voices")) return { section: "Workspace", current: "Voice Library" };
    if (path.startsWith("/profile")) return { section: "Account", current: "Profile" };
    if (path.startsWith("/settings")) return { section: "Manage", current: "Settings" };
    if (path.startsWith("/help")) return { section: "Manage", current: "Help & Support" };
    return { section: "Workspace", current: "Command Center" };
  };

  const breadcrumb = getBreadcrumb();
  // The Command Center fills exactly one window on desktop-sized screens: the
  // page itself never scrolls (its left column and chat scroll on their own).
  const isCommandCenter = location.pathname.startsWith("/agent");

  /**
   * The sidebar. `rail` is the minimized form: a 4rem column with the icons and
   * nothing else — the same buttons, reachable, with the labels as tooltips.
   */
  const renderSidebar = (rail: boolean) => (
    <div
      className="flex h-full flex-col bg-[#08080A] text-gray-300 select-none"
      data-testid="sidebar"
      data-collapsed={rail ? "true" : "false"}
    >
      {/* Workspace Brand Switcher */}
      <div className={cn("flex h-14 items-center border-b border-white/[0.06]", rail ? "justify-center px-1" : "justify-between px-3.5")}>
        <NavLink to="/agent" className="flex items-center gap-2.5 group" title="Soundwave AI — Command Center">
          <LogoMark className="h-7 w-7" />
          {!rail && (
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-white tracking-tight group-hover:text-blue-400 transition-colors">
                Soundwave <span className="text-blue-400">AI</span>
              </span>
            </div>
          )}
        </NavLink>
        {!rail && (
          <>
            {/* Minimize: the narrow rail (remembered between restarts). */}
            <button
              className="hidden h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.06] hover:text-white lg:flex transition-colors"
              onClick={toggleCollapsed}
              aria-label="Minimize the sidebar"
              aria-expanded={!collapsed}
              title="Minimize the sidebar"
              data-testid="sidebar-toggle"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.06] hover:text-white lg:hidden transition-colors"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
      {rail && (
        <div className="flex justify-center pt-2">
          <button
            className="flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.1] bg-[#131419] text-gray-400 transition-colors hover:text-white"
            onClick={toggleCollapsed}
            aria-label="Expand the sidebar"
            aria-expanded={!collapsed}
            title="Expand the sidebar"
            data-testid="sidebar-toggle"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Global Quick Search Input in Sidebar (hidden in the rail — no room for it) */}
      {!rail && (
        <div className="px-3 pt-3">
          <form onSubmit={onSearch} className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="w-full rounded-lg border border-white/[0.07] bg-white/[0.03] py-1.5 pl-8 pr-2.5 text-xs text-white placeholder-gray-400 transition-colors hover:border-white/[0.12] focus:border-blue-500 focus:outline-none"
            />
          </form>
        </div>
      )}

      {/* Grouped Navigation */}
      <nav className={cn("flex-1 overflow-y-auto py-3 space-y-4", rail ? "px-2" : "px-2.5")} aria-label="Main navigation">
        {(
          [
            ["Workspace", workspaceNav],
            ["Create", createNav],
            ["Manage", manageNav],
          ] as Array<[string, NavItem[]]>
        ).map(([title, items]) => (
          <div key={title}>
            {!rail && (
              <div
                className="px-2.5 pb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase"
                data-testid={`sidebar-group-${title.toLowerCase()}`}
              >
                {title}
              </div>
            )}
            <div className="space-y-0.5">
              {items.map((item) => (
                <SidebarNavLink key={item.to} item={item} rail={rail} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Workspace System Status Pill */}
      <div className={cn("pb-2", rail ? "px-2" : "px-3")}>
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-xs text-gray-400",
            rail && "justify-center px-0",
          )}
          title="Soundwave is online"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          {!rail && <span className="truncate">Online</span>}
        </div>
      </div>

      {/* Bottom User Area — the profile banner. Clicking the name/avatar opens
          the Profile page (real content: name, avatar, plan, today's ideas);
          the chevron opens the quick menu. In the rail there is no room for a
          chevron, so the avatar itself is the Profile link. */}
      <div className="border-t border-white/[0.06] p-2.5">
        <div className={cn("flex items-center gap-1", rail && "flex-col")}>
          <NavLink
            to="/profile"
            title={rail ? `${displayName} — Profile` : "Open your profile"}
            aria-label={`Open your profile (${displayName})`}
            data-testid="profile-banner"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-white/[0.05]",
              rail && "justify-center",
            )}
          >
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white",
                avatarColorClass(profile.color),
              )}
            >
              {initials(displayName)}
            </span>
            {!rail && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-white">{displayName}</p>
                <p className="truncate text-[11px] text-gray-400">{user ? `${user.plan} Plan` : "Local workspace"}</p>
              </div>
            )}
          </NavLink>
          {!rail && (
            <Dropdown
              align="right"
              label="Account options"
              trigger={
                <button
                  className="flex h-8 w-6 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-white/[0.06] hover:text-white"
                  aria-label="Account options"
                  title="Account options"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              }
              items={[
                { key: "profile", label: "Profile", icon: <CircleUserRound className="h-4 w-4" />, onClick: () => navigate("/profile") },
                {
                  key: "billing",
                  label: "Plan & Billing",
                  icon: <CreditCard className="h-4 w-4" />,
                  onClick: () => navigate("/settings/billing"),
                },
                { key: "settings", label: "Settings", icon: <SettingsIcon className="h-4 w-4" />, onClick: () => navigate("/settings") },
                ...(user
                  ? [{ key: "logout", label: "Sign out", icon: <LogOut className="h-4 w-4" />, danger: true, onClick: handleSignOut }]
                  : [{ key: "help", label: "Help & Docs", icon: <HelpCircle className="h-4 w-4" />, onClick: () => navigate("/help") }]),
              ]}
            />
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        "min-h-screen bg-[#000000] text-gray-100 flex flex-col",
        isCommandCenter && "lg:h-screen lg:min-h-0 lg:overflow-hidden",
      )}
    >
      {/* Desktop sidebar — 15rem, or the 4rem rail when minimized */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-20 hidden border-r border-white/[0.06] bg-[#08080A] transition-[width] duration-200 lg:block",
          collapsed ? "w-16" : "w-60",
        )}
        data-testid="desktop-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
      >
        {renderSidebar(collapsed)}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-30 bg-black/70 backdrop-blur-xs lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-30 w-64 bg-[#08080A] border-r border-white/[0.08] lg:hidden"
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ type: "tween", duration: 0.2 }}
            >
              {renderSidebar(false)}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main column */}
      <div
        className={cn(
          "flex flex-1 flex-col transition-[padding] duration-200",
          collapsed ? "lg:pl-16" : "lg:pl-60",
          isCommandCenter && "lg:min-h-0",
        )}
      >
        {/* Header Bar */}
        <header className="sticky top-0 z-10 h-14 shrink-0 border-b border-white/[0.06] bg-[#000000]/90 backdrop-blur-md">
          <div className="flex h-full items-center justify-between px-4 sm:px-6">
            {/* Left: Mobile trigger & Breadcrumbs */}
            <div className="flex items-center gap-3">
              <button
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.06] hover:text-white lg:hidden transition-colors"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation menu"
              >
                <Menu className="h-4 w-4" />
              </button>

              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-gray-400">{breadcrumb.section}</span>
                <span className="text-gray-400">/</span>
                <span className="font-medium text-white">{breadcrumb.current}</span>
              </div>
            </div>

            {/* Right: Quick actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate("/help")}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.06] hover:text-white transition-colors"
                aria-label="Help"
                title="Help & Documentation"
              >
                <HelpCircle className="h-4 w-4" />
              </button>

              <button
                onClick={() => navigate("/settings")}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.06] hover:text-white transition-colors"
                aria-label="Settings"
                title="Workspace Settings"
              >
                <SettingsIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Content Area */}
        <main
          className={cn(
            "flex-1 w-full mx-auto",
            isCommandCenter
              ? "max-w-none px-2 sm:px-4 py-3 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden lg:[&>*]:flex-1"
              : "max-w-7xl px-4 py-6 sm:px-6 lg:px-8",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarNavLink({ item, rail = false }: { item: NavItem; rail?: boolean }) {
  const location = useLocation();
  const currentPathWithSearch = location.pathname + location.search;
  const isMatch = item.to.includes("?") ? currentPathWithSearch === item.to : location.pathname === item.to;

  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={cn(
        "flex items-center rounded-lg py-1.5 text-xs font-medium transition-colors",
        rail ? "justify-center px-0" : "justify-between px-2.5",
        isMatch ? "bg-white/[0.08] text-white" : "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200",
      )}
      // The rail hides the labels: the name has to be findable another way.
      title={rail ? item.label : undefined}
      aria-label={rail ? item.label : undefined}
      data-testid={rail ? "sidebar-rail-link" : undefined}
    >
      <div className={cn("flex items-center truncate", rail ? "" : "gap-2.5")}>
        <span className={cn(isMatch ? "text-blue-400" : "text-gray-400")}>{item.icon}</span>
        {!rail && <span className="truncate">{item.label}</span>}
      </div>
      {!rail && item.badge && (
        <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-400">{item.badge}</span>
      )}
    </NavLink>
  );
}
