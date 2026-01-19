// src/Topbar.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  PanelLeft,
  PanelRight,
  UserCircle,
  LogOut,
  Inbox,
  ArrowLeftRight,
} from "lucide-react";

import {
  setActiveRole,
  userHasRole,
  listNotifications,
  markNotificationsSeen,
  type AppNotification,
} from "@/api";

// helpers for notifications
const timeAgo = (d: Date) => {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24);
  return `${dd}d ago`;
};

type NotifUI = {
  notif_id: string;
  title: string;
  details: string;
  created_at: Date;
  seen: boolean;
  meta?: { route?: string; fs_id?: string; kind?: string };
};

const getSessionUserId = () => {
  try {
    const u = JSON.parse(localStorage.getItem("animo.user") || "null");
    return u?.userId || "";
  } catch {
    return "";
  }
};

export type TopbarProps = {
  open: boolean;
  onToggleSidebar?: () => void;
  profileName?: string;
  profileSubtitle?: string;
  inboxPath?: string;
};

export default function Topbar({
  open,
  onToggleSidebar,
  profileName = "",
  profileSubtitle = "",
  inboxPath,
}: TopbarProps) {
  /**
   * Layering constants (kept centralized to avoid "magic numbers" scattered around).
   * - Topbar must sit above page content.
   * - Dropdown must sit above everything (including tables/tooltips inside scroll containers).
   */
  const Z = useMemo(
    () => ({
      topbar: "z-50",
      dropdown: "z-[3000]",
    }),
    []
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const computeMenuPos = () => {
    const btn = menuBtnRef.current;
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const top = r.bottom + 8; // matches `mt-2`
    // Right-align to the trigger button.
    const right = Math.max(8, Math.round(window.innerWidth - r.right));
    return { top, right };
  };

  const toggleMenu = () => {
    setMenuOpen((v) => {
      const next = !v;
      if (next) setMenuPos(computeMenuPos());
      return next;
    });
  };

  // ----------------------
  // Role switch (Chair <-> Faculty) placed inside "My Account"
  // ----------------------
  const pathname =
    typeof window !== "undefined" && window.location?.pathname ? window.location.pathname : "";
  const onChair = pathname.startsWith("/chair");
  const onFaculty = pathname.startsWith("/faculty");

  const canSwitchToFaculty = userHasRole("faculty");
  const canSwitchToChair = userHasRole("chair");

  const showSwitchItem = (onChair && canSwitchToFaculty) || (onFaculty && canSwitchToChair);
  const switchLabel = onChair ? "Switch to Faculty View" : "Back to Chair View";

  const handleSwitchView = () => {
    setMenuOpen(false);
    if (onChair) {
      setActiveRole("faculty");
      navigate("/faculty/overview");
      return;
    }
    // default: go back to chair
    setActiveRole("chair");
    navigate("/chair/plantilla");
  };

  // notifications dropdown state
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotifUI[]>([]);
  const notifRef = useRef<HTMLDivElement>(null);

  const refreshNotifs = async () => {
    const uid = getSessionUserId();
    if (!uid) return;

    const res = await listNotifications(uid, 25);
    const rows = (res?.rows || []).map((n: AppNotification): NotifUI => ({
      notif_id: n.notif_id,
      title: n.title,
      details: n.details,
      created_at: new Date(n.created_at),
      seen: !!n.seen,
      meta: n.meta,
    }));

    setNotifications(rows);
  };

  // Poll notifications so the bell reflects changes even if user stays on a page.
  useEffect(() => {
    refreshNotifs().catch(() => {});
    const t = window.setInterval(() => refreshNotifs().catch(() => {}), 20000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasUnseen = notifications.some((n) => !n.seen);
  const sortedNotifs = [...notifications].sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime()
  );

  const handleToggleNotif = async () => {
    const nextOpen = !notifOpen;
    setNotifOpen(nextOpen);

    // mark all as seen when opening
    if (nextOpen) {
      const uid = getSessionUserId();
      if (uid) {
        await markNotificationsSeen(uid, { all: true }).catch(() => {});
      }
      setNotifications((prev) => prev.map((n) => ({ ...n, seen: true })));
    }
  };

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
      if (!notifRef.current?.contains(e.target as Node)) setNotifOpen(false);
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, []);

  // Keep the profile dropdown anchored to the trigger even when the page scrolls or resizes.
  useEffect(() => {
    if (!menuOpen) return;

    const update = () => setMenuPos(computeMenuPos());

    update();
    window.addEventListener("resize", update);
    // capture=true so we also react to scrolls on nested overflow containers (<main overflow-auto>, etc.)
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [menuOpen]);

  const logout = () => {
    localStorage.removeItem("authToken");
    sessionStorage.clear();
    navigate("/login");
  };

  // Where the Inbox button should navigate if no explicit inboxPath is passed
  const inferredInboxPath =
    typeof window !== "undefined" && window.location.pathname.startsWith("/chair")
      ? "/chair/inbox"
      : profileSubtitle?.toLowerCase().includes("office manager")
        ? "/om/home/inbox"
        : "/faculty/inbox";

  return (
    <header className={`sticky top-0 ${Z.topbar} bg-white shadow-sm`}>
      <div className="flex h-14 w-full items-center justify-between px-3 sm:px-5 text-gray-800 border-b border-black">
        <button
          aria-label="Toggle sidebar"
          onClick={onToggleSidebar}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white hover:bg-gray-50 transition"
        >
          {open ? <PanelLeft size={18} /> : <PanelRight size={18} />}
        </button>

        <div className="flex items-center gap-1">
          {/* Inbox */}
          <button
            className="rounded-md p-2 hover:bg-gray-100 transition"
            title="Messages"
            onClick={() =>
              navigate(inboxPath || inferredInboxPath, {
                state: { from: location.pathname },
              })
            }
          >
            <Inbox size={18} />
          </button>

          {/* Notifications */}
          <div className="relative" ref={notifRef}>
            <button
              onClick={handleToggleNotif}
              className="relative rounded-md p-2 hover:bg-gray-100 transition"
              title="Notifications"
            >
              <Bell size={18} />
              {hasUnseen && (
                <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-red-500 ring-2 ring-white" />
              )}
            </button>

            {notifOpen && (
              <div
                className={`fixed top-16 right-6 w-96 rounded-xl border border-neutral-200 bg-white text-slate-800 shadow-2xl ${Z.dropdown}`}
              >
                <div className="border-b border-neutral-200 px-4 py-3 font-semibold text-emerald-700">
                  Notifications
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {sortedNotifs.length ? (
                    sortedNotifs.map((n) => (
                      <div
                        key={n.notif_id}
                        className="border-b border-neutral-100 px-4 py-3 last:border-0"
                      >
                        <div className="font-semibold text-slate-900">{n.title}</div>
                        <div className="text-sm text-gray-600">{n.details}</div>
                        <div className="mt-1 text-xs text-gray-400">{timeAgo(n.created_at)}</div>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-sm text-gray-500">No notifications</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Profile menu */}
          <div ref={menuRef} className="relative ml-2">
            <button
              ref={menuBtnRef}
              onClick={toggleMenu}
              className="group flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-gray-50 transition"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100">
                <UserCircle className="h-5 w-5 text-emerald-700" />
              </span>
              <span className="hidden sm:block leading-tight text-left">
                <div className="text-[15px] font-semibold text-gray-900">{profileName}</div>
                <div className="text-[12px] text-gray-500">{profileSubtitle}</div>
              </span>
            </button>

            {menuOpen && (
              <div
                className={`fixed w-56 rounded-2xl border border-gray-200 bg-white text-slate-800 shadow-2xl ${Z.dropdown}`}
                style={menuPos ? { top: menuPos.top, right: menuPos.right } : undefined}
                role="menu"
              >
                <div className="px-4 pb-2 pt-3 text-[15px] font-semibold text-emerald-700">
                  My Account
                </div>
                <div className="mx-4 h-px bg-neutral-200" />

                {showSwitchItem && (
                  <button
                    onClick={handleSwitchView}
                    className="flex w-full items-center gap-2 px-4 py-3 text-left text-[15px] text-gray-800 hover:bg-gray-50"
                  >
                    <ArrowLeftRight className="h-4 w-4" />
                    <span>{switchLabel}</span>
                  </button>
                )}

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    logout();
                  }}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left text-[15px] text-gray-800 hover:bg-gray-50"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
