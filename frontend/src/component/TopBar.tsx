import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { UserCircle, LogOut, Inbox, Bell } from "lucide-react";

export default function ApoTopBar({ fullName, role }: { fullName: string; role: string }) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState([
    { id: 1, title: "Department Chair approved your Plantilla", details: "The Dean has been notified.", time: new Date(Date.now() - 5 * 60 * 1000), seen: false },
    { id: 2, title: "Provost feedback received", details: "Review comments have been added.", time: new Date(Date.now() - 20 * 60 * 1000), seen: false },
    { id: 3, title: "New course schedule uploaded", details: "Check the updated 1st Term schedule.", time: new Date(Date.now() - 60 * 60 * 1000), seen: false },
  ]);

  const notifRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (!headerRef.current) return;
    const el = headerRef.current;
    const setVar = () => document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    setVar();
    const ro = new ResizeObserver(setVar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const logout = () => {
    localStorage.removeItem("authToken");
    sessionStorage.clear();
    navigate("/login");
  };

  const timeAgo = (d: Date) => {
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} minutes ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hours ago`;
    const dd = Math.floor(h / 24);
    return `${dd} day${dd > 1 ? "s" : ""} ago`;
  };

  const hasUnseen = notifications.some((n) => !n.seen);
  const sortedNotifs = [...notifications].sort((a, b) => b.time.getTime() - a.time.getTime());
  const toggleNotif = () => {
    setNotifOpen((v) => !v);
    if (!notifOpen) setNotifications((n) => n.map((x) => ({ ...x, seen: true })));
  };

  return (
    <header className="sticky top-0 z-[80]" ref={headerRef}>
      <div className="w-full border-b border-emerald-900/30 bg-gradient-to-r from-emerald-800 via-emerald-700 to-green-600">
        <div className="mx-auto flex w-full items-center justify-between px-5 py-4 text-white">
          <div ref={wrapperRef} className="relative">
            <button onClick={() => setMenuOpen((o) => !o)} className="group flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-white/10">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-white/20">
                <UserCircle className="h-6 w-6" />
              </span>
              <span className="leading-tight text-left">
                <div className="text-[17px] font-semibold">{fullName}</div>
                <div className="text-[12px] opacity-90">{role}</div>
              </span>
            </button>
            {menuOpen && (
              <div className="absolute left-0 top-full z-[90] mt-2 w-56 rounded-2xl border border-neutral-200 bg-white text-slate-800 shadow-2xl">
                <div className="px-4 pb-2 pt-3 text-[15px] font-semibold text-emerald-700">My Account</div>
                <div className="mx-4 h-px bg-neutral-200" />
                <button onClick={logout} className="flex w-full items-center gap-2 px-4 py-3 text-left text-[15px] hover:bg-neutral-50">
                  <LogOut className="h-4 w-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate("/apo/inbox")} className="rounded-md p-2 hover:bg-white/15" title="Inbox">
              <Inbox className="h-5 w-5" />
            </button>
            <div className="relative" ref={notifRef}>
              <button onClick={toggleNotif} className="relative rounded-md p-2 hover:bg-white/15" title="Notifications">
                <Bell className="h-5 w-5" />
                {hasUnseen && <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 ring-2 ring-emerald-800" />}
              </button>
              {notifOpen && (
                <div className="absolute right-0 top-12 z-50 w-96 rounded-xl border border-neutral-200 bg-white text-slate-800 shadow-2xl">
                  <div className="border-b border-neutral-200 px-4 py-3 font-semibold text-emerald-700">Notifications</div>
                  <div className="max-h-96 overflow-y-auto">
                    {sortedNotifs.length ? (
                      sortedNotifs.map((n) => (
                        <div key={n.id} className="border-b border-neutral-100 px-4 py-3 last:border-0">
                          <div className="font-semibold text-slate-900">{n.title}</div>
                          <div className="text-sm text-gray-600">{n.details}</div>
                          <div className="mt-1 text-xs text-gray-400">{timeAgo(n.time)}</div>
                        </div>
                      ))
                    ) : (
                      <div className="px-4 py-6 text-center text-sm text-gray-500">No notifications</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="h-[2px] w-full bg-neutral-200/80" />
      </div>
    </header>
  );
}
