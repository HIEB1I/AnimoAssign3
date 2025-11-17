// frontend/src/pages/ADMIN/ADMIN.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { InboxContent as AdminInboxContent } from "./ADMIN_Inbox";
import TopBar from "../../component/TopBar";

/* ===================== small utils ===================== */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "");
const formatName = (last: string, first: string, mi?: string) =>
  `${cap(last)}, ${cap(first)}${mi?.trim() ? ` ${mi[0].toUpperCase()}.` : ""}`.trim();
const normalizeFullName = (raw: string) => {
  if (!raw) return raw;
  if (raw.includes(",")) {
    const [last, rest] = raw.split(",", 2);
    const [first = "", mi = ""] = (rest || "").trim().split(/\s+/);
    return formatName(last.trim(), first, mi.replace(".", ""));
  }
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const last = parts.pop() || "";
  const first = parts.shift() || "";
  const mi = (parts.shift() || "").replace(".", "");
  return formatName(last, first, mi);
};

/* ===================== primitives ===================== */
const Pill = ({
  children,
  tone = "neutral",
  minW = "",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "emerald" | "blue" | "amber" | "red";
  minW?: string;
}) => {
  const map = {
    neutral: "border border-neutral-200 bg-white text-neutral-700",
    emerald: "border border-emerald-200 bg-emerald-50 text-emerald-700",
    blue: "border border-blue-200 bg-blue-50 text-blue-700",
    amber: "border border-amber-200 bg-amber-50 text-amber-700",
    red: "border border-red-200 bg-red-50 text-red-600",
  } as const;
  return (
    <span
      className={cls(
        "inline-flex h-8 items-center justify-center rounded-full px-3 text-xs font-medium",
        minW,
        map[tone]
      )}
    >
      {children}
    </span>
  );
};

const TimestampCell = ({ ts }: { ts: string }) => {
  const [d, t] = ts.includes("T") && ts.includes(":")
    ? ts.replace("T", " ").split(" ")
    : (ts || "").split(" ");
  return (
    <div className="leading-tight">
      <div className="text-[13px] text-slate-700">{d || ts}</div>
      {t && <div className="text-[11px] text-gray-500">{t}</div>}
    </div>
  );
};

/* ---------- Dropdown (keyboard + click) ---------- */
function Dropdown({
  value,
  onChange,
  options,
  className = "w-full",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(() => Math.max(0, options.findIndex((o) => o === value)));
  const btnRef = useRef<HTMLButtonElement>(null), listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (!open && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHover((i) => (i + 1) % options.length);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((i) => (i - 1 + options.length) % options.length);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onChange(options[hover] ?? options[0]);
      setOpen(false);
      btnRef.current?.focus();
    }
  };
  return (
    <div className={cls("relative", className)} onKeyDown={onKey}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm shadow-sm outline-none hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30"
      >
        {value} <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">▾</span>
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-2 w-56 max-h-80 overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg"
        >
          {options.map((opt, i) => (
            <button
              key={opt}
              role="option"
              aria-selected={value === opt}
              onMouseEnter={() => setHover(i)}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls("block w-full text-left px-4 py-3 text-sm", i === hover && "bg-emerald-50")}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===================== data types for API ===================== */
type LogRow = {
  id: number;
  user: string;       // "Last, First"
  action: string;
  details: string;    // from remarks
  timestamp: string;  // "YYYY-MM-DD HH:mm:ss"
};

/* ===================== Page ===================== */
export default function ADMIN() {
  // Identity & shared TopBar props
  const rawUser = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const fullName =
    rawUser.fullName ||
    [rawUser.firstName || rawUser.first_name, rawUser.lastName || rawUser.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "Administrator";
  const role = "Administrator";
  const department = undefined; 
  const notifications: {
    id: number;
    title: string;
    details: string;
    time: Date | string;
    seen?: boolean;
  }[] = []; 

  // Remote data
  const [logsRemote, setLogsRemote] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Inbox show/hide (existing behavior)
  const [showInbox, setShowInbox] = useState(false);
  useEffect(() => {
    const onOpen = () => setShowInbox(true);
    const onClose = () => setShowInbox(false);
    window.addEventListener("admin:openInbox", onOpen);
    window.addEventListener("admin:closeInbox", onClose);
    return () => {
      window.removeEventListener("admin:openInbox", onOpen);
      window.removeEventListener("admin:closeInbox", onClose);
    };
  }, []);

  // Fetch from backend (Only logs)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/logs");
        const json = await res.json();
        if (!json.ok) throw new Error("Logs fetch failed");
        setLogsRemote(json.logs || []);
        setErr(null);
      } catch (e: any) {
        setErr(e?.message || "Failed to load data.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Logs filter/search
  const [qLogs, setQLogs] = useState("");
  const [action, setAction] = useState<string>("All Actions");
  const actionsAvailable = useMemo(
    () => ["All Actions", ...Array.from(new Set(logsRemote.map((l) => l.action))).sort()],
    [logsRemote]
  );
  const logs = useMemo(
    () =>
      logsRemote.filter(
        (r) =>
          (action === "All Actions" || r.action === action) &&
          `${r.user} ${r.action} ${r.details}`.toLowerCase().includes(qLogs.toLowerCase().trim())
      ),
    [logsRemote, action, qLogs]
  );
  const hasAnyForAction = action === "All Actions" ? true : logsRemote.some((r) => r.action === action);

  if (loading) {
    return (
      <div className="min-h-screen w-full bg-gray-50 text-slate-900">
        <TopBar
          fullName={fullName}
          role={role}
          department={department}
          notifications={notifications}
          inboxEvent="admin:openInbox"
        />
        <main className="mx-auto w-full max-w-none px-4 py-10 sm:px-6 lg:px-8">
          <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-600">
            Loading data…
          </div>
        </main>
      </div>
    );
  }
  if (err) {
    return (
      <div className="min-h-screen w-full bg-gray-50 text-slate-900">
        <TopBar
          fullName={fullName}
          role={role}
          department={department}
          notifications={notifications}
          inboxEvent="admin:openInbox"
        />
        <main className="mx-auto w-full max-w-none px-4 py-10 sm:px-6 lg:px-8">
          <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-sm text-red-700">
            {err}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900" style={{ scrollbarGutter: "stable both-edges" }}>
      <TopBar
        fullName={fullName}
        role={role}
        department={department}
        notifications={notifications}
        inboxEvent="admin:openInbox"
      />
      <main className="mx-auto w-full max-w-none space-y-8 px-4 py-6 sm:px-6 lg:px-8">
        {showInbox && <AdminInboxContent />}

        {/* ================= Audit Logs ================= */}
        <section className="rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Audit Logs</h2>
              <p className="mt-1 text-sm text-gray-500">Track all system activities and user actions</p>
            </div>
          </div>

          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <Search className="h-4 w-4" />
              </span>
              <input
                className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-10 text-sm shadow-sm outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-emerald-500/30"
                placeholder="Search by name, action, details..."
                value={qLogs}
                onChange={(e) => setQLogs(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQLogs("")}
              />
              {qLogs && (
                <button
                  type="button"
                  aria-label="Clear search"
                  title="Clear"
                  onClick={() => setQLogs("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-gray-100 hover:text-gray-700"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <Dropdown
              value={action}
              onChange={(v) => setAction(v)}
              options={actionsAvailable}
              className="w-56 text-left"
            />
          </div>

          <div className="flex items-center justify-between px-5">
            <h3 className="text-sm font-semibold text-slate-800">
              Activity Log ({logs.length} {logs.length === 1 ? "entry" : "entries"})
            </h3>
          </div>

          <div className="p-4">
            <div className="grid grid-cols-[25%_20%_35%_20%] items-center px-3 py-2 text-xs font-semibold text-gray-500">
              <div>User</div>
              <div className="flex justify-center">
                <span className="inline-block min-w-34 text-center">Action</span>
              </div>
              <div>Details</div>
              <div>Timestamp</div>
            </div>
            <div className="mx-3 mb-2 h-px bg-gray-300" />
            <div className="max-h-[600px] overflow-y-auto">
              {logs.map((r, i) => (
                <div
                  key={r.id}
                  className={cls(
                    "grid grid-cols-[25%_20%_35%_20%] items-center",
                    "px-3 py-3 text-sm",
                    i !== logs.length - 1 && "border-b border-gray-200"
                  )}
                >
                  <div>
                    <button className="font-semibold text-emerald-700 hover:underline">
                      {normalizeFullName(r.user)}
                    </button>
                  </div>
                  <div className="flex justify-center whitespace-nowrap">
                    <Pill minW="min-w-34">{r.action}</Pill>
                  </div>
                  <div className="text-gray-600">{r.details}</div>
                  <div>
                    <TimestampCell ts={r.timestamp} />
                  </div>
                </div>
              ))}
              {!logs.length && (
                <div className="px-3 py-10 text-center text-sm">
                  {action !== "All Actions" ? (
                    hasAnyForAction ? (
                      <>
                        No <span className="font-semibold">“{action}”</span> logs
                        {qLogs.trim() && <> matching “{qLogs.trim()}”</>}.
                      </>
                    ) : (
                      <>
                        There are currently no <span className="font-semibold">“{action}”</span> logs.
                      </>
                    )
                  ) : (
                    <>No results{qLogs.trim() && <> for “{qLogs.trim()}”</>}.</>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}