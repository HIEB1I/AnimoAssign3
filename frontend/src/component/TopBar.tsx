import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { UserCircle, LogOut, Inbox, Bell } from "lucide-react";

interface TopBarProps {
  fullName: string;
  role: string;
  department?: string;
  notifications?: {
    id: number;
    title: string;
    details: string;
    time: Date | string;
    seen?: boolean;
  }[];
  /** Which CustomEvent to dispatch when the Inbox icon is clicked.
   * Defaults to "faculty:openInbox" so Faculty keeps working without changes.
   * Use "admin:openInbox" on the Admin page.
   */
  inboxEvent?: string;
}

/**
 * Universal TopBar used by Admin, APO, and Faculty roles.
 * - Dynamic gradient bar and account dropdown
 * - Notifications dropdown with live "time ago"
 * - Optional department + notifications
 * - Inbox button dispatches a role-specific CustomEvent
 */
export default function TopBar({
  fullName,
  role,
  department,
  notifications: incomingNotifs = [],
  inboxEvent = "faculty:openInbox",
}: TopBarProps) {
  const navigate = useNavigate();

  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState(
    incomingNotifs.length
      ? incomingNotifs.map((n) => ({
          ...n,
          time: n.time instanceof Date ? n.time : new Date(n.time),
        }))
      : [
          {
            id: 1,
            title: "System Notice",
            details: "Welcome to AnimoAssign dashboard.",
            time: new Date(),
            seen: false,
          },
        ]
  );

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
  const logout = () => {
    localStorage.removeItem("authToken");
    sessionStorage.clear();
    navigate("/login");
  };

  // “x minutes ago” helper
  const timeAgo = (d: Date) => {
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
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
  const sortedNotifs = [...notifications].sort(
    (a, b) => (a.time as Date).getTime() - (b.time as Date).getTime()
  ).reverse();

  const toggleNotif = () => {
    setNotifOpen((v) => !v);
    if (!notifOpen) {
      setNotifications((n) => n.map((x) => ({ ...x, seen: true })));
    }
  };

  // Open Inbox inside Overview (no route/navigation)
  const openInboxInline = () => {
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
              onClick={openInboxInline}
              className="rounded-md p-2 hover:bg-white/15"
              title="Inbox"
              aria-label="Open Inbox"
              data-testid="topbar-inbox-btn"
            >
              <Inbox className="h-5 w-5" />
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
