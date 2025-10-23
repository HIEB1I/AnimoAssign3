import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Bell,
  UserCircle,
  Inbox,
  LogOut,
  Plus,
  ChevronLeft,
} from "lucide-react";

/* ============ tiny utils ============ */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
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
const initials = (name: string) => name.split(" ").map(n => n[0]).slice(0, 2).join("").toUpperCase();

/* ============ Notifications ============ */
type Notification = { id: number; title: string; details: string; time: Date; seen?: boolean };
const INITIAL_NOTIFS: Notification[] = [
  { id: 1, title: "Department Chair approved your Plantilla", details: "The Dean has been notified.", time: new Date(Date.now() - 5 * 60 * 1000), seen: false },
  { id: 2, title: "Provost feedback received", details: "Review comments have been added.", time: new Date(Date.now() - 20 * 60 * 1000), seen: false },
  { id: 3, title: "New course schedule uploaded", details: "Check the updated 1st Term schedule.", time: new Date(Date.now() - 60 * 60 * 1000), seen: false },
];

/* ============ sample inbox data (placeholder) ============ */
type Mail = {
  id: number; from: string; email: string; subject: string; preview: string; body: string; receivedAt: Date;
};
const MAILS: Mail[] = [
  {
    id: 1,
    from: "Monica Santiago",
    email: "monica_santiago@dlsu.edu.ph",
    subject: "Account Approval Request",
    preview: "Hello, I recently registered for an account and would like to request…",
    body: "Hello, I recently registered for an account and would like to request approval for Faculty-FT access. I have attached my credentials and department approval. Please let me know if you need any additional information.",
    receivedAt: new Date(Date.now() - 2 * 60 * 1000),
  },
  {
    id: 2,
    from: "Charmaine Rosal",
    email: "c.rosal@dlsu.edu.ph",
    subject: "Account Approval Request",
    preview: "Hello, I recently registered for an account and would like to request…",
    body: "Hi, I recently registered for an account and would like to request approval.",
    receivedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
  },
];

/* ----------------------- Top Bar ----------------------- */
function TopBar() {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState(INITIAL_NOTIFS);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (!headerRef.current) return;
    const el = headerRef.current;
    const setHeightVar = () =>
      document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    setHeightVar();
    const ro = new ResizeObserver(setHeightVar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const logout = () => {
    localStorage.removeItem("authToken");
    sessionStorage.clear();
    navigate("/login");
  };

  const hasUnseen = notifications.some(n => !n.seen);
  const sortedNotifs = [...notifications].sort((a, b) => b.time.getTime() - a.time.getTime());
  const toggleNotif = () => {
    setNotifOpen((v) => !v);
    if (!notifOpen) setNotifications(n => n.map(x => ({ ...x, seen: true })));
  };

  return (
    <header className="sticky top-0 z-[80]" ref={headerRef}>
      <div className="w-full border-b border-emerald-900/30 bg-gradient-to-r from-emerald-800 via-emerald-700 to-green-600 text-white">
        <div className="mx-auto flex w-full items-center justify-between px-5 py-4">
          {/* Profile Button */}
          <div ref={wrapperRef} className="relative">
            <button
              onClick={() => setMenuOpen(o => !o)}
              className="group flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-white/10"
            >
              <span className="grid h-10 w-10 place-items-center rounded-full bg-white/20">
                <UserCircle className="h-6 w-6" />
              </span>
              <span className="leading-tight text-left">
                <div className="text-[17px] font-semibold">Hazel Ventura</div>
                <div className="text-[12px] opacity-90">Academic Programming Officer</div>
              </span>
            </button>
            {menuOpen && (
              <div className="absolute left-0 top-full z-[90] mt-2 w-48 rounded-2xl border border-neutral-200 bg-white text-slate-800 shadow-2xl">
                <div className="px-4 pb-2 pt-3 text-[15px] font-semibold text-emerald-700">My Account</div>
                <div className="mx-4 h-px bg-neutral-200" />
                <button onClick={logout} className="flex w-full items-center gap-2 px-4 py-3 text-left text-[15px] hover:bg-neutral-50">
                  <LogOut className="h-4 w-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            )}
          </div>

          {/* Inbox + Notifications */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate("/apo/inbox")}
              className="rounded-md p-2 hover:bg-white/15"
              title="Inbox"
            >
              <Inbox className="h-5 w-5" />
            </button>

            {/* Notifications */}
            <div className="relative" ref={notifRef}>
              <button
                onClick={toggleNotif}
                className="relative rounded-md p-2 hover:bg-white/15"
                title="Notifications"
              >
                <Bell className="h-5 w-5" />
                {hasUnseen && (
                  <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 ring-2 ring-emerald-800" />
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 top-12 z-50 w-96 rounded-xl border border-neutral-200 bg-white text-slate-800 shadow-2xl">
                  <div className="border-b border-neutral-200 px-4 py-3 font-semibold text-emerald-700">Notifications</div>
                  <div className="max-h-96 overflow-y-auto">
                    {sortedNotifs.length ? (
                      sortedNotifs.map(n => (
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

/* ============ Inbox Screen ============ */
export default function ADMIN_Inbox() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"default" | "compose" | "read">("default");
  const [selected, setSelected] = useState<Mail | null>(null);

  useEffect(() => {
    setMode("default");
    setSelected(null);
    setQuery("");
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MAILS.filter(m => !q || `${m.from} ${m.subject} ${m.preview}`.toLowerCase().includes(q))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }, [query]);

  const openCompose = () => setMode("compose");
  const openRead = (m: Mail) => { setSelected(m); setMode("read"); };
  const backToDefault = () => { setMode("default"); setSelected(null); };
  const goBack = () => navigate("/apo/preenlistment");

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900" style={{ scrollbarGutter: "stable both-edges" }}>
      <TopBar />

      <main className="mx-auto w-full max-w-none px-6 py-6 space-y-6">
        <div>
          <button
            onClick={goBack}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
        </div>

        <div>
          <h1 className="text-2xl font-bold">Inbox</h1>
          <p className="text-sm text-gray-600">Manage communication and support requests</p>
        </div>

        {/* search + compose */}
        <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search messages..."
              className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>

          <button
            onClick={openCompose}
            disabled={mode === "compose"}
            className={cls(
              "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium",
              mode === "compose"
                ? "bg-gray-300 text-gray-600 cursor-not-allowed"
                : "bg-emerald-700 text-white hover:bg-emerald-700"
            )}
          >
            <Plus className="h-4 w-4" /> Compose Email
          </button>
        </div>

        {/* layout */}
        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6">
          {/* left list */}
          <aside className="space-y-6">
            <div>
              <div className="mb-2 text-sm font-semibold text-gray-700">Messages</div>
              <div className="space-y-3">
                {filtered.map(m => (
                  <button
                    key={m.id}
                    onClick={() => openRead(m)}
                    className={cls(
                      "w-full rounded-xl border bg-white p-4 text-left shadow-sm hover:shadow",
                      selected?.id === m.id
                        ? "border-emerald-400 ring-1 ring-emerald-200"
                        : "border-gray-200"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700">
                        {initials(m.from)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold">{m.from}</div>
                          <div className="text-[11px] text-gray-400">{timeAgo(m.receivedAt)}</div>
                        </div>
                        <div className="text-sm">{m.subject}</div>
                        <div className="mt-1 line-clamp-1 text-xs text-gray-500">{m.preview}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </aside>

          {/* right panel */}
          <section className="rounded-xl border border-gray-200 bg-white p-5 min-h-[520px]">
            {mode === "default" && (
              <div className="h-full grid place-items-center text-center text-gray-500">
                <div>
                  <div className="mx-auto mb-4 grid h-16 w-20 place-items-center rounded-lg border border-gray-300">
                    <div className="w-10 h-6 border border-gray-400 rounded"></div>
                  </div>
                  <div className="font-semibold text-gray-700">Select a Message</div>
                  <div className="text-sm">Choose a message to view its content</div>
                </div>
              </div>
            )}
            {mode === "compose" && (
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">To:</label>
                  <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" placeholder="recipient@dlsu.edu.ph" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Subject:</label>
                  <input className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" placeholder="Subject" />
                </div>
                <div>
                  <textarea className="h-64 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" placeholder="Type your message..." />
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={backToDefault} className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">Cancel</button>
                  <button onClick={backToDefault} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">Send</button>
                </div>
              </div>
            )}
            {mode === "read" && selected && (
              <div className="space-y-5">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-100 text-[12px] font-bold text-emerald-700">
                    {initials(selected.from)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-semibold">{selected.subject}</div>
                    <div className="text-sm text-gray-600">
                      <span className="font-medium">From:</span> {selected.from}<br />
                      <span className="font-medium">Email:</span> {selected.email}<br />
                      <span className="text-gray-400">{timeAgo(selected.receivedAt)}</span>
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800 whitespace-pre-wrap">{selected.body}</div>
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Reply</div>
                  <textarea className="h-40 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" placeholder={`Reply to ${selected.from}...`} />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={backToDefault}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      Reply
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
