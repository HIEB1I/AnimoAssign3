// frontend/src/component/TopBar.tsx
import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { UserCircle, LogOut, Inbox, Bell } from "lucide-react";
import { useInboxBadge } from "@/realtime/inboxBadge";

import { logoutApi } from "../api"; 

import {
  listNotifications,
  markNotificationsSeen,
  type AppNotification,
} from "@/api";


interface TopBarProps {
  fullName: string;
  role: string;
  department?: string;
  /** If provided, clicking the Inbox icon navigates here (OM-style). */
  inboxPath?: string;
  notifications?: {
    // legacy shape (some screens used numeric ids)
    id?: number;
    // backend shape
    notif_id?: string;
    title: string;
    details: string;
    time: Date | string;
    seen?: boolean;
    meta?: { route?: string; fs_id?: string; kind?: string };
  }[];
  inboxEvent?: string;
}


type IncomingNotifs = NonNullable<TopBarProps["notifications"]>;
const EMPTY_NOTIFS: IncomingNotifs = [];

/**
 * Universal TopBar used by Admin, APO, and Faculty roles.
 * - Dynamic gradient bar and account dropdown
 * - Notifications dropdown with live "time ago"
 * - Optional department + notifications
 * - Inbox button: navigate to inboxPath if provided; otherwise dispatches inboxEvent
 */
export default function TopBar({
  fullName,
  role,
  department,
  notifications: incomingNotifsProp,
  inboxEvent = "faculty:openInbox",
  inboxPath,
}: TopBarProps) {
  const navigate = useNavigate();
  const { unreadTotal } = useInboxBadge();
  const hasInboxUnread = unreadTotal > 0;

  // Show faculty-only account items strictly when the *user role* is Faculty.
  // (Route checks alone are not enough because TopBar is reused across roles.)
  const isFacultyRole = String(role || "")
    .trim()
    .toLowerCase()
    .startsWith("faculty");

  const isFacultyRoute =
    typeof window !== "undefined" && window.location.pathname.startsWith("/faculty");

  const incomingNotifs: IncomingNotifs = incomingNotifsProp ?? EMPTY_NOTIFS;



  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  // Session user id (support multiple shapes across roles/versions)
  // IMPORTANT: Do not memoize this once. In this app, the active user can change
  // without a full page reload (e.g., role switching, re-login). Memoizing can
  // freeze the user id at "" and prevent in-app notifications from loading.
  const readSessionUserId = () => {
    try {
      const raw = localStorage.getItem("animo.user");
      const u = raw ? JSON.parse(raw) : null;
      return String(u?.userId || u?.user_id || u?.id || u?._id || "").trim();
    } catch {
      return "";
    }
  };

  const [sessionUserId, setSessionUserId] = useState<string>(() => readSessionUserId());

  // Keep in sync across in-app role switching / login changes.
  useEffect(() => {
    const sync = () => setSessionUserId(readSessionUserId());
    sync();

    // Listen to storage changes from other tabs/windows.
    const onStorage = (e: StorageEvent) => {
      if (e.key === "animo.user") sync();
    };
    window.addEventListener("storage", onStorage);

    // Safety net for same-tab updates (no 'storage' event): poll lightly.
    const t = window.setInterval(() => {
      const next = readSessionUserId();
      setSessionUserId((prev) => (prev === next ? prev : next));
    }, 2000);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(t);
    };
  }, []);
  const toDateSafe = (v: any): Date | null => {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  };

  const pickNotifTime = (n: any): Date | null => {
    return (
      toDateSafe(n?.time) ||
      toDateSafe(n?.created_at) ||
      toDateSafe(n?.createdAt) ||
      toDateSafe(n?.created)
    );
  };

  type NotifUI = {
    id: string;
    title: string;
    details: string;
    time: Date;
    seen: boolean;
    meta?: { route?: string; fs_id?: string; kind?: string };
  };

  const [notifications, setNotifications] = useState<NotifUI[]>(() => {
    // If a screen passes notifications explicitly, keep that behavior.
    if (incomingNotifsProp?.length) {
      return (incomingNotifsProp || EMPTY_NOTIFS).map((n: any) => ({
        id: String(n?.notif_id || n?.id || Math.random()),
        title: String(n?.title || ""),
        details: String(n?.details || ""),
        time: pickNotifTime(n) || new Date(),
        seen: !!n?.seen,
        meta: n?.meta,
      }));
    }

    // Otherwise: default to empty; we'll load from the backend when logged in.
    return [];
  });

  // Keep state in sync when a screen provides notifications explicitly
  useEffect(() => {
    if (!incomingNotifsProp) return;
    setNotifications(
      incomingNotifsProp.length
        ? incomingNotifsProp.map((n: any) => ({
            id: String(n?.notif_id || n?.id || Math.random()),
            title: String(n?.title || ""),
            details: String(n?.details || ""),
            time: pickNotifTime(n) || new Date(),
            seen: !!n?.seen,
            meta: n?.meta,
          }))
        : []
    );
  }, [incomingNotifsProp]);

  const refreshNotifs = async () => {
    // Only auto-fetch when the page didn't supply notifications.
    if (incomingNotifsProp?.length) return;
    const uid = sessionUserId || readSessionUserId();
    if (!uid) return;

    const res = await listNotifications(uid, 25);
    const rows = (res?.rows || []).map((n: AppNotification): NotifUI => ({
      id: String(n.notif_id),
      title: n.title,
      details: n.details,
      time: pickNotifTime(n) || new Date(),
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

  const notifRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Click-outside behavior
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Track header height for sticky tab offset
  useEffect(() => {
    if (!headerRef.current) return;
    const el = headerRef.current;
    const setVar = () =>
      document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    setVar();
    const ro = new ResizeObserver(setVar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Logout
const logout = async () => {
  await logoutApi(); // <-- NEW: clear cookie session on server
  localStorage.removeItem("authToken");
  sessionStorage.clear();
  navigate("/login");
};

  // “x minutes ago” helper
  const timeAgo = (d: Date) => {
    if (!d || !Number.isFinite(d.getTime())) return "";
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (!Number.isFinite(s) || s < 0) return "";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} minute${m > 1 ? "s" : ""} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
    const dd = Math.floor(h / 24);
    return `${dd} day${dd > 1 ? "s" : ""} ago`;
  };

  // Notification logic
  const hasUnseen = notifications.some((n) => !n.seen);
  const sortedNotifs = [...notifications]
    .sort((a, b) => {
      const ta = (a.time as Date)?.getTime?.() ?? 0;
      const tb = (b.time as Date)?.getTime?.() ?? 0;
      return ta - tb;
    })
    .reverse();

  const toggleNotif = async () => {
    const nextOpen = !notifOpen;
    setNotifOpen(nextOpen);

    // Mark all as seen when opening.
    if (nextOpen) {
      // Refresh first so newly-created notifications appear immediately.
      await refreshNotifs().catch(() => {});

      // Only call backend when we're using the backend-driven notifications.
      const uid = sessionUserId || readSessionUserId();
      if (!incomingNotifs.length && uid) {
        await markNotificationsSeen(uid, { all: true }).catch(() => {});
      }
      setNotifications((n) => n.map((x) => ({ ...x, seen: true })));
    }
  };

  // Inbox click:
  // - If inboxPath provided -> navigate (route-style inbox)
  // - Else -> dispatch existing custom event (embedded inbox inside current page)
  const handleInboxClick = () => {
    if (inboxPath) {
      navigate(inboxPath);
      return;
    }
    window.dispatchEvent(new Event(inboxEvent));
  };


  return (
    <header className="sticky top-0 z-80" ref={headerRef}>
      <div className="w-full border-b border-emerald-900/30 bg-linear-to-r from-emerald-800 via-emerald-700 to-green-600">
        <div className="mx-auto flex w-full items-center justify-between px-5 py-4 text-white">
          {/* --- Account Menu --- */}
          <div ref={wrapperRef} className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="group flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-white/10"
            >
              <span className="grid h-10 w-10 place-items-center rounded-full bg-white/20">
                <UserCircle className="h-6 w-6" />
              </span>
              <span className="leading-tight text-left">
                <div className="text-[17px] font-semibold">
                  {fullName || "(No name on file)"}
                </div>

                <div className="text-[12px] opacity-90">
                  {role}
                  {department && ` | ${department}`}
                </div>
              </span>
            </button>

            {menuOpen && (
              <div className="absolute left-0 top-full z-90 mt-2 w-56 rounded-2xl border border-neutral-200 bg-white text-slate-800 shadow-2xl">
                <div className="px-4 pb-2 pt-3 text-[15px] font-semibold text-emerald-700">
                  My Account
                </div>
                <div className="mx-4 h-px bg-neutral-200" />
                {isFacultyRole && isFacultyRoute && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate("/faculty/profile");
                    }}
                    className="flex w-full items-center gap-2 px-4 py-3 text-left text-[15px] hover:bg-neutral-50"
                  >
                    <UserCircle className="h-4 w-4" />
                    <span>My Profile</span>
                  </button>
                )}
                <div className="mx-4 h-px bg-neutral-200" />
                <button
                  onClick={logout}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left text-[15px] hover:bg-neutral-50"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            )}
          </div>

          {/* --- Right icons --- */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleInboxClick}
              className="relative rounded-md p-2 hover:bg-white/15"
              title="Inbox"
              aria-label="Open Inbox"
              data-testid="topbar-inbox-btn"
            >
              <Inbox className="h-5 w-5" />

              {hasInboxUnread && (
                <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-red-500" />
              )}
            </button>

            <div className="relative" ref={notifRef}>
              <button
                onClick={toggleNotif}
                className="relative rounded-md p-2 hover:bg-white/15"
                title="Notifications"
                aria-haspopup="menu"
                aria-expanded={notifOpen}
              >
                <Bell className="h-5 w-5" />
                {hasUnseen && (
                  <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 ring-2 ring-emerald-800" />
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 top-12 z-50 w-96 rounded-xl border border-neutral-200 bg-white text-slate-800 shadow-2xl">
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
                          <div className="font-semibold text-slate-900">
                            {n.title}
                          </div>
                          <div className="text-sm text-gray-600">{n.details}</div>
                          <div className="mt-1 text-xs text-gray-400">
                            {timeAgo(n.time as Date)}
                          </div>
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
          </div>
        </div>
        <div className="h-0.5 w-full bg-neutral-200/80" />
      </div>
    </header>
  );
}
