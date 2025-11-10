// src/base/Topbar.tsx
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, PanelLeft, PanelRight, UserCircle, LogOut, Inbox } from "lucide-react";

// helpers for notifications
type Notification = { id: number; title: string; details: string; time: Date; seen?: boolean };
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

// Chair-context sample data (Dean style, Chair content)
const INITIAL_NOTIFS: Notification[] = [
  {
    id: 101,
    title: "Dean requested minor revision",
    details: "Please update the CT plantilla remarks for CCAPDEV by Oct 15.",
    time: new Date(Date.now() - 2 * 60 * 1000),
    seen: false,
  },
  {
    id: 102,
    title: "Section clash flagged",
    details: "CCPROG3 S12 and S14 overlap on Monday 9:15–10:45. Review schedule.",
    time: new Date(Date.now() - 20 * 60 * 1000),
    seen: false,
  },
  {
    id: 103,
    title: "Office Manager posted an update",
    details: "New template for AY 2025–2026 is now required for all uploads.",
    time: new Date(Date.now() - 60 * 60 * 1000),
    seen: false,
  },
];

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
  profileName = "Jamaecha Dacanay",
  profileSubtitle = "Office Manager | Department of Software Technology",
  inboxPath,
}: TopbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // notifications dropdown state
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>(INITIAL_NOTIFS);
  const notifRef = useRef<HTMLDivElement>(null);

  const hasUnseen = notifications.some((n) => !n.seen);
  const sortedNotifs = [...notifications].sort(
    (a, b) => b.time.getTime() - a.time.getTime()
  );

  const handleToggleNotif = () => {
    setNotifOpen((o) => !o);
    // mark all as seen when opening
    if (!notifOpen) {
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
      ? "/om/inbox"
      : "/faculty/inbox";

  return (
    <header className="sticky top-0 z-10 bg-white shadow-sm">
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
            onClick={() => navigate(inboxPath || inferredInboxPath)}
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
               <div className="fixed top-16 right-6 z-50 w-96 rounded-xl border border-neutral-200 bg-white text-slate-800 shadow-2xl">
                <div className="border-b border-neutral-200 px-4 py-3 font-semibold text-emerald-700">
                  Notifications
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {sortedNotifs.length ? (
                    sortedNotifs.map((n) => (
                      <div
                        key={n.id}
                        className="border-b border-neutral-100 px-4 py-3 last:border-0"
                      >
                        <div className="font-semibold text-slate-900">{n.title}</div>
                        <div className="text-sm text-gray-600">{n.details}</div>
                        <div className="mt-1 text-xs text-gray-400">{timeAgo(n.time)}</div>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-sm text-gray-500">
                      No notifications
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Profile menu */}
          <div ref={menuRef} className="relative ml-2">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="group flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-gray-50 transition"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100">
                <UserCircle className="h-5 w-5 text-emerald-700" />
              </span>
              <span className="hidden sm:block leading-tight text-left">
                <div className="text-[15px] font-semibold text-gray-900">
                  {profileName}
                </div>
                <div className="text-[12px] text-gray-500">{profileSubtitle}</div>
              </span>
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 mt-2 w-56 rounded-2xl border border-gray-200 bg-white text-slate-800 shadow-2xl z-50"
                role="menu"
              >
                <div className="px-4 pb-2 pt-3 text-[15px] font-semibold text-emerald-700">
                  My Account
                </div>
                <div className="mx-4 h-px bg-neutral-200" />
                <button
                  onClick={logout}
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
