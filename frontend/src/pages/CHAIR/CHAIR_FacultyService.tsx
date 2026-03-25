// frontend/src/pages/CHAIR/CHAIR_FacultyService.tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, Send, ChevronDown, X, CheckCircle2, AlertCircle, Info, Undo2, Redo2, Plus, Trash2, MessageSquareText } from "lucide-react";
import {
  getFSOptions,
  listFacultyService,
  createFacultyService,
  sendFacultyService,
  getOmLoadAssignmentRfc,
  respondOmLoadAssignmentRfc,
  type FacultyServiceRow,
  type DayShort,
  getChairHeader,
} from "@/api";

/* ---------------- tiny utils ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const norm = (s?: string) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
const eqDept = (a?: string, b?: string) => norm(a) === norm(b);

/* ---------------- received-tab new indicator (client-side) ----------------
   We mark requests as "seen" once the chair opens the Received Requests tab.
   Any unseen fs_id will trigger a "New" badge on the section header.

   IMPORTANT: This is separate from RFC unread indicators.
*/

/* ---------------- Toasts (in-file, no external libs) ---------------- */
type ToastType = "success" | "error" | "info";
type ToastInput = { type: ToastType; title?: string; message: string };
type ToastItem = {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  open: boolean;
};

function ToastViewport({
  items,
  onClose,
}: {
  items: ToastItem[];
  onClose: (id: string) => void;
}) {
  const iconFor = (t: ToastType) => {
    if (t === "success") return <CheckCircle2 className="h-5 w-5 text-emerald-700" />;
    if (t === "error") return <AlertCircle className="h-5 w-5 text-red-700" />;
    return <Info className="h-5 w-5 text-amber-700" />;
  };

  const accentFor = (t: ToastType) => {
    if (t === "success") return "bg-emerald-600";
    if (t === "error") return "bg-red-600";
    return "bg-amber-500";
  };

  const ringFor = (t: ToastType) => {
    if (t === "success") return "ring-emerald-700/10";
    if (t === "error") return "ring-red-700/10";
    return "ring-amber-700/10";
  };

  if (!items.length) return null;

  return (
    <div
      className={cls(
        "fixed z-[100000] right-4 top-[72px]",
        "w-[360px] max-w-[calc(100vw-2rem)]",
        "space-y-3"
      )}
      role="region"
      aria-label="Notifications"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={cls(
            "relative overflow-hidden rounded-xl border border-neutral-200 bg-white",
            "shadow-[0_10px_30px_rgba(0,0,0,0.12)] ring-1",
            ringFor(t.type),
            "transition-all duration-200 ease-out",
            t.open ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
          )}
        >
          <div className={cls("absolute left-0 top-0 h-full w-1.5", accentFor(t.type))} />

          <div className="flex gap-3 px-4 py-3">
            <div className="mt-0.5">{iconFor(t.type)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {t.title && <div className="text-[13px] font-semibold text-neutral-900">{t.title}</div>}
                  <div className="text-[13px] text-neutral-700 leading-snug break-words">{t.message}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onClose(t.id)}
                  className="shrink-0 rounded-md p-1 hover:bg-neutral-100"
                  aria-label="Dismiss"
                  title="Dismiss"
                >
                  <X className="h-4 w-4 text-neutral-500" />
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- RFC Modal (mirrors OM Load Assignment) ---------------- */
function ServiceRfcModal({
  open,
  onClose,
  userId,
  termId,
  facultyId,
  facultyName,
  sectionId,
  onAfterUpdate,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  termId: string;
  facultyId?: string;
  facultyName?: string;
  sectionId?: string;
  onAfterUpdate: (decision: "reply" | "approve" | "reject") => Promise<void> | void;
  onToast: (input: ToastInput) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [locked, setLocked] = useState<boolean>(false);
  const [reply, setReply] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setError(null);
      setMessages([]);
      setStatus(null);
      setLocked(false);
      setReply("");
      return;
    }

    (async () => {
      try {
        setLoading(true);
        setError(null);
        setMessages([]);
        setStatus(null);
        setLocked(false);

        if (!facultyId) {
          setError("No faculty selected for this service class.");
          return;
        }
        if (!sectionId) {
          setError("Missing section id.");
          return;
        }

        const res = await getOmLoadAssignmentRfc(userId, {
          term_id: termId,
          faculty_id: facultyId,
          section_id: sectionId,
        });

        if (!res?.ok || !res?.rfc) {
          setMessages([]);
          setStatus(null);
          return;
        }

        const rfc = res.rfc;
        setStatus(rfc.status || null);
        setLocked(Boolean(rfc.locked));
        setMessages(rfc.messages || rfc.thread || []);
      } catch (e: any) {
        setError(e?.message || "Failed to load RFC.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  if (!open) return null;

  const isTerminal = Boolean(locked);

  const respond = async (decision: "reply" | "approve" | "reject") => {
    if (!userId || !termId || !facultyId) {
      onToast({ type: "error", message: "Missing context." });
      return;
    }
    if (isTerminal) {
      onToast({ type: "error", message: "RFC is already locked." });
      return;
    }
    if (decision === "reply" && !reply.trim()) {
      onToast({ type: "info", message: "Please type a reply message." });
      return;
    }

    setLoading(true);
    try {
      await respondOmLoadAssignmentRfc(userId, {
        term_id: termId,
        faculty_id: facultyId,
        section_id: sectionId,
        action: decision,
        message: reply.trim() || undefined,
      });

      await onAfterUpdate(decision);

      const msg =
        decision === "reply"
          ? "Reply sent to faculty."
          : decision === "approve"
          ? "RFC approved."
          : "RFC rejected.";
      onToast({ type: "success", message: msg });
      onClose();
    } catch (e: any) {
      onToast({ type: "error", title: "Failed", message: e?.message || "Failed to send response." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl relative max-h-[92vh] flex flex-col overflow-hidden">
        <button
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 hover:bg-gray-100"
          onClick={onClose}
        >
          <X className="h-5 w-5 text-gray-500" />
        </button>

        <div className="p-6 pb-4">
          <h3 className="text-lg font-semibold text-emerald-700 mb-2">Request for Change</h3>
          <div className="text-sm text-gray-600 mb-1">
            From: <span className="font-semibold">{facultyName || "Faculty"}</span>
          </div>

          {loading && <div className="mb-4 text-sm text-gray-600">Loading…</div>}
          {error && <div className="mb-4 text-sm text-red-600">{error}</div>}
        </div>

        <div
          ref={scrollRef}
          className="mx-6 mb-4 flex-1 min-h-0 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3"
        >
          {messages.length ? (
            <div className="space-y-2">
              {messages.map((m: any, idx: number) => {
                const whoRaw = (m.sender_role || m.from || "").toString();
                const who = whoRaw.toUpperCase();
                const ts = m.created_at ? new Date(m.created_at).toLocaleString() : "";
                const isFaculty = /FACULTY/i.test(whoRaw) || who === "F";
                const bubble = m.message || m.text || "";

                return (
                  <div key={idx} className={cls("flex", isFaculty ? "justify-start" : "justify-end")}>
                    <div className={cls("max-w-[85%]", isFaculty ? "text-left" : "text-right")}>
                      <div className={cls("mb-1 text-[11px] text-gray-500", isFaculty ? "pl-1" : "pr-1")}>
                        {who || (isFaculty ? (facultyName || "FACULTY").toUpperCase() : "OM")}
                        {ts ? ` • ${ts}` : ""}
                      </div>
                      <div
                        className={cls(
                          "inline-block rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                          isFaculty
                            ? "bg-white text-gray-800 border border-gray-200"
                            : "bg-emerald-700 text-white"
                        )}
                      >
                        {bubble}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-gray-600">No messages yet.</div>
          )}
        </div>

        <div className="mx-6">
          <label className="block text-sm font-medium mb-1">Reply</label>
          <textarea
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30 mb-6"
            rows={4}
            placeholder={isTerminal ? "This RFC is locked." : "Type your reply…"}
            value={reply}
            disabled={loading || !status || isTerminal}
            onChange={(e) => setReply(e.target.value)}
          />
        </div>

        <div className="mx-6 pb-6 flex justify-end gap-2">
          <button
            disabled={loading || !status || isTerminal}
            className={cls(
              "px-4 py-2 rounded-lg bg-red-600 text-white text-sm",
              (loading || !status || isTerminal) && "opacity-60 cursor-not-allowed"
            )}
            onClick={() => void respond("reject")}
          >
            Reject
          </button>
          <button
            disabled={loading || !status || isTerminal}
            className={cls(
              "px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm",
              (loading || !status || isTerminal) && "opacity-60 cursor-not-allowed"
            )}
            onClick={() => void respond("approve")}
          >
            Approve
          </button>
          <button
            disabled={loading || !status || isTerminal}
            className={cls(
              "px-4 py-2 rounded-lg bg-blue-600 text-white text-sm",
              (loading || !status || isTerminal) && "opacity-60 cursor-not-allowed"
            )}
            onClick={() => void respond("reply")}
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  );
}

/** unify control heights */
const CONTROL =
  "w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm " +
  "focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300";

const CARD_SHELL = "rounded-2xl border border-gray-200 bg-white shadow-sm";
const INFO_TILE = "rounded-xl border border-gray-200 bg-gray-50 px-4 py-3";

function SectionShell({
  title,
  subtitle,
  children,
  actions,
  accent = "emerald",
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  actions?: ReactNode;
  accent?: "emerald" | "slate";
}) {
  const headerTone =
    accent === "slate"
      ? "from-slate-900 via-slate-800 to-slate-700"
      : "from-slate-900 via-emerald-900 to-emerald-700";

  return (
    <section className={CARD_SHELL}>
      <div className={cls("rounded-t-2xl px-5 py-5 text-white", "bg-gradient-to-r", headerTone)}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-white/80">{subtitle}</p>
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      <div className="bg-gray-50 p-5">{children}</div>
    </section>
  );
}

function FieldTile({
  label,
  value,
  className = "",
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={cls(INFO_TILE, className)}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-gray-900 break-words">{value}</div>
    </div>
  );
}

function statusSelectTone(value?: string) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "approved") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (v === "rejected") return "border-red-300 bg-red-50 text-red-800";
  if (v === "pending") return "border-amber-300 bg-amber-50 text-amber-800";
  return "";
}

function StatusChip({ label }: { label: string }) {
  const tone =
    label === "Approved"
      ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
      : label === "Rejected"
      ? "bg-red-100 text-red-800 ring-red-200"
      : label === "Draft"
      ? "bg-slate-200 text-slate-700 ring-slate-300"
      : "bg-amber-100 text-amber-800 ring-amber-200";

  return (
    <span className={cls("inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ring-1", tone)}>
      {label}
    </span>
  );
}

function ScheduleSummary({
  day1,
  begin1,
  end1,
  day2,
  begin2,
  end2,
  emptyLabel = "Awaiting receiver response",
}: {
  day1?: string;
  begin1?: string;
  end1?: string;
  day2?: string;
  begin2?: string;
  end2?: string;
  emptyLabel?: string;
}) {
  const lines = [
    [day1, begin1, end1],
    [day2, begin2, end2],
  ]
    .map(([day, begin, end]) => {
      const d = String(day || "").trim();
      const b = String(begin || "").trim();
      const e = String(end || "").trim();
      if (!d && !b && !e) return "";
      const time = b && e ? `${b} - ${e}` : b || e;
      return [d, time].filter(Boolean).join(" · ");
    })
    .filter(Boolean);

  if (lines.length === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
        {emptyLabel}
      </span>
    );
  }

  return <div className="text-sm text-gray-700">{lines.join("  |  ")}</div>;
}

/* ---------------- Dropdown (portal-less, fixed-positioned) ---------------- */
function Dropdown({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "",
  searchable = false,
  align = "left",
  onOpen,
  disabled = false,
  tone = "default",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  searchable?: boolean;
  align?: "left" | "right";
  onOpen?: () => void;
  disabled?: boolean;
  tone?: "default" | "status";
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [menuRect, setMenuRect] = useState<{
    left: number;
    top: number;
    width: number;
    place: "down" | "up";
  }>();

  const shown = useMemo(() => {
    const list = options || [];
    if (!searchable) return list;
    const q = term.trim().toLowerCase();
    return q ? list.filter((o) => o.toLowerCase().includes(q)) : list;
  }, [options, term, searchable]);

  const compute = () => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Always open downward.
    const place: "down" | "up" = "down";

    const width = Math.max(r.width, 180);
    const left = Math.max(8, Math.min(vw - width - 8, align === "right" ? r.right - width : r.left));
    const top = Math.min(vh - 8, r.bottom + 6);

    setMenuRect({ left, top, width, place });
  };

  const menuId = useMemo(() => `dd-${Math.random().toString(36).slice(2)}`, []);

  // Close on outside click
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open) return;
      const t = e.target as Node;
      if (boxRef.current?.contains(t)) return;
      const menu = document.getElementById(menuId);
      if (!menu || !menu.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, menuId]);

  useLayoutEffect(() => {
    if (!open) return;
    compute();
    const onResize = () => compute();
    const onScroll = () => compute();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    if (searchable) inputRef.current?.focus();
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, term, align, shown.length, searchable]);

  const openFresh = () => {
    if (disabled) return;
    if (searchable) setTerm("");
    onOpen?.();
    setOpen(true);
    requestAnimationFrame(() => {
      compute();
      if (searchable) inputRef.current?.focus();
    });
  };

  const onPick = (opt: string) => {
    onChange(opt);
    if (searchable) setTerm("");
    setOpen(false);
  };

  const baseBtn = cls(
    "w-full h-10 rounded-lg border px-3 text-left text-sm outline-none pr-8 flex items-center transition-colors",
    tone === "status"
      ? cls(
          "shadow-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300",
          statusSelectTone(value) || "border-gray-300 bg-white"
        )
      : "border-gray-300 bg-white shadow-sm focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300",
    disabled && "cursor-not-allowed bg-gray-100 text-gray-400"
  );

  return (
    <div className={cls("relative", className)} ref={boxRef}>
      <div className="relative">
        {searchable ? (
          <input
            ref={inputRef}
            value={open ? term : value}
            disabled={disabled}
            onMouseDown={(e) => {
              if (disabled) return;
              if (!open) {
                e.preventDefault();
                openFresh();
              }
            }}
            onFocus={() => {
              if (disabled) return;
              if (!open) openFresh();
            }}
            onChange={(e) => {
              if (disabled) return;
              setTerm(e.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={(e) => {
              if (disabled) return;
              if (e.key === "ArrowDown" && !open) {
                openFresh();
                e.preventDefault();
              }
              if (e.key === "Enter" && shown.length > 0) onPick(shown[0]);
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder={placeholder}
            className={cls(baseBtn, "truncate")}
          />
        ) : (
          <button
            type="button"
            disabled={disabled}
            className={cls(baseBtn, !value && "text-gray-400")}
            onClick={() => {
              if (disabled) return;
              if (open) setOpen(false);
              else openFresh();
            }}
          >
            {value ? value : <span className="text-gray-400">{placeholder}</span>}
          </button>
        )}

        {searchable && open && term && !disabled && (
          <button
            type="button"
            onClick={() => {
              setTerm("");
              requestAnimationFrame(() => {
                compute();
                inputRef.current?.focus();
              });
            }}
            className="absolute right-8 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-neutral-100"
            aria-label="Clear"
          >
            <X className="h-4 w-4 text-neutral-500" />
          </button>
        )}

        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      </div>

      {open && menuRect && !disabled && (
        <div
          id={menuId}
          style={{
            position: "fixed",
            left: menuRect.left,
            top: menuRect.top,
            width: menuRect.width,
            maxHeight: "60vh",
          }}
          className={cls(
            "z-[100000] overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl",
            "overscroll-contain py-1"
          )}
        >
          {shown.map((opt) => (
            <button
              key={opt}
              onClick={() => onPick(opt)}
              className={cls(
                "w-full h-10 truncate px-4 text-left text-sm hover:bg-emerald-50 transition-colors flex items-center",
                value === opt && "bg-emerald-100 text-emerald-800 font-medium"
              )}
            >
              {opt}
            </button>
          ))}
          {shown.length === 0 && <div className="px-4 h-10 flex items-center text-sm text-neutral-500">No results</div>}
        </div>
      )}
    </div>
  );
}

/* ---------------- Spec constants ---------------- */

const BEGIN_OPTIONS = ["07:30", "09:15", "11:00", "12:45", "14:30", "16:15", "18:00", "19:45"] as const;
const END_BY_BEGIN: Record<(typeof BEGIN_OPTIONS)[number], string> = {
  "07:30": "09:00",
  "09:15": "10:45",
  "11:00": "12:30",
  "12:45": "14:15",
  "14:30": "16:00",
  "16:15": "17:45",
  "18:00": "19:30",
  "19:45": "21:00",
};

// Use only M/T/W for the first day, and auto-pair Day2
const DAY1_OPTIONS: DayShort[] = ["M", "T", "W", "H", "F", "S"];

const DAY2_BY_DAY1: Partial<Record<DayShort, DayShort>> = {
  M: "H", // MH
  T: "F", // TF
  W: "S", // WS
};



type FSCreate = {
  course_code: string;
  section_id: string;
  section: string;
  course_title: string;
  units: number | null;
  to_department: string | "";
  remarks: string;
};

function facultyLabel(f?: { first_name?: string; last_name?: string; email?: string }) {
  if (!f) return "";
  const L = (f.last_name || "").toUpperCase();
  const F = (f.first_name || "").toUpperCase();
  return L || F ? `${L}, ${F}` : "";
}


/* ---------------- RFC schedule helpers ---------------- */
const normalizeDayShort = (d?: string): DayShort | "" => {
  const raw = (d || "").trim().toUpperCase();
  if (!raw) return "";
  // accept "TH" / "TTh" variants for Thursday
  if (raw.startsWith("TH") || raw === "H") return "H";
  const c = raw[0];
  if (c === "M") return "M";
  if (c === "T") return "T";
  if (c === "W") return "W";
  if (c === "F") return "F";
  if (c === "S") return "S";
  return "";
};

const splitTimeRange = (range?: string): { begin?: string; end?: string } => {
  const s = (range || "").trim();
  if (!s) return {};
  // common formats:
  //  - "07:30 - 09:00"
  //  - "07:30-09:00"
  //  - "07:30–09:00" (en-dash from backend)
  //  - "07:30—09:00" (em-dash)
  //  - "7:30 AM - 9:00 AM"
  const parts = s
    .split(/\s*[-–—]\s*/g)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { begin: parts[0], end: parts[1] };
  return {};
};


const timeToMinutes = (value?: string): number | null => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const hhmm = raw.includes(":") ? raw : raw.length === 4 ? `${raw.slice(0, 2)}:${raw.slice(2)}` : raw;
  const parts = hhmm.split(":");
  if (parts.length !== 2) return null;
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
};

const normalizeBusyDay = (value?: string): DayShort | "" => normalizeDayShort(value);

const rangesOverlap = (beginA: number, endA: number, beginB: number, endB: number) =>
  beginA < endB && beginB < endA;

const getMeetingEnd = (begin?: string, fallback?: string) => {
  const b = String(begin || "").trim();
  if (!b) return String(fallback || "").trim();
  return END_BY_BEGIN[b as keyof typeof END_BY_BEGIN] || String(fallback || "").trim();
};

const buildMeetingSlots = (edit: {
  day1?: string;
  begin1?: string;
  end1?: string;
  day2?: string;
  begin2?: string;
  end2?: string;
}) => {
  const meetings: Array<{ slot: 1 | 2; day: DayShort; begin: string; end: string; beginMinutes: number; endMinutes: number }> = [];
  ([1, 2] as const).forEach((slot) => {
    const day = normalizeBusyDay(edit[`day${slot}` as const]) as DayShort | "";
    const begin = String(edit[`begin${slot}` as const] || "").trim();
    const end = getMeetingEnd(begin, String(edit[`end${slot}` as const] || "").trim());
    const b = timeToMinutes(begin);
    const e = timeToMinutes(end);
    if (!day || b == null || e == null || e <= b) return;
    meetings.push({ slot, day, begin, end, beginMinutes: b, endMinutes: e });
  });
  return meetings;
};

const facultyHasConflictForMeetings = ({
  facultyId,
  meetings,
  busySlots,
  excludeSectionId,
}: {
  facultyId?: string;
  meetings: ReturnType<typeof buildMeetingSlots>;
  busySlots: FacultyAvailabilityMap;
  excludeSectionId?: string;
}) => {
  const fid = String(facultyId || "").trim();
  if (!fid || meetings.length === 0) return false;
  const excluded = String(excludeSectionId || "").trim();
  return (busySlots[fid] || []).some((slot) => {
    if (excluded && String(slot.section_id || "").trim() === excluded) return false;
    const day = normalizeBusyDay(slot.day);
    const begin = timeToMinutes(slot.begin);
    const end = timeToMinutes(slot.end);
    if (!day || begin == null || end == null || end <= begin) return false;
    return meetings.some((meeting) => meeting.day === day && rangesOverlap(meeting.beginMinutes, meeting.endMinutes, begin, end));
  });
};

const slotOptionIsAvailable = ({
  facultyId,
  slot,
  day,
  begin,
  peerMeetings,
  busySlots,
  excludeSectionId,
}: {
  facultyId?: string;
  slot: 1 | 2;
  day?: string;
  begin?: string;
  peerMeetings: ReturnType<typeof buildMeetingSlots>;
  busySlots: FacultyAvailabilityMap;
  excludeSectionId?: string;
}) => {
  const normDay = normalizeBusyDay(day);
  const cleanBegin = String(begin || "").trim();
  const end = getMeetingEnd(cleanBegin, "");
  const beginMinutes = timeToMinutes(cleanBegin);
  const endMinutes = timeToMinutes(end);
  if (!normDay || beginMinutes == null || endMinutes == null || endMinutes <= beginMinutes) return true;
  return !facultyHasConflictForMeetings({
    facultyId,
    meetings: [...peerMeetings, { slot, day: normDay as DayShort, begin: cleanBegin, end, beginMinutes, endMinutes }],
    busySlots,
    excludeSectionId,
  });
};
/* ---------------- Departments ---------------- */
// NOTE: Faculty Service is bi-directional. "From" is always the logged-in chair's department.

/* ------------- Faculty option type ------------- */
type FacultyOption = {
  faculty_id: string;
  first_name: string;
  last_name: string;
  email?: string;
  label: string; // e.g., "LAST, FIRST (email)"
};

type FacultyBusySlot = {
  section_id?: string;
  day: string;
  begin: string;
  end: string;
};

type FacultyAvailabilityMap = Record<string, FacultyBusySlot[]>;

/* ------------- Component props (logged-in chair dept) ------------- */
type ChairFacultyServiceProps = {
  /**
   * Logged-in chair's department name, e.g.:
   *   "Department of Software Technology"
   *   "Department of Information Technology"
   *   "Department of Computer Technology"
   *   "Department of Literature"
   *
   * If omitted, we derive it from getChairHeader(). As a last resort we fall back
   * to "Department of Software Technology" for backwards compatibility.
   */
  chairDepartmentName?: string;

  /**
   * UI rendering mode.
   * - page: full-page layout (default for CHAIR route)
   * - embedded: render without page shell/sticky header so OM pages can wrap it
   */
  variant?: "page" | "embedded";
};

export default function CHAIR_FacultyService({ chairDepartmentName, variant = "page" }: ChairFacultyServiceProps) {
  /**
   * Bi-directional behavior:
   * - Any department can create and send requests to any other department.
   * - Each chair sees BOTH: Sent (from my dept) and Received (to my dept).
   */

  /* ---------------- toast state ---------------- */
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastTimers = useRef<Record<string, number>>({});

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (toastTimers.current[id]) {
      window.clearTimeout(toastTimers.current[id]);
      delete toastTimers.current[id];
    }
  };

  const closeToast = (id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, open: false } : t)));
    // allow exit transition to play
    window.setTimeout(() => removeToast(id), 220);
  };

  const showToast = ({ type, title, message }: ToastInput) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const item: ToastItem = { id, type, title, message, open: true };

    setToasts((prev) => [item, ...prev]);
    toastTimers.current[id] = window.setTimeout(() => closeToast(id), 3000);
  };

  useEffect(() => {
    return () => {
      Object.values(toastTimers.current).forEach((t) => window.clearTimeout(t));
      toastTimers.current = {};
    };
  }, []);

  // Working / planning term coming from backend activeTerm
  const [termLabel, setTermLabel] = useState<string>("");
  const [termId, setTermId] = useState<string>("");

  // Start empty; we derive from props or chair header.
  // Fallback to ST only if we truly can't derive a department.
  const [activeDeptName, setActiveDeptName] = useState<string>(chairDepartmentName || "");

  // NOTE: Faculty Service is shown in a single compact view (no top tabs).

  // Build a header label from options.activeTerm
  const updateTermLabelFromOptions = (o: any) => {
    const ay = o?.activeTerm?.acad_year_start;
    const tn = o?.activeTerm?.term_number;
    const tid = o?.activeTerm?.term_id || o?.activeTerm?.id || o?.activeTerm?._id;
    if (tid) setTermId(String(tid));
    if (ay) {
      setTermLabel(`Term ${tn ?? "—"} · AY ${ay}-${ay + 1}`);
    } else {
      setTermLabel("");
    }
  };

  const meUserId = useMemo(() => {
    try {
      const raw = localStorage.getItem("animo.user");
      const u = raw ? JSON.parse(raw) : {};
      return String(u?.userId || u?.user_id || u?.id || "");
    } catch {
      return "";
    }
  }, []);

  const [rfcModal, setRfcModal] = useState<null | {
    open: boolean;
    facultyId: string;
    facultyName: string;
    sectionId: string;
    fsId?: string;
  }>(null);

  // RFC presence/status cache for Faculty Service rows (used in Received Requests table)
  const [rfcPendingByKey, setRfcPendingByKey] = useState<Record<string, boolean>>({});
  const [rfcUpdatedAtByKey, setRfcUpdatedAtByKey] = useState<Record<string, string>>({});
  const [rfcLastSenderByKey, setRfcLastSenderByKey] = useState<Record<string, string>>({});
  const rfcKey = (sectionId?: string | null, facultyId?: string | null) =>
    `${String(sectionId || "")}::${String(facultyId || "")}`;

  // If parent doesn’t pass chairDepartmentName, derive it from the chair header.
  useEffect(() => {
    if (chairDepartmentName) {
      // Parent explicitly told us the dept → trust it.
      setActiveDeptName(chairDepartmentName);
      return;
    }

    (async () => {
      try {
        const raw = localStorage.getItem("animo.user");
        const u = raw ? JSON.parse(raw) : null;
        const userId = u?.userId;
        if (!userId) return;

        const header = await getChairHeader(userId);
        // Prefer an explicit field if backend provides one; otherwise parse subtitle.
        const subtitle: string | undefined = header?.profileSubtitle;
        const derivedDept = header?.dept_label || (subtitle ? subtitle.split("|")[1]?.trim() : "");

        if (derivedDept) setActiveDeptName(derivedDept);
      } catch {
        // ignore
      }
    })();
  }, [chairDepartmentName]);

  // Final safety fallback (backwards compatibility): if we still can't derive, default to ST.
  useEffect(() => {
    if (!activeDeptName) setActiveDeptName("Department of Software Technology");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDeptName]);

  const [toDepts, setToDepts] = useState<string[]>([]);
  const [timeBegins] = useState<string[]>([...BEGIN_OPTIONS]);
  const [facultyCache, setFacultyCache] = useState<Record<string, FacultyOption[]>>({});
  const [facultyAvailabilityCache, setFacultyAvailabilityCache] = useState<Record<string, FacultyAvailabilityMap>>({});

  type DraftRow = FSCreate & { _tmpId: string };
  const makeDraftRow = (): DraftRow => ({
    _tmpId: `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    course_code: "",
    section_id: "",
    section: "",
    course_title: "",
    units: null,
    to_department: "",
    remarks: "",
  });

  const [draftRows, setDraftRows] = useState<DraftRow[]>([makeDraftRow()]);
  const [selectedDraftIds, setSelectedDraftIds] = useState<Record<string, boolean>>({});

  const updateDraftRow = (tmpId: string, patch: Partial<DraftRow>) => {
    setDraftRows((prev) => prev.map((r) => (r._tmpId === tmpId ? { ...r, ...patch } : r)));
  };

  const addDraftRow = () => {
    const nr = makeDraftRow();
    setDraftRows((prev) => [...prev, nr]);
    setSelectedDraftIds((prev) => ({ ...prev, [nr._tmpId]: true }));
  };

  const removeDraftRow = (tmpId: string) => {
    setDraftRows((prev) => {
      const next = prev.filter((r) => r._tmpId !== tmpId);
      return next.length ? next : [makeDraftRow()];
    });
    setSelectedDraftIds((prev) => {
      const n = { ...prev };
      delete n[tmpId];
      return n;
    });
  };

  type ReceiverEdit = {
    faculty?: { faculty_id?: string; first_name?: string; last_name?: string; email?: string };
    day1: DayShort | "";
    begin1: string | "";
    end1: string | "";
    day2: DayShort | "";
    begin2: string | "";
    end2: string | "";
    remarks: string;
  };

  const EMPTY_EDIT: ReceiverEdit = {
    faculty: undefined,
    day1: "",
    begin1: "",
    end1: "",
    day2: "",
    begin2: "",
    end2: "",
    remarks: "",
  };

  const [edits, setEdits] = useState<Record<string, ReceiverEdit>>({});

  const getEditFrom = (all: Record<string, ReceiverEdit>, id: string): ReceiverEdit => all[id] || EMPTY_EDIT;
  const getEdit = (id: string): ReceiverEdit => getEditFrom(edits, id);

  /* -------------------- Undo / Redo (Received Requests edits) --------------------
     - Ctrl/Cmd+Z => Undo
     - Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z => Redo
     - Does not override native undo/redo inside inputs/textareas/contenteditable
  */

  const editsRef = useRef<Record<string, ReceiverEdit>>({});
  useEffect(() => {
    editsRef.current = edits;
  }, [edits]);

  // Global (cross-row) undo/redo history. Tracks the sequence of edits the user makes.
  const undoRef = useRef<Record<string, ReceiverEdit>[]>([]);
  const redoRef = useRef<Record<string, ReceiverEdit>[]>([]);

  // Used to re-render small UI controls (Undo/Redo buttons) that depend on ref-based history.
  const [historyTick, setHistoryTick] = useState(0);
  const bumpHistoryTick = () => setHistoryTick((t) => t + 1);

  const cloneJson = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

  const pushHistory = (prevEdits: Record<string, ReceiverEdit>, nextEdits: Record<string, ReceiverEdit>) => {
    // Skip no-op changes
    try {
      if (JSON.stringify(prevEdits) === JSON.stringify(nextEdits)) return;
    } catch {
      // continue
    }

    undoRef.current = [...undoRef.current, cloneJson(prevEdits)].slice(-120);
    redoRef.current = []; // any new edit invalidates redo
    bumpHistoryTick();
  };

  const undoEdit = () => {
    const u = undoRef.current;
    if (!u.length) return;

    const prev = u[u.length - 1];
    const cur = editsRef.current || {};

    undoRef.current = u.slice(0, -1);
    redoRef.current = [...redoRef.current, cloneJson(cur)].slice(-120);

    setEdits(prev);
    bumpHistoryTick();
  };

  const redoEdit = () => {
    const r = redoRef.current;
    if (!r.length) return;

    const next = r[r.length - 1];
    const cur = editsRef.current || {};

    redoRef.current = r.slice(0, -1);
    undoRef.current = [...undoRef.current, cloneJson(cur)].slice(-120);

    setEdits(next);
    bumpHistoryTick();
  };

  const patchEdit = (id: string, patch: Partial<ReceiverEdit>) => {
    setEdits((prev) => {
      const cur = getEditFrom(prev, id);
      const next = { ...cur, ...patch };
      const nextEdits = { ...prev, [id]: next };
      pushHistory(prev, nextEdits);
      return nextEdits;
    });
  };

  useLayoutEffect(() => {
    const isEditableTarget = (t: any) => {
      const el = (t && (t as HTMLElement)) || null;
      if (!el) return false;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if ((el as any).isContentEditable) return true;
      if (el.closest?.("[contenteditable='true']")) return true;
      if (el.getAttribute?.("role") === "textbox") return true;
      return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.altKey) return;

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      const key = String(e.key || "").toLowerCase();
      if (key !== "z" && key !== "y") return;

      // Let native undo/redo work inside inputs (remarks) or dropdown search.
      if (isEditableTarget(e.target)) return;

      e.preventDefault();
      e.stopPropagation();

      // Ctrl/Cmd+Z => Undo
      if (key === "z" && !e.shiftKey) {
        undoEdit();
        return;
      }

      // Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z => Redo
      if (key === "y" || (key === "z" && e.shiftKey)) {
        redoEdit();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [sentRows, setSentRows] = useState<FacultyServiceRow[]>([]);
  const [receivedRows, setReceivedRows] = useState<FacultyServiceRow[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [collapsedReceivedRows, setCollapsedReceivedRows] = useState<Record<string, boolean>>({});
  const autoCollapsedReceivedRef = useRef<Record<string, boolean>>({});

  /* --------- new-received indicator (persisted locally per chair+dept) --------- */
  const [hasNewReceived, setHasNewReceived] = useState(false);
  const seenReceivedRef = useRef<Set<string>>(new Set());

  const receivedSeenKey = useMemo(() => {
    let uid = "anon";
    try {
      const raw = localStorage.getItem("animo.user");
      const u = raw ? JSON.parse(raw) : null;
      uid = (u?.userId ?? u?.id ?? "anon") as string;
    } catch {
      // ignore
    }
    return `animo.fs.received.seen.${uid}.${norm(activeDeptName || "") || "unknown"}`;
  }, [activeDeptName]);

  const loadSeenReceived = () => {
    try {
      const raw = localStorage.getItem(receivedSeenKey);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      const ids = Array.isArray(arr) ? (arr.filter((x) => typeof x === "string") as string[]) : [];
      seenReceivedRef.current = new Set(ids);
    } catch {
      seenReceivedRef.current = new Set();
    }
  };

  const saveSeenReceived = () => {
    try {
      const ids = Array.from(seenReceivedRef.current);
      // keep it bounded
      localStorage.setItem(receivedSeenKey, JSON.stringify(ids.slice(-500)));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!activeDeptName) return;
    loadSeenReceived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receivedSeenKey]);

  // Once the received table is populated (i.e., the chair has opened/loaded this screen),
  // mark all currently visible received requests as seen.
  useEffect(() => {
    if (!receivedRows || receivedRows.length === 0) return;
    try {
      receivedRows.forEach((r) => {
        const id = r?.fs_id || r?.id;
        if (id) seenReceivedRef.current.add(String(id));
      });
      saveSeenReceived();
      if (hasNewReceived) setHasNewReceived(false);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receivedRows]);

  /* --------- RFC unread indicator (persisted locally per chair user) ---------
     We show a red dot on the message icon when:
       - there is an active RFC (pending), AND
       - the RFC has been updated since the chair last opened the thread.

     Key is section_id::faculty_id (same as rfcKey()).
  */

  const seenRfcRef = useRef<Record<string, string>>({});

  const rfcSeenKey = useMemo(() => {
    let uid = "anon";
    try {
      const raw = localStorage.getItem("animo.user");
      const u = raw ? JSON.parse(raw) : null;
      uid = (u?.userId ?? u?.id ?? "anon") as string;
    } catch {
      // ignore
    }
    return `animo.fs.rfc.seen.${uid}`;
  }, []);

  const loadSeenRfc = () => {
    try {
      const raw = localStorage.getItem(rfcSeenKey);
      const obj = raw ? JSON.parse(raw) : {};
      seenRfcRef.current = obj && typeof obj === "object" ? obj : {};
    } catch {
      seenRfcRef.current = {};
    }
  };

  const saveSeenRfc = () => {
    try {
      localStorage.setItem(rfcSeenKey, JSON.stringify(seenRfcRef.current || {}));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadSeenRfc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRfcUnseen = (key: string) => {
    const upd = rfcUpdatedAtByKey[key];
    if (!upd) return false;

    const lastSender = norm(String(rfcLastSenderByKey[key] || ""));
    if (lastSender && lastSender !== "faculty") return false;

    const seen = seenRfcRef.current?.[key];
    if (!seen) return true;
    return new Date(seen).getTime() < new Date(upd).getTime();
  };

  const markRfcSeen = (key: string) => {
    const upd = rfcUpdatedAtByKey[key] || new Date().toISOString();
    seenRfcRef.current = { ...(seenRfcRef.current || {}), [key]: upd };
    saveSeenRfc();
  };

  // Options for creating requests: departments list + working term.
  useEffect(() => {
    if (!activeDeptName) return;
    (async () => {
      try {
        const o = await getFSOptions({ requesterDepartment: activeDeptName });
        if (o?.ok) {
          setToDepts((o.departments || []).filter((d: string) => !eqDept(d, activeDeptName)) as string[]);
          updateTermLabelFromOptions(o);
          // If any draft "to" becomes invalid (e.g., dept changed), clear it.
          setDraftRows((prev) =>
            prev.map((r) => (r.to_department && eqDept(r.to_department, activeDeptName) ? { ...r, to_department: "" } : r))
          );
        }
      } catch {
        // ignore
      }
    })();
  }, [activeDeptName]);

  // Load faculty list per receiver dept
  async function ensureFacultyForDept(dept: string) {
    if (!dept || (facultyCache[dept] && facultyAvailabilityCache[dept])) return;
    try {
      const rawOptions = await getFSOptions({ toDepartment: dept as any });
      const o: any = rawOptions;
      const list: FacultyOption[] =
        (o?.facultyOptions || []).map((f: any) => ({
          faculty_id: f.faculty_id,
          first_name: f.first_name,
          last_name: f.last_name,
          email: f.email,
          label: facultyLabel(f),
        })) ?? [];
      setFacultyCache((prev) => ({ ...prev, [dept]: list }));
      setFacultyAvailabilityCache((prev) => ({ ...prev, [dept]: (o.facultyAvailability || {}) as FacultyAvailabilityMap }));
    } catch {
      // ignore
    }
  }

  // Determine if a row has an active (non-terminal) RFC thread.
  const computeRfcPending = (rfc: any): boolean => {
    if (!rfc) return false;
    if (Boolean(rfc.locked)) return false;
    const st = norm(String(rfc.status || ""));
    if (st === "approved" || st === "rejected") return false;
    // Any existing unlocked RFC is treated as pending.
    return true;
  };

  // Best-effort "last updated" timestamp for RFC threads.
  // Used to drive the red-dot unread indicator.
  const getRfcUpdatedAt = (rfc: any): string => {
    if (!rfc) return "";
    const cand =
      rfc.updated_at ||
      rfc.updatedAt ||
      rfc.updated ||
      rfc.last_updated_at ||
      rfc.lastUpdatedAt ||
      rfc.last_message_at ||
      rfc.lastMessageAt;
    if (cand) {
      try {
        // handle both Date objects and ISO strings
        const d = cand instanceof Date ? cand : new Date(String(cand));
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      } catch {
        // ignore
      }
    }

    const msgs = (rfc.messages || rfc.thread || []) as any[];
    const last = Array.isArray(msgs) && msgs.length ? msgs[msgs.length - 1] : null;
    const lastAt = last?.created_at || last?.createdAt;
    if (lastAt) {
      try {
        const d = lastAt instanceof Date ? lastAt : new Date(String(lastAt));
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      } catch {
        // ignore
      }
    }

    return "";
  };

  const getRfcLastSenderRole = (rfc: any): string => {
    if (!rfc) return "";
    const msgs = (rfc.messages || rfc.thread || []) as any[];
    const last = Array.isArray(msgs) && msgs.length ? msgs[msgs.length - 1] : null;
    return norm(String(last?.sender_role || last?.from || ""));
  };

  async function hydrateRfcPendingForReceived(receivedList: FacultyServiceRow[]) {
    if (!meUserId || !termId) return;
    const targets = (receivedList || [])
      .map((r) => {
        const sid = String((r as any)?.section_id || "").trim();
        const fid = String((r as any)?.faculty?.faculty_id || (r as any)?.faculty_id || "").trim();
        if (!sid || !fid) return null;
        return { sid, fid };
      })
      .filter(Boolean) as Array<{ sid: string; fid: string }>;

    if (!targets.length) return;

    // Always re-check RFC status for current Received rows so
    // new RFCs (false -> true) are reflected without requiring a full page refresh.
    const need = targets;

    // Small concurrency limiter to avoid spamming the backend.
    const limit = 6;
    const nextMap: Record<string, boolean> = {};
    const nextUpdated: Record<string, string> = {};
    const nextLastSender: Record<string, string> = {};

    for (let i = 0; i < need.length; i += limit) {
      const chunk = need.slice(i, i + limit);
      const results = await Promise.all(
        chunk.map(async ({ sid, fid }) => {
          try {
            const res = await getOmLoadAssignmentRfc(meUserId, {
              term_id: termId,
              faculty_id: fid,
              section_id: sid,
            });
            const pending = computeRfcPending(res?.rfc);
            const key = rfcKey(sid, fid);
            const upd = getRfcUpdatedAt(res?.rfc);
            const lastSender = getRfcLastSenderRole(res?.rfc);
            return { key, pending, updatedAt: upd, lastSender };
          } catch {
            return { key: rfcKey(sid, fid), pending: false, updatedAt: "", lastSender: "" };
          }
        })
      );
      for (const r of results) {
        nextMap[r.key] = r.pending;
        if (r.updatedAt) nextUpdated[r.key] = r.updatedAt;
        nextLastSender[r.key] = r.lastSender || "";
      }
    }

    if (Object.keys(nextMap).length) {
      setRfcPendingByKey((prev) => ({ ...prev, ...nextMap }));
    }
    if (Object.keys(nextUpdated).length) {
      setRfcUpdatedAtByKey((prev) => ({ ...prev, ...nextUpdated }));
    }
    if (Object.keys(nextLastSender).length) {
      setRfcLastSenderByKey((prev) => ({ ...prev, ...nextLastSender }));
    }
  }

  async function refreshSingleRfcPending(sectionId: string, facultyId: string) {
    if (!meUserId || !termId || !sectionId || !facultyId) return;
    try {
      const res = await getOmLoadAssignmentRfc(meUserId, {
        term_id: termId,
        faculty_id: facultyId,
        section_id: sectionId,
      });
      const key = rfcKey(sectionId, facultyId);
      const pending = computeRfcPending(res?.rfc);
      setRfcPendingByKey((prev) => ({ ...prev, [key]: pending }));
      const upd = getRfcUpdatedAt(res?.rfc);
      if (upd) setRfcUpdatedAtByKey((prev) => ({ ...prev, [key]: upd }));
      setRfcLastSenderByKey((prev) => ({ ...prev, [key]: getRfcLastSenderRole(res?.rfc) }));
    } catch {
      const key = rfcKey(sectionId, facultyId);
      setRfcPendingByKey((prev) => ({ ...prev, [key]: false }));
      setRfcLastSenderByKey((prev) => ({ ...prev, [key]: "" }));
    }
  }

  /**
   * Fetch BOTH boxes for the logged-in CHAIR's department.
   * - sent:   from_department === myDept
   * - received: to_department === myDept
   */
  async function refresh() {
    setLoadingList(true);
    try {
      if (!activeDeptName) return;
      const [sent, received] = await Promise.all([
        listFacultyService({ dept: activeDeptName, box: "sent" }),
        listFacultyService({ dept: activeDeptName, box: "received" }),
      ]);
      const sentList = (sent?.rows || []) as FacultyServiceRow[];
      const receivedList = (received?.rows || []) as FacultyServiceRow[];

      setSentRows(sentList);
      setReceivedRows(receivedList);

      // Populate RFC pending status for Received rows (Approve/Pending indicator).
      hydrateRfcPendingForReceived(receivedList).catch(() => {});

      // Prefill receiver-side edits from the latest server values so fields stay editable across status changes.
      setEdits((prev) => {
        const next = { ...prev };
        for (const r of receivedList) {
          const id = String((r as any)?.fs_id || (r as any)?.id || "");
          if (!id) continue;
          if (!next[id]) {
            next[id] = {
              faculty: (r as any)?.faculty || undefined,
              day1: ((r as any)?.day1 || "") as any,
              begin1: ((r as any)?.begin1 || "") as any,
              end1: ((r as any)?.end1 || "") as any,
              day2: ((r as any)?.day2 || "") as any,
              begin2: ((r as any)?.begin2 || "") as any,
              end2: ((r as any)?.end2 || "") as any,
              remarks: String((r as any)?.remarks || ""),
            };
          } else {
            next[id] = {
              ...next[id],
              remarks: typeof next[id].remarks === "string" ? next[id].remarks : String((r as any)?.remarks || ""),
            };
          }
        }
        return next;
      });

      // Determine whether there are any unseen received requests (by fs_id)
      const hasUnseen = receivedList.some((r) => {
        const id = r?.fs_id || r?.id;
        return !!id && !seenReceivedRef.current.has(String(id));
      });
      setHasNewReceived(hasUnseen);
    } finally {
      setLoadingList(false);
    }
  }

  // If termId arrives after the initial list load, we still need to hydrate RFC state.
  useEffect(() => {
    if (!termId || !meUserId) return;
    if (!receivedRows || receivedRows.length === 0) return;
    hydrateRfcPendingForReceived(receivedRows).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, meUserId, receivedRows]);

  // Course suggestions (Software Tech as requester)
  const [courseTerm, setCourseTerm] = useState("");
  const [courseSuggestions, setCourseSuggestions] = useState<Array<{ code: string; title: string; units?: number }>>([]);

  // Sections for selected course codes (from OM Load Assignment source: sections_submitted)
  // Cache by course_code so multiple draft rows can be supported.
  const [sectionOptionsByCode, setSectionOptionsByCode] = useState<
    Record<string, Array<{ section_id: string; section_code: string }>>
  >({});

  useEffect(() => {
    let mounted = true;
    if (!activeDeptName) {
      return () => {
        mounted = false;
      };
    }
    (async () => {
      try {
        const res = await getFSOptions({ q: courseTerm, requesterDepartment: activeDeptName });
        if (mounted && res?.ok) setCourseSuggestions(res.courses || []);
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, [courseTerm, activeDeptName]);

  const codeOptions = useMemo(
    () => Array.from(new Set((courseSuggestions || []).map((c) => c.code))).sort(),
    [courseSuggestions]
  );

  // Load sections for any selected course codes so each draft row can target a specific OM row.
  useEffect(() => {
    let mounted = true;
    if (!activeDeptName) return;

    const codes = Array.from(new Set(draftRows.map((r) => (r.course_code || "").trim()).filter(Boolean)));
    if (codes.length === 0) return;

    (async () => {
      for (const code of codes) {
        if (!mounted) return;
        if (sectionOptionsByCode[code]) continue;
        try {
          const res = await getFSOptions({ requesterDepartment: activeDeptName, courseCode: code });
          if (!mounted) return;
          const secs = (res?.sections || []) as Array<{ section_id: string; section_code: string }>;
          setSectionOptionsByCode((prev) => ({ ...prev, [code]: secs }));

          // Clear invalid section selections for this course.
          setDraftRows((prev) =>
            prev.map((r) => {
              if ((r.course_code || "").trim() !== code) return r;
              if (!r.section_id) return r;
              const ok = secs.some((s) => String(s.section_id) === String(r.section_id));
              return ok ? r : { ...r, section_id: "", section: "" };
            })
          );
        } catch {
          // ignore; keep empty options
          if (!mounted) return;
          setSectionOptionsByCode((prev) => ({ ...prev, [code]: [] }));
        }
      }
    })();

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftRows, activeDeptName, sectionOptionsByCode]);

  const canSendRow = (r: DraftRow) =>
    Boolean(r.course_code && r.section_id && r.course_title && r.units != null && r.to_department);

  function friendlyError(e: any) {
    const m = e?.response?.data?.detail || e?.response?.data?.message || e?.message || "Something went wrong.";
    return typeof m === "string" ? m : JSON.stringify(m);
  }

  /* ---------------- Minimal local POST helper (keeps this page self-contained) ----------------
     We intentionally use a relative '/api' prefix which matches the rest of the app's API
     calls (via '@/api') under typical dev/prod proxy setups.
  */
  async function apiPostJSON(path: string, body?: any) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    if (!res.ok || (data && data.ok === false)) {
      const msg = data?.detail || data?.message || `Request failed (${res.status})`;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data;
  }

  const FS_STATUS_OPTIONS = ["Pending", "Approved", "Rejected"] as const;
  const toFsStatusLabel = (s?: string) => (s === "responded" ? "Approved" : s === "rejected" ? "Rejected" : "Pending");
  const labelToFsStatus = (label: string) => (label === "Approved" ? "responded" : label === "Rejected" ? "rejected" : "sent");

  async function changeReceivedStatus(fsid: string, label: string, row: FacultyServiceRow) {
    try {
      const st = labelToFsStatus(label);
      const e = getEdit(fsid);

      if (st === "responded") {
        const facId = String(e?.faculty?.faculty_id || (row as any)?.faculty?.faculty_id || "").trim();
        if (!facId) {
          showToast({ type: "info", title: "Missing faculty", message: "Select a faculty before approving." });
          return;
        }

        const deptBusySlots = facultyAvailabilityCache[activeDeptName] || {};
        const approvalMeetings = buildMeetingSlots({
          day1: e.day1,
          begin1: e.begin1,
          end1: e.end1,
          day2: e.day2,
          begin2: e.begin2,
          end2: e.end2,
        });
        if (
          facultyHasConflictForMeetings({
            facultyId: facId,
            meetings: approvalMeetings,
            busySlots: deptBusySlots,
            excludeSectionId: String((row as any)?.section_id || "").trim(),
          })
        ) {
          showToast({ type: "info", title: "Faculty unavailable", message: "Selected faculty already has a conflicting load assignment for the chosen day/time." });
          return;
        }

        // Require schedule fields before approving (matches UI asterisks)
        const missing: string[] = [];
        if (!e.day1) missing.push("Day1");
        if (!e.begin1) missing.push("Begin1");
        if (!e.end1) missing.push("End1");
        if (!e.day2) missing.push("Day2");
        if (!e.begin2) missing.push("Begin2");
        if (!e.end2) missing.push("End2");
        if (missing.length) {
          showToast({
            type: "info",
            title: "Missing schedule",
            message: `Fill required fields: ${missing.join(", ")}.`,
          });
          return;
        }

        await apiPostJSON(`/api/chair/faculty-service/respond/${encodeURIComponent(fsid)}?userId=${encodeURIComponent(meUserId)}`, {
          faculty: {
            faculty_id: facId,
            first_name: e?.faculty?.first_name || (row as any)?.faculty?.first_name,
            last_name: e?.faculty?.last_name || (row as any)?.faculty?.last_name,
            email: e?.faculty?.email || (row as any)?.faculty?.email,
          },
          day1: e.day1,
          begin1: e.begin1,
          end1: e.end1,
          day2: e.day2,
          begin2: e.begin2,
          end2: e.end2,
          remarks: e.remarks,
        });

        showToast({ type: "success", message: "Request approved." });
      } else if (st === "rejected") {
        await apiPostJSON(`/api/chair/faculty-service/reject/${encodeURIComponent(fsid)}?userId=${encodeURIComponent(meUserId)}`, {
          remarks: e.remarks,
        });
        showToast({ type: "success", message: "Request rejected." });
      } else {
        // Pending (sent) — allow reverting anytime.
        await apiPostJSON(`/api/chair/faculty-service/restore/${encodeURIComponent(fsid)}`, {
          status: "sent",
        });
        showToast({ type: "success", message: "Status set to pending." });
      }

      await refresh();
    } catch (err: any) {
      showToast({ type: "error", title: "Update failed", message: friendlyError(err) });
    }
  }

  async function handleCreateAndSend() {
    try {
      const selected = draftRows.filter((r) => (selectedDraftIds[r._tmpId] ?? true));
      if (selected.length === 0) {
        showToast({ type: "info", title: "Nothing selected", message: "Tick at least one row to send." });
        return;
      }

      const invalidIdx = selected.findIndex((r) => !canSendRow(r));
      if (invalidIdx >= 0) {
        showToast({
          type: "info",
          title: "Missing details",
          message: `Please complete required fields on Row ${invalidIdx + 1} (Course, Section, Units, and To Department).`,
        });
        return;
      }

      const newSent: FacultyServiceRow[] = [];
      for (const row of selected) {
        const crt = await createFacultyService({
          course_code: row.course_code,
          section_id: row.section_id,
          section: row.section,
          course_title: row.course_title,
          units: row.units,
          to_department: row.to_department as any,
          remarks: row.remarks,
          from_department: activeDeptName,
        });
        if (!crt?.ok || !crt.row?.fs_id) {
          showToast({ type: "error", title: "Create failed", message: "Failed to create request." });
          return;
        }
        const snd = await sendFacultyService(crt.row.fs_id);
        if (snd?.row) newSent.push(snd.row);
      }

      if (newSent.length) setSentRows((prev) => [...newSent, ...prev]);

      setDraftRows([makeDraftRow()]);
      setSelectedDraftIds({});
      setCourseTerm("");

      await refresh();
      showToast({ type: "success", message: selected.length === 1 ? "Request sent." : "Requests sent." });
    } catch (e: any) {
      showToast({ type: "error", title: "Request failed", message: friendlyError(e) });
    }
  }

  // Preload faculty (for receiver departments only) and reset edits
  // whenever the logged-in CHAIR's department "role" changes.
  useEffect(() => {
    setEdits({});
    // Receiver actions use faculty dropdown for my department.
    if (activeDeptName) ensureFacultyForDept(activeDeptName);
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDeptName]);
  
  // Sent list: keep "most recent" at the bottom (oldest -> newest)
  const mySentRows = useMemo(() => {
    const rows = (sentRows || []).filter((r) => eqDept(r.from_department, activeDeptName));
    return rows.slice().reverse();
  }, [sentRows, activeDeptName]);

  // Undo/Redo button enablement (uses historyTick to keep lint happy and force rerenders)
  const canUndoReceived = historyTick >= 0 && undoRef.current.length > 0;
  const canRedoReceived = historyTick >= 0 && redoRef.current.length > 0;

  // Shared search across Sent + Received lists (draft row stays visible)
  const [tableSearch, setTableSearch] = useState("");
  const [debouncedTableSearch, setDebouncedTableSearch] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedTableSearch(tableSearch.trim()), 250);
    return () => window.clearTimeout(t);
  }, [tableSearch]);

  const q = useMemo(() => norm(debouncedTableSearch), [debouncedTableSearch]);

  const rowMatches = (r: FacultyServiceRow) => {
    if (!q) return true;
    const fac: any = (r as any)?.faculty || {};
    const parts = [
      r.course_code,
      r.course_title,
      r.section,
      r.from_department,
      r.to_department,
      facultyLabel(fac),
      fac.email,
      (r as any)?.faculty_name,
      (r as any)?.remarks,
    ];
    return parts.some((p) => norm(String(p || "")).includes(q));
  };

  const filteredSentRows = useMemo(() => (q ? mySentRows.filter(rowMatches) : mySentRows), [mySentRows, q]);
  const sortedReceivedRows = useMemo(() => {
    const rows = [...receivedRows];
    return rows.sort((a, b) => {
      const aApproved = toFsStatusLabel((a as any)?.status) === "Approved" ? 1 : 0;
      const bApproved = toFsStatusLabel((b as any)?.status) === "Approved" ? 1 : 0;
      return aApproved - bApproved;
    });
  }, [receivedRows]);

  const filteredReceivedRows = useMemo(
    () => (q ? sortedReceivedRows.filter(rowMatches) : sortedReceivedRows),
    [sortedReceivedRows, q]
  );

  useEffect(() => {
    setCollapsedReceivedRows((prev) => {
      const next: Record<string, boolean> = {};
      const seen = new Set<string>();
      let changed = false;

      for (const row of receivedRows) {
        const fsid = String((row as any)?.fs_id || (row as any)?.id || "").trim();
        if (!fsid) continue;
        seen.add(fsid);

        const isApproved = toFsStatusLabel((row as any)?.status) === "Approved";
        if (Object.prototype.hasOwnProperty.call(prev, fsid)) {
          next[fsid] = prev[fsid];
        } else {
          next[fsid] = isApproved;
          changed = true;
        }

        if (isApproved && !autoCollapsedReceivedRef.current[fsid]) {
          if (!next[fsid]) {
            next[fsid] = true;
            changed = true;
          }
          autoCollapsedReceivedRef.current[fsid] = true;
        }
      }

      Object.keys(autoCollapsedReceivedRef.current).forEach((fsid) => {
        if (!seen.has(fsid)) delete autoCollapsedReceivedRef.current[fsid];
      });

      if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev;
      return next;
    });
  }, [receivedRows]);


/* ---------------- UI ---------------- */
  return (
    <div
      className={cls(
        "w-full text-slate-900",
        variant !== "embedded" && "min-h-screen bg-gray-50"
      )}
    >
      <ToastViewport items={toasts} onClose={closeToast} />

      {variant !== "embedded" ? (
        <div className="bg-white px-8 pt-8">
          <header className="mb-4">
            <h1 className="text-2xl font-bold">Faculty Service</h1>
            <p className="text-sm text-gray-600">
              Create &amp; send faculty service requests, track request status, and respond to received requests.
              {termLabel ? ` for ${termLabel}` : ""}
            </p>
          </header>
        </div>
      ) : (
        <header className="mb-6">
          <h1 className="text-2xl font-bold">Faculty Service</h1>
          <p className="text-sm text-gray-600">
            Create &amp; send faculty service requests, track request status, and respond to received requests.
            {termLabel ? ` for ${termLabel}` : ""}
          </p>
        </header>
      )}

      <main className={cls("w-full pb-24 space-y-8", variant !== "embedded" && "px-8")}>


        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                className={cls(
                  "w-full h-10 rounded-lg border border-gray-300 bg-white pl-9 pr-10 text-sm shadow-sm",
                  "focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300"
                )}
                placeholder="Search by course, section, department, or faculty…"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
              />
              {tableSearch && (
                <button
                  type="button"
                  onClick={() => setTableSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        <SectionShell
          title="Create Request & Sent Requests"
          subtitle="Create request, then review previously sent requests."
          actions={(
            <>
              <button
                type="button"
                onClick={addDraftRow}
                className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-white/20"
                title="Add another request row"
              >
                <Plus className="h-4 w-4" />
                Add Class
              </button>

              <button
                type="button"
                onClick={handleCreateAndSend}
                className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-emerald-800 shadow-sm transition hover:bg-emerald-50"
                title="Send selected requests"
              >
                <Send className="h-4 w-4" />
                Send Selected
              </button>
            </>
          )}
        >
          <div className="space-y-4">
            {draftRows.map((r) => {
              const checked = selectedDraftIds[r._tmpId] ?? true;
              const secs = sectionOptionsByCode[(r.course_code || "").trim()] || [];
              const sectionCodes = Array.from(new Set(secs.map((s) => s.section_code))).sort();
              const sectionDisabled = !r.course_code || sectionCodes.length === 0;

              return (
                <div key={r._tmpId} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="flex items-start gap-3">
                      <label className="mt-1 inline-flex items-center gap-2 text-sm font-medium text-gray-700">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-emerald-600"
                          checked={checked}
                          onChange={(e) => {
                            const v = e.target.checked;
                            setSelectedDraftIds((prev) => ({ ...prev, [r._tmpId]: v }));
                          }}
                          aria-label="Select row to send"
                        />
                        Select
                      </label>
                    </div>

                    <div className="flex items-center gap-2 self-start">
                      <StatusChip label="Draft" />
                      <button
                        type="button"
                        onClick={() => removeDraftRow(r._tmpId)}
                        className="inline-flex items-center justify-center rounded-lg border border-red-200 bg-red-50 p-2 text-red-600 transition hover:bg-red-100"
                        title="Delete draft row"
                        aria-label="Delete draft row"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-12">
                    <div className="xl:col-span-4">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Course Code &amp; Title <span className="text-red-600">*</span></div>
                      <div className="mt-1">
                        <Dropdown
                          value={r.course_code}
                          onChange={(code) => {
                            const hit = courseSuggestions.find((c) => c.code === code);
                            updateDraftRow(r._tmpId, {
                              course_code: code,
                              section_id: "",
                              section: "",
                              course_title: hit?.title ?? "",
                              units: hit?.units ?? null,
                            });
                            setCourseTerm("");
                          }}
                          options={codeOptions}
                          placeholder="— Select Course —"
                          searchable
                          className="w-full"
                          onOpen={() => setCourseTerm("")}
                        />
                      </div>
                      <div className="mt-2 min-h-[20px] text-sm text-gray-600">{r.course_title || "—"}</div>
                    </div>

                    <div className="xl:col-span-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Section <span className="text-red-600">*</span></div>
                      <div className="mt-1">
                        <Dropdown
                          value={r.section}
                          onChange={(sec) => {
                            const hit = secs.find((s) => s.section_code === sec);
                            updateDraftRow(r._tmpId, { section: sec, section_id: hit?.section_id || "" });
                          }}
                          options={sectionCodes}
                          placeholder="— Select —"
                          className="w-full"
                          searchable={false}
                          disabled={sectionDisabled}
                        />
                      </div>
                    </div>

                    <div className="xl:col-span-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Units</div>
                      <div className="mt-1">
                        <div className={cls(CONTROL, "flex h-10 items-center bg-gray-50 text-gray-700")}>{r.units ?? "—"}</div>
                      </div>
                    </div>

                    <div className="xl:col-span-4">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">To Department <span className="text-red-600">*</span></div>
                      <div className="mt-1">
                        <Dropdown
                          value={r.to_department}
                          onChange={(v) => updateDraftRow(r._tmpId, { to_department: v })}
                          options={toDepts}
                          placeholder="— Select Department —"
                          className="w-full"
                          searchable={false}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 space-y-3">
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Remarks</div>
                      <input
                        className={cls(CONTROL, "mt-1 w-full")}
                        value={r.remarks}
                        onChange={(ev) => updateDraftRow(r._tmpId, { remarks: ev.target.value })}
                        placeholder="Remarks…"
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="space-y-4">
              {loadingList && (
                <div className="rounded-2xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500 shadow-sm">
                  Loading…
                </div>
              )}

              {!loadingList && mySentRows.length === 0 && (
                <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500 shadow-sm">
                  No sent requests yet.
                </div>
              )}

              {!loadingList && mySentRows.length > 0 && filteredSentRows.length === 0 && !!q && (
                <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500 shadow-sm">
                  No matches found.
                </div>
              )}

              {filteredSentRows.map((r) => {
                const label = r.status === "responded" ? "Approved" : r.status === "rejected" ? "Rejected" : "Pending";
                const fid = String((r as any)?.faculty?.faculty_id || "");
                const sid = String((r as any)?.section_id || "");

                return (
                  <div key={r.fs_id} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div>
                        <div className="text-lg font-semibold text-emerald-700">{r.course_code || "—"}</div>
                        <div className="text-sm text-gray-600">{r.course_title || "—"}</div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 self-start">
                        <button
                          type="button"
                          aria-label="Message"
                          disabled={!termId || !sid || !fid}
                          onClick={() => {
                            if (!fid || !sid) return;
                            setRfcModal({
                              open: true,
                              facultyId: fid,
                              facultyName: facultyLabel((r as any)?.faculty) || "Faculty",
                              sectionId: sid,
                            });
                          }}
                          className={cls(
                            "inline-flex items-center justify-center rounded-lg border border-blue-200 bg-blue-50 p-2 text-blue-700 transition hover:bg-blue-100",
                            (!termId || !sid || !fid) && "cursor-not-allowed opacity-50 hover:bg-blue-50"
                          )}
                          title={!termId || !sid || !fid ? "Assign a faculty first to open conversation" : "Message"}
                        >
                          <MessageSquareText className="h-4 w-4" />
                        </button>
                        <StatusChip label={label} />
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                      <FieldTile label="Section" value={r.section || "—"} />
                      <FieldTile label="Units" value={r.units ?? "—"} />
                      <FieldTile label="To Department" value={r.to_department || "—"} />
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                      <FieldTile
                        label="Faculty"
                        value={
                          facultyLabel((r as any)?.faculty) || (
                            <span className="inline-flex items-center rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
                              Awaiting assignment
                            </span>
                          )
                        }
                      />
                      <FieldTile
                        label="Schedule"
                        value={
                          <ScheduleSummary
                            day1={(r as any)?.day1}
                            begin1={(r as any)?.begin1}
                            end1={(r as any)?.end1}
                            day2={(r as any)?.day2}
                            begin2={(r as any)?.begin2}
                            end2={(r as any)?.end2}
                            emptyLabel="Awaiting receiver response"
                          />
                        }
                      />
                      <FieldTile label="Remarks" value={r.remarks || "—"} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </SectionShell>

        <SectionShell
          title="Received Requests"
          subtitle="Review incoming requests, assign faculty, set schedule details, then approve, reject, or keep them pending."
          accent="slate"
          actions={(
            <>
              {hasNewReceived && (
                <span
                  className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-900"
                  title="New requests received"
                >
                  New
                </span>
              )}
              <button
                type="button"
                onClick={() => undoEdit()}
                disabled={!canUndoReceived}
                className={cls(
                  "inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/10 p-2 text-white transition hover:bg-white/20",
                  !canUndoReceived && "cursor-not-allowed opacity-50 hover:bg-white/10"
                )}
                title="Undo (Ctrl/Cmd+Z)"
                aria-label="Undo"
              >
                <Undo2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => redoEdit()}
                disabled={!canRedoReceived}
                className={cls(
                  "inline-flex items-center justify-center rounded-lg border border-white/15 bg-white/10 p-2 text-white transition hover:bg-white/20",
                  !canRedoReceived && "cursor-not-allowed opacity-50 hover:bg-white/10"
                )}
                title="Redo (Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z)"
                aria-label="Redo"
              >
                <Redo2 className="h-4 w-4" />
              </button>
            </>
          )}
        >
          <div className="space-y-4">
            {loadingList && (
              <div className="rounded-2xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500 shadow-sm">
                Loading…
              </div>
            )}

            {!loadingList && receivedRows.length === 0 && (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500 shadow-sm">
                No received requests for your department.
              </div>
            )}

            {!loadingList && receivedRows.length > 0 && filteredReceivedRows.length === 0 && !!q && (
              <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500 shadow-sm">
                No matches found.
              </div>
            )}

            {filteredReceivedRows.map((r) => {
              const fsid = r.fs_id!;
              const dept = r.to_department || "";
              const e = getEdit(fsid);
              const facultyOptions = facultyCache[dept] || [];
              const facultyBusySlots = facultyAvailabilityCache[dept] || {};
              const sectionId = String((r as any)?.section_id || "").trim();
              const selectedFacultyId = String(e.faculty?.faculty_id || (r as any)?.faculty?.faculty_id || "").trim();
              const peerMeetings = buildMeetingSlots({
                day1: e.day1,
                begin1: e.begin1,
                end1: e.end1,
                day2: e.day2,
                begin2: e.begin2,
                end2: e.end2,
              });
              const availableFacultyOptions = facultyOptions.filter((f) =>
                !facultyHasConflictForMeetings({
                  facultyId: f.faculty_id,
                  meetings: peerMeetings,
                  busySlots: facultyBusySlots,
                  excludeSectionId: sectionId,
                })
              );
              const facultyOptionsForDropdown = availableFacultyOptions.map((f) => f.label).filter(Boolean);
              const slot1PeerMeetings = peerMeetings.filter((m) => m.slot !== 1);
              const slot2PeerMeetings = peerMeetings.filter((m) => m.slot !== 2);
              const availableDay1Options = DAY1_OPTIONS.filter((day) =>
                slotOptionIsAvailable({
                  facultyId: selectedFacultyId,
                  slot: 1,
                  day,
                  begin: e.begin1 || "",
                  peerMeetings: slot1PeerMeetings,
                  busySlots: facultyBusySlots,
                  excludeSectionId: sectionId,
                })
              );
              const availableBegin1Options = timeBegins.filter((begin) =>
                slotOptionIsAvailable({
                  facultyId: selectedFacultyId,
                  slot: 1,
                  day: e.day1 || "",
                  begin,
                  peerMeetings: slot1PeerMeetings,
                  busySlots: facultyBusySlots,
                  excludeSectionId: sectionId,
                })
              );
              const availableDay2Options = DAY1_OPTIONS.filter((day) =>
                slotOptionIsAvailable({
                  facultyId: selectedFacultyId,
                  slot: 2,
                  day,
                  begin: e.begin2 || "",
                  peerMeetings: slot2PeerMeetings,
                  busySlots: facultyBusySlots,
                  excludeSectionId: sectionId,
                })
              );
              const availableBegin2Options = timeBegins.filter((begin) =>
                slotOptionIsAvailable({
                  facultyId: selectedFacultyId,
                  slot: 2,
                  day: e.day2 || "",
                  begin,
                  peerMeetings: slot2PeerMeetings,
                  busySlots: facultyBusySlots,
                  excludeSectionId: sectionId,
                })
              );
              //const selectedFacultyAvailable = !selectedFacultyId || availableFacultyOptions.some((f) => f.faculty_id === selectedFacultyId);
              //const noFacultyAvailable = peerMeetings.length > 0 && availableFacultyOptions.length === 0;
              const noSlot1Options = !!selectedFacultyId && ((!!e.begin1 && availableDay1Options.length === 0) || (!!e.day1 && availableBegin1Options.length === 0));
              const noSlot2Options = !!selectedFacultyId && ((!!e.begin2 && availableDay2Options.length === 0) || (!!e.day2 && availableBegin2Options.length === 0));
              const sid = sectionId;
              const fid = selectedFacultyId;
              const rkey = sid && fid ? rfcKey(sid, fid) : "";
              const pendingRfc = rkey ? Boolean(rfcPendingByKey[rkey]) : false;
              const curStatusLabel = toFsStatusLabel((r as any)?.status);
              const isCollapsed = Boolean(collapsedReceivedRows[fsid]);
              const assignedFacultyLabel =
                (e.faculty?.faculty_id
                  ? facultyOptions.find((f) => f.faculty_id === e.faculty?.faculty_id)?.label || ""
                  : facultyLabel(e.faculty)) || facultyLabel((r as any)?.faculty) || "—";

              return (
                <div key={fsid} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm" onMouseEnter={() => ensureFacultyForDept(dept)}>
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div>
                      <div className="text-lg font-semibold text-emerald-700">{r.course_code || "—"}</div>
                      <div className="text-sm text-gray-600">{r.course_title || "—"}</div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 self-start">
                      <button
                        type="button"
                        aria-label="Message"
                        disabled={!termId || !r.section_id || !(e.faculty?.faculty_id || (r as any)?.faculty?.faculty_id)}
                        onClick={() => {
                          const modalFacultyId = String(e.faculty?.faculty_id || (r as any)?.faculty?.faculty_id || "");
                          const sid2 = String(r.section_id || "");
                          if (!modalFacultyId || !sid2) return;

                          try {
                            markRfcSeen(rfcKey(sid2, modalFacultyId));
                          } catch {}

                          try {
                            if (fsid) {
                              seenReceivedRef.current.add(String(fsid));
                              saveSeenReceived();
                              setHasNewReceived(receivedRows.some((x) => {
                                const id = x?.fs_id || (x as any)?.id;
                                return !!id && !seenReceivedRef.current.has(String(id));
                              }));
                            }
                          } catch {}

                          setRfcModal({
                            open: true,
                            facultyId: modalFacultyId,
                            facultyName: facultyLabel(e.faculty) || facultyLabel((r as any)?.faculty) || "Faculty",
                            sectionId: sid2,
                            fsId: String(fsid),
                          });
                        }}
                        className={cls(
                          "relative inline-flex items-center justify-center rounded-lg border border-blue-200 bg-blue-50 p-2 text-blue-700 transition hover:bg-blue-100",
                          (!termId || !r.section_id || !(e.faculty?.faculty_id || (r as any)?.faculty?.faculty_id)) &&
                            "cursor-not-allowed opacity-50 hover:bg-blue-50"
                        )}
                        title={(!termId || !r.section_id || !(e.faculty?.faculty_id || (r as any)?.faculty?.faculty_id)) ? "Select a faculty first to open conversation" : "Message"}
                      >
                        <span className="relative inline-flex">
                          <MessageSquareText className="h-4 w-4" />
                          {pendingRfc && rkey && isRfcUnseen(rkey) && (
                            <span
                              className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-600 ring-2 ring-white"
                              aria-label="New RFC"
                              title="New RFC"
                            />
                          )}
                        </span>
                      </button>
                      <div className="min-w-[148px]">
                        <Dropdown
                          value={curStatusLabel}
                          onChange={(v) => void changeReceivedStatus(fsid, String(v), r)}
                          options={[...FS_STATUS_OPTIONS] as any}
                          placeholder="Pending"
                          className="w-full"
                          searchable={false}
                          tone="status"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setCollapsedReceivedRows((prev) => ({ ...prev, [fsid]: !prev[fsid] }));
                        }}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                        aria-expanded={!isCollapsed}
                        aria-controls={`received-request-${fsid}`}
                        title={isCollapsed ? "Expand request" : "Collapse request"}
                      >
                        <ChevronDown className={cls("h-4 w-4 transition-transform", isCollapsed ? "-rotate-90" : "rotate-0")} />
                        {isCollapsed ? "" : ""}
                      </button>
                    </div>
                  </div>

                  {isCollapsed ? (
                    <div id={`received-request-${fsid}`} className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <FieldTile label="Section" value={r.section || "—"} />
                      <FieldTile label="From Department" value={r.from_department || "—"} />
                      <FieldTile label="Faculty" value={assignedFacultyLabel} />
                      <FieldTile
                        label="Schedule"
                        value={
                          <ScheduleSummary
                            day1={e.day1 || (r as any)?.day1}
                            begin1={e.begin1 || (r as any)?.begin1}
                            end1={e.end1 || (r as any)?.end1}
                            day2={e.day2 || (r as any)?.day2}
                            begin2={e.begin2 || (r as any)?.begin2}
                            end2={e.end2 || (r as any)?.end2}
                            emptyLabel="No schedule assigned"
                          />
                        }
                      />
                    </div>
                  ) : (
                  <div id={`received-request-${fsid}`}>
                  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <FieldTile label="Section" value={r.section || "—"} />
                    <FieldTile label="Units" value={r.units ?? "—"} />
                    <FieldTile label="From Department" value={r.from_department || "—"} />
                    <div className={INFO_TILE}>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Faculty <span className="text-red-600">*</span></div>
                      <div className="mt-1">
                        <Dropdown
                          value={
                            e.faculty?.faculty_id
                              ? facultyOptions.find((f) => f.faculty_id === e.faculty?.faculty_id)?.label || ""
                              : facultyLabel(e.faculty)
                          }
                          onChange={(label) => {
                            const match = availableFacultyOptions.find((f) => f.label === label);
                            if (match) {
                              patchEdit(fsid, {
                                faculty: {
                                  faculty_id: match.faculty_id,
                                  first_name: match.first_name,
                                  last_name: match.last_name,
                                  email: match.email,
                                },
                              });
                            }
                          }}
                          options={facultyOptionsForDropdown}
                          placeholder={facultyOptions.length ? (facultyOptionsForDropdown.length ? "— Select Faculty —" : "No available faculty") : "Loading…"}
                          searchable
                        />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-2xl border border-gray-200 bg-gray-50 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-gray-900">Schedule Details</div>
                        <div className="text-xs text-gray-500">Set the faculty schedule before approving the request. Availability updates in real time based on existing load assignments.</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                      <div className={INFO_TILE}>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Day 1 <span className="text-red-600">*</span></div>
                        <div className="mt-1">
                          <Dropdown
                            value={e.day1 || ""}
                            onChange={(val) => {
                              const d1 = val as DayShort | "";
                              const nextDay2 = d1 ? (DAY2_BY_DAY1[d1 as DayShort] as DayShort) : "";
                              const nextPatch: Partial<ReceiverEdit> = { day1: d1, day2: nextDay2 };
                              if (
                                selectedFacultyId &&
                                e.begin2 &&
                                nextDay2 &&
                                !slotOptionIsAvailable({
                                  facultyId: selectedFacultyId,
                                  slot: 2,
                                  day: nextDay2,
                                  begin: e.begin2 || "",
                                  peerMeetings: slot2PeerMeetings,
                                  busySlots: facultyBusySlots,
                                  excludeSectionId: sectionId,
                                })
                              ) {
                                nextPatch.begin2 = "";
                                nextPatch.end2 = "";
                              }
                              if (
                                selectedFacultyId &&
                                e.begin1 &&
                                d1 &&
                                !slotOptionIsAvailable({
                                  facultyId: selectedFacultyId,
                                  slot: 1,
                                  day: d1,
                                  begin: e.begin1 || "",
                                  peerMeetings: slot1PeerMeetings,
                                  busySlots: facultyBusySlots,
                                  excludeSectionId: sectionId,
                                })
                              ) {
                                nextPatch.begin1 = "";
                                nextPatch.end1 = "";
                              }
                              patchEdit(fsid, nextPatch);
                            }}
                            options={selectedFacultyId ? availableDay1Options : [...DAY1_OPTIONS]}
                            placeholder="— Select —"
                            searchable={false}
                          />
                        </div>
                      </div>

                      <div className={INFO_TILE}>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Begin 1 <span className="text-red-600">*</span></div>
                        <div className="mt-1">
                          <Dropdown
                            value={e.begin1 || ""}
                            onChange={(val) => {
                              const v = val;
                              patchEdit(fsid, {
                                begin1: v,
                                end1: v ? END_BY_BEGIN[v as keyof typeof END_BY_BEGIN] : "",
                              });
                            }}
                            options={selectedFacultyId ? availableBegin1Options : timeBegins}
                            placeholder="— Select —"
                            searchable={false}
                          />
                        </div>
                      </div>

                      <div className={INFO_TILE}>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">End 1 <span className="text-red-600">*</span></div>
                        <div className="mt-1">
                          <Dropdown
                            value={e.end1 || ""}
                            onChange={(v) => patchEdit(fsid, { end1: v })}
                            options={e.begin1 ? [END_BY_BEGIN[e.begin1 as keyof typeof END_BY_BEGIN]].filter(Boolean) : Array.from(new Set(Object.values(END_BY_BEGIN)))}
                            placeholder="— Select —"
                            searchable={false}
                          />
                        </div>
                      </div>

                      <div className={INFO_TILE}>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Day 2 <span className="text-red-600">*</span></div>
                        <div className="mt-1">
                          <Dropdown
                            value={e.day2 || ""}
                            onChange={(v) => {
                              const nextDay2 = v as DayShort | "";
                              const nextPatch: Partial<ReceiverEdit> = { day2: nextDay2 };
                              if (
                                selectedFacultyId &&
                                e.begin2 &&
                                nextDay2 &&
                                !slotOptionIsAvailable({
                                  facultyId: selectedFacultyId,
                                  slot: 2,
                                  day: nextDay2,
                                  begin: e.begin2 || "",
                                  peerMeetings: slot2PeerMeetings,
                                  busySlots: facultyBusySlots,
                                  excludeSectionId: sectionId,
                                })
                              ) {
                                nextPatch.begin2 = "";
                                nextPatch.end2 = "";
                              }
                              patchEdit(fsid, nextPatch);
                            }}
                            options={selectedFacultyId ? availableDay2Options : [...DAY1_OPTIONS]}
                            placeholder="— Select —"
                            searchable={false}
                          />
                        </div>
                      </div>

                      <div className={INFO_TILE}>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Begin 2 <span className="text-red-600">*</span></div>
                        <div className="mt-1">
                          <Dropdown
                            value={e.begin2 || ""}
                            onChange={(val) => {
                              const v = val;
                              patchEdit(fsid, {
                                begin2: v,
                                end2: v ? END_BY_BEGIN[v as keyof typeof END_BY_BEGIN] : "",
                              });
                            }}
                            options={selectedFacultyId ? availableBegin2Options : timeBegins}
                            placeholder="— Select —"
                            searchable={false}
                          />
                        </div>
                      </div>

                      <div className={INFO_TILE}>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">End 2 <span className="text-red-600">*</span></div>
                        <div className="mt-1">
                          <Dropdown
                            value={e.end2 || ""}
                            onChange={(v) => patchEdit(fsid, { end2: v })}
                            options={e.begin2 ? [END_BY_BEGIN[e.begin2 as keyof typeof END_BY_BEGIN]].filter(Boolean) : Array.from(new Set(Object.values(END_BY_BEGIN)))}
                            placeholder="— Select —"
                            searchable={false}
                          />
                        </div>
                      </div>
                    </div>
                    {(noSlot1Options || noSlot2Options) && (
                      <div className="mt-3 text-xs text-amber-700">
                        No available {noSlot1Options && noSlot2Options ? 'time slots for the selected faculty' : noSlot1Options ? 'Day 1 / Time 1 options for the selected faculty' : 'Day 2 / Time 2 options for the selected faculty'}.
                      </div>
                    )}
                  </div>

                  <div className="mt-3">
                    <div className={INFO_TILE}>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Remarks</div>
                      <input
                        value={e.remarks}
                        onChange={(ev) => patchEdit(fsid, { remarks: ev.target.value })}
                        placeholder="Enter remarks…"
                        className={cls(CONTROL, "mt-1")}
                      />
                    </div>
                  </div>
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        </SectionShell>

        {/* RFC / Message thread (mirrors OM Load Assignment) */}
        <ServiceRfcModal
          open={!!rfcModal?.open}
          onClose={() => setRfcModal(null)}
          userId={meUserId}
          termId={termId}
          facultyId={rfcModal?.facultyId}
          facultyName={rfcModal?.facultyName}
          sectionId={rfcModal?.sectionId}
          onAfterUpdate={async (decision) => {
            await refresh();
            if (rfcModal?.sectionId && rfcModal?.facultyId) {
              await refreshSingleRfcPending(rfcModal.sectionId, rfcModal.facultyId);
            }

            // If approved, apply the RFC's requested schedule to the Received row immediately
            // (backend already reflects it on the FACULTY side; this keeps the mirror table in sync).
            if (decision === "approve" && rfcModal?.sectionId && rfcModal?.facultyId && rfcModal?.fsId) {
              try {
                const res = await getOmLoadAssignmentRfc(meUserId, {
                  term_id: termId,
                  faculty_id: rfcModal.facultyId,
                  section_id: rfcModal.sectionId,
                });
                const req = (res as any)?.rfc?.requested;
                if (req && typeof req === "object") {
                  const t1 = splitTimeRange(String(req.time1 || ""));
                  const t2 = splitTimeRange(String(req.time2 || ""));
                  patchEdit(String(rfcModal.fsId), {
                    day1: normalizeDayShort(String(req.day1 || "")) as any,
                    begin1: (t1.begin || "") as any,
                    end1: (t1.end || "") as any,
                    day2: normalizeDayShort(String(req.day2 || "")) as any,
                    begin2: (t2.begin || "") as any,
                    end2: (t2.end || "") as any,
                  });
                }
              } catch {
                // ignore (best-effort UI sync)
              }
            }
          }}
          onToast={showToast}
        />
      </main>
    </div>
  );
}