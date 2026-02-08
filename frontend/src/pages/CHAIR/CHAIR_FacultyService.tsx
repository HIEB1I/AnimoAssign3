// frontend/src/pages/CHAIR/CHAIR_FacultyService.tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Send, Check, ChevronDown, X, CheckCircle2, AlertCircle, Info, Undo2, Redo2 } from "lucide-react";
import {
  getFSOptions,
  listFacultyService,
  createFacultyService,
  sendFacultyService,
  respondFacultyService,
  rejectFacultyService,
  type FacultyServiceRow,
  type DayShort,
  getChairHeader,
} from "@/api";
import Tabs from "../../component/Tabs";

/* ---------------- tiny utils ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const norm = (s?: string) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
const eqDept = (a?: string, b?: string) => norm(a) === norm(b);

/* ---------------- received-tab new indicator (client-side) ----------------
   We mark requests as "seen" once the chair opens the Received Requests tab.
   Any unseen fs_id will trigger a red-dot indicator on the tab label.
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

/** unify control heights */
const CONTROL =
  "h-10 w-full rounded-md border border-gray-300 px-3 text-[13px] shadow-sm focus:ring-2 focus:ring-emerald-500/30";

/* ---------------- Plantilla table design system (source of truth) ---------------- */
const PLANTILLA_TABLE_WRAP =
  "rounded-xl border border-gray-300 bg-white shadow-sm overflow-x-auto overflow-y-auto";

const PLANTILLA_TABLE =
  "min-w-full w-full text-sm table-fixed border-collapse leading-snug [&_td]:align-top [&_td]:whitespace-normal [&_td]:break-words";

// NOTE: keep sticky headers *below* global overlays (e.g., topbar notifications)
const PLANTILLA_THEAD = "bg-gray-50 text-emerald-800 sticky top-0 z-[1] text-xs";
const PLANTILLA_HEAD_TR = "whitespace-nowrap text-[13px] font-semibold";

const PLANTILLA_TH = "px-3 py-2 text-center border border-gray-300";
const PLANTILLA_TD = "px-3 py-2 text-center";
const PLANTILLA_ROW = "hover:bg-gray-50 [&>td]:border [&>td]:border-gray-200";
const PLANTILLA_SECTION_TITLE =
  "px-5 py-3 text-sm font-semibold text-white text-center bg-emerald-700";

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
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  searchable?: boolean;
  align?: "left" | "right";
  onOpen?: () => void;
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
    const estMenuH = Math.min(48 + shown.length * 36, Math.floor(vh * 0.6));
    const roomBelow = vh - r.bottom;
    const place: "down" | "up" = roomBelow >= estMenuH || r.top < estMenuH ? "down" : "up";
    const width = Math.max(r.width, 220);
    const left = Math.max(
      8,
      Math.min(vw - width - 8, align === "right" ? r.right - width : r.left)
    );
    const top = place === "down" ? Math.min(vh - 8, r.bottom + 8) : Math.max(8, r.top - 8);
    setMenuRect({ left, top, width, place });
  };

  const menuId = useMemo(() => `dd-${Math.random().toString(36).slice(2)}`, []);

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
    if (searchable) {
      inputRef.current?.focus();
    }
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, term, align, shown.length, searchable]);

  const openFresh = () => {
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

  return (
    <div className={cls("relative", className)} ref={boxRef}>
      <div className="relative">
        {searchable ? (
          // SEARCHABLE MODE: input acts like typeahead
          <input
            ref={inputRef}
            value={open ? term : value}
            onMouseDown={(e) => {
              if (!open) {
                e.preventDefault();
                openFresh();
              }
            }}
            onFocus={() => {
              if (!open) openFresh();
            }}
            onChange={(e) => {
              setTerm(e.target.value);
              if (!open) setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && !open) {
                openFresh();
                e.preventDefault();
              }
              if (e.key === "Enter" && shown.length > 0) onPick(shown[0]);
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder={placeholder}
            className={cls(CONTROL, "pr-16 truncate")}
            title={value || undefined}
          />
        ) : (
          // NON-SEARCHABLE MODE: plain button shows selected value
          <button
            type="button"
            className={cls(CONTROL, "pr-8 text-left truncate", !value && "text-neutral-400")}
            onClick={() => {
              if (open) setOpen(false);
              else openFresh();
            }}
            title={value || placeholder}
          >
            {value || placeholder}
          </button>
        )}

        {searchable && open && term && (
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
            title="Clear"
          >
            <X className="h-4 w-4 text-neutral-500" />
          </button>
        )}

        {/* Chevron icon (purely visual) */}
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      </div>

      {open && menuRect && (
        <div
          id={menuId}
          style={{
            position: "fixed",
            left: menuRect.left,
            top: menuRect.place === "down" ? menuRect.top : undefined,
            bottom: menuRect.place === "up" ? window.innerHeight - menuRect.top : undefined,
            width: menuRect.width,
            maxHeight: "60vh",
          }}
          className={cls(
            "z-[9999] overflow-auto rounded-xl border border-neutral-300 bg-white",
            "shadow-[0_8px_24px_rgba(0,0,0,0.15)] overscroll-contain py-1"
          )}
        >
          {shown.map((opt) => (
            <button
              key={opt}
              onClick={() => onPick(opt)}
              className={cls(
                "block w-full truncate px-3 py-2 text-left text-[13px] hover:bg-emerald-50/60 transition-colors",
                value === opt && "bg-emerald-100 text-emerald-800 font-medium"
              )}
              title={opt}
            >
              {opt}
            </button>
          ))}
          {shown.length === 0 && <div className="px-3 py-2 text-[13px] text-neutral-500">No results</div>}
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
const DAY1_OPTIONS: DayShort[] = ["M", "T", "W"];

const DAY2_BY_DAY1: Partial<Record<DayShort, DayShort>> = {
  M: "H", // MH
  T: "F", // TF
  W: "S", // WS
};


/** full receiver layout (13 columns) */
const COLS_14 = [
  "38ch", // Course Code & Title
  "10ch", // Units
  "36ch", // From
  "36ch", // To
  "40ch", // Faculty
  "15ch", // Day1
  "15ch", // Begin1
  "15ch", // End1
  "15ch", // Day2
  "15ch", // Begin2
  "15ch", // End2
  "30ch", // Remarks
  "22ch", // Action
];


function ColGroup14() {
  return (
    <colgroup>
      {COLS_14.map((w, i) => (
        <col key={i} style={{ width: w }} />
      ))}
    </colgroup>
  );
}

/** compact requester layout (7 columns) */
const COLS_REQ = ["20ch", "18ch", "40ch", "8ch", "24ch", "24ch", "14ch"];
function ColGroupReq() {
  return (
    <colgroup>
      {COLS_REQ.map((w, i) => (
        <col key={i} style={{ width: w }} />
      ))}
    </colgroup>
  );
}

/** sent-requests layout (5 evenly spaced columns) */
const COLS_SENT = ["25%", "10%", "20%", "20%", "15%"];

function ColGroupSent() {
  return (
    <colgroup>
      {COLS_SENT.map((w, i) => (
        <col key={i} style={{ width: w }} />
      ))}
    </colgroup>
  );
}

/** accepted-requests layout (7 adjustable columns) */
const COLS_ACCEPTED = ["18%", "8%", "18%", "18%", "18%", "8%", "12%"];
// tweak these percentages as you like, they should total ~100%

function ColGroupAccepted() {
  return (
    <colgroup>
      {COLS_ACCEPTED.map((w, i) => (
        <col key={i} style={{ width: w }} />
      ))}
    </colgroup>
  );
}

type FSCreate = {
  course_code: string;
  section_id: string;
  section: string;
  course_title: string;
  units: number | null;
  to_department: string | "";
};

function facultyLabel(f?: { first_name?: string; last_name?: string; email?: string }) {
  if (!f) return "";
  const L = (f.last_name || "").toUpperCase();
  const F = (f.first_name || "").toUpperCase();
  return L || F ? `${L}, ${F}` : "";
}

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
};

export default function CHAIR_FacultyService({ chairDepartmentName }: ChairFacultyServiceProps) {
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

  // Start empty; we derive from props or chair header.
  // Fallback to ST only if we truly can't derive a department.
  const [activeDeptName, setActiveDeptName] = useState<string>(chairDepartmentName || "");

  // Tabs (declare early because other hooks reference it)
  const [tab, setTab] = useState<"Create Request" | "Received Requests" | "Accepted Requests">(
    "Create Request"
  );

  // Build a header label from options.activeTerm
  const updateTermLabelFromOptions = (o: any) => {
    const ay = o?.activeTerm?.acad_year_start;
    const tn = o?.activeTerm?.term_number;
    if (ay) {
      setTermLabel(`Term ${tn ?? "—"} · AY ${ay}-${ay + 1}`);
    } else {
      setTermLabel("");
    }
  };

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

  const [draft, setDraft] = useState<FSCreate>({
    course_code: "",
    section_id: "",
    section: "",
    course_title: "",
    units: null,
    to_department: "",
  });

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

      // Only apply our shortcut in Received Requests tab
      if (tab !== "Received Requests") return;

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
  }, [tab]);

  const [sentRows, setSentRows] = useState<FacultyServiceRow[]>([]);
  const [receivedRows, setReceivedRows] = useState<FacultyServiceRow[]>([]);
  const [loadingList, setLoadingList] = useState(false);

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

  // Options for creating requests: departments list + working term.
  useEffect(() => {
    if (!activeDeptName) return;
    (async () => {
      try {
        const o = await getFSOptions({ requesterDepartment: activeDeptName });
        if (o?.ok) {
          setToDepts((o.departments || []).filter((d: string) => !eqDept(d, activeDeptName)) as string[]);
          updateTermLabelFromOptions(o);
          // If the current draft "to" becomes invalid (e.g., dept changed), clear it.
          setDraft((d) => (d.to_department && eqDept(d.to_department, activeDeptName) ? { ...d, to_department: "" } : d));
        }
      } catch {
        // ignore
      }
    })();
  }, [activeDeptName]);

  // Load faculty list per receiver dept
  async function ensureFacultyForDept(dept: string) {
    if (!dept || facultyCache[dept]) return;
    try {
      const o = await getFSOptions({ toDepartment: dept as any });
      const list: FacultyOption[] =
        (o.facultyOptions || []).map((f: any) => ({
          faculty_id: f.faculty_id,
          first_name: f.first_name,
          last_name: f.last_name,
          email: f.email,
          label: facultyLabel(f),
        })) ?? [];
      setFacultyCache((prev) => ({ ...prev, [dept]: list }));
    } catch {
      // ignore
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

  // Course suggestions (Software Tech as requester)
  const [courseTerm, setCourseTerm] = useState("");
  const [courseSuggestions, setCourseSuggestions] = useState<Array<{ code: string; title: string; units?: number }>>([]);

  // Sections for the selected course (from OM Load Assignment source: sections_submitted)
  const [sectionOptions, setSectionOptions] = useState<Array<{ section_id: string; section_code: string }>>([]);

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

  // Load sections for the selected course so requests can target a specific OM row.
  useEffect(() => {
    let mounted = true;

    // Reset when no course is selected
    if (!draft.course_code) {
      setSectionOptions([]);
      setDraft((d) => ({ ...d, section_id: "", section: "" }));
      return () => {
        mounted = false;
      };
    }

    (async () => {
      try {
        if (!activeDeptName) return;
        const res = await getFSOptions({ requesterDepartment: activeDeptName, courseCode: draft.course_code });
        if (!mounted) return;
        const secs = (res?.sections || []) as Array<{ section_id: string; section_code: string }>;
        setSectionOptions(secs);

        // If current selection isn't valid anymore, clear it.
        if (draft.section_id && !secs.some((s) => String(s.section_id) === String(draft.section_id))) {
          setDraft((d) => ({ ...d, section_id: "", section: "" }));
        }
      } catch {
        if (mounted) setSectionOptions([]);
      }
    })();

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.course_code, activeDeptName]);

  const canSend = Boolean(
    draft.course_code && draft.section_id && draft.course_title && draft.units != null && draft.to_department
  );

  function friendlyError(e: any) {
    const m = e?.response?.data?.detail || e?.response?.data?.message || e?.message || "Something went wrong.";
    return typeof m === "string" ? m : JSON.stringify(m);
  }

  async function handleCreateAndSend() {
    try {
      if (!canSend) {
        showToast({
          type: "info",
          title: "Missing details",
          message: "Please complete Course, Section, Units, and To Department.",
        });
        return;
      }
      const crt = await createFacultyService({
        course_code: draft.course_code,
        section_id: draft.section_id,
        section: draft.section,
        course_title: draft.course_title,
        units: draft.units,
        to_department: draft.to_department as any,
        from_department: activeDeptName,
      });
      if (!crt?.ok || !crt.row?.fs_id) {
        showToast({ type: "error", title: "Create failed", message: "Failed to create request." });
        return;
      }

      // ... inside handleCreateAndSend ...
      const snd = await sendFacultyService(crt.row.fs_id);

      setSentRows((prev) => [snd.row, ...prev]);

      setDraft({ course_code: "", section_id: "", section: "", course_title: "", units: null, to_department: "" });
      setCourseTerm("");

      await refresh();
      showToast({ type: "success", message: "Request sent." });
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

  async function handleSendBack(fs_id: string, dept: string) {
    const e = getEdit(fs_id);
    try {
      if (!e.faculty?.faculty_id && !e.faculty?.email) {
        showToast({ type: "info", title: "Select a faculty", message: "Please select a faculty to proceed." });
        return;
      }
      await respondFacultyService(fs_id, {
        faculty: e.faculty || {},
        day1: e.day1,
        begin1: e.begin1,
        end1: e.end1,
        day2: e.day2,
        begin2: e.begin2,
        end2: e.end2,
        remarks: e.remarks,
      });

      setEdits((p) => ({
        ...p,
        [fs_id]: { ...EMPTY_EDIT },
      }));
      await refresh();
      ensureFacultyForDept(dept);
      showToast({ type: "success", message: "Request Accepted." });
    } catch (err: any) {
      showToast({ type: "error", title: "Send failed", message: friendlyError(err) });
    }
  }

  async function handleReject(fs_id: string) {
    try {
      await rejectFacultyService(fs_id, { remarks: getEdit(fs_id).remarks || "" });
      await refresh();
      showToast({ type: "error", message: "Request rejected." });
    } catch (err: any) {
      showToast({ type: "error", title: "Reject failed", message: friendlyError(err) });
    }
  }

  const acceptedRows = useMemo(
    () => sentRows.filter((r) => eqDept(r.from_department, activeDeptName) && r.status === "responded"),
    [sentRows, activeDeptName]
  );

  // When the chair opens the "Received Requests" tab, mark currently fetched received requests as seen.
  useEffect(() => {
    if (tab !== "Received Requests") return;
    const ids = (receivedRows || [])
      .map((r) => r?.fs_id || r?.id)
      .filter(Boolean)
      .map((x) => String(x));

    if (!ids.length) {
      setHasNewReceived(false);
      return;
    }

    let changed = false;
    for (const id of ids) {
      if (!seenReceivedRef.current.has(id)) {
        seenReceivedRef.current.add(id);
        changed = true;
      }
    }
    if (changed) saveSeenReceived();
    setHasNewReceived(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, receivedRows, receivedSeenKey]);

  // Keep the tab labels stable for logic, but decorate the Received tab label when there are unseen rows.
  const RECEIVED_BASE = "Received Requests";
  const RECEIVED_LABEL = hasNewReceived ? `${RECEIVED_BASE} 🔴` : RECEIVED_BASE;
  const activeTabLabel = tab === RECEIVED_BASE ? RECEIVED_LABEL : tab;
  const onTabChangeSafe = (t: string) => {
    if (t.startsWith(RECEIVED_BASE)) setTab(RECEIVED_BASE);
    else if (t.startsWith("Create Request")) setTab("Create Request");
    else if (t.startsWith("Accepted Requests")) setTab("Accepted Requests");
    else setTab(t as any);
  };

  // Undo/Redo button enablement (uses historyTick to keep lint happy and force rerenders)
  const canUndoReceived = tab === "Received Requests" && historyTick >= 0 && undoRef.current.length > 0;
  const canRedoReceived = tab === "Received Requests" && historyTick >= 0 && redoRef.current.length > 0;

  
/* ---------------- UI ---------------- */
  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <ToastViewport items={toasts} onClose={closeToast} />

<div className="sticky top-0 z-10 bg-white px-8 pt-8">
  <header className="mb-2">
    <h1 className="text-2xl font-bold">Faculty Service</h1>
    <p className="text-sm text-gray-600">
      Create faculty service requests from your department, track sent requests, and respond to requests addressed to
      your department.
      {termLabel ? ` for ${termLabel}` : ""}
    </p>
  </header>

 <Tabs
          mode="state"
          activeTab={activeTabLabel}
          onTabChange={(t) => onTabChangeSafe(t as any)}
          items={[
            { label: "Create Request" },
            { label: RECEIVED_LABEL },
            { label: "Accepted Requests" },
          ]}/>
</div>


  

      <main className="w-full px-8 pb-24">
        {/* 1) CREATE REQUEST (From = activeDeptName) */}
        {tab === "Create Request" && (
          <>
          <div className={cls(PLANTILLA_TABLE_WRAP, "overflow-y-visible mb-8")}> 
            <div className={cls(PLANTILLA_SECTION_TITLE, "w-full")}>Create Request</div>

            <div className="overflow-x-auto">
              <table className={PLANTILLA_TABLE}>
                <ColGroupReq />
                <thead className={PLANTILLA_THEAD}>
                  <tr className={PLANTILLA_HEAD_TR}>
                    <th className={PLANTILLA_TH}>Course Code</th>
                    <th className={PLANTILLA_TH}>Section</th>
                    <th className={PLANTILLA_TH}>Course Title</th>
                    <th className={PLANTILLA_TH}>Units</th>
                    <th className={PLANTILLA_TH}>From</th>
                    <th className={PLANTILLA_TH}>To</th>
                    <th className={PLANTILLA_TH}>Action</th>
                  </tr>
                </thead>

                <tbody className="text-gray-800">
                  <tr className={PLANTILLA_ROW}>
                    {/* Course Code */}
                    <td className={cls(PLANTILLA_TD, "align-middle")}> 
                      <div className="relative">
                        <Dropdown
                          value={draft.course_code}
                          onChange={(code) => {
                            const hit = courseSuggestions.find((c) => c.code === code);
                            setDraft((d) => ({
                              ...d,
                              course_code: code,
                              section_id: "",
                              section: "",
                              course_title: hit?.title ?? d.course_title,
                              units: hit?.units ?? d.units,
                            }));
                            setCourseTerm("");
                          }}
                          options={codeOptions}
                          placeholder="Select code…"
                          searchable
                          className="w-full [&>button]:h-9 [&>button]:px-2"
                          onOpen={() => setCourseTerm("")}
                        />
                      </div>
                    </td>

                    {/* Section */}
                    <td className={cls(PLANTILLA_TD, "align-middle")}> 
                      <Dropdown
                        value={draft.section}
                        onChange={(sec) => {
                          const hit = (sectionOptions || []).find((s) => s.section_code === sec);
                          setDraft((d) => ({
                            ...d,
                            section: sec,
                            section_id: hit?.section_id || "",
                          }));
                        }}
                        options={Array.from(new Set((sectionOptions || []).map((s) => s.section_code))).sort()}
                        placeholder={draft.course_code ? "Select section…" : "Select course first"}
                        className="w-full [&>button]:h-9 [&>button]:px-2"
                      />
                    </td>

                    {/* Course Title (readonly) */}
                    <td className={cls(PLANTILLA_TD, "align-middle")}> 
                      <span className="inline-block max-w-full truncate leading-6 px-1">
                        {draft.course_title || " "}
                      </span>
                    </td>

                    {/* Units (readonly) */}
                    <td className={cls(PLANTILLA_TD, "align-middle tabular-nums")}> 
                      <span className="inline-block leading-6">{draft.units ?? " "}</span>
                    </td>

                    {/* From */}
                    <td className={cls(PLANTILLA_TD, "align-middle")}> 
                      <span className="inline-block leading-6" title={activeDeptName}>
                        {activeDeptName}
                      </span>
                    </td>

                    {/* To */}
                    <td className={cls(PLANTILLA_TD, "align-middle")}> 
                      <Dropdown
                        value={draft.to_department}
                        onChange={(v) => setDraft((d) => ({ ...d, to_department: v }))}
                        options={toDepts}
                        placeholder="Select department…"
                        className="[&>button]:h-9 [&>button]:px-2"
                      />
                    </td>

                    {/* Action */}
                    <td className={cls(PLANTILLA_TD, "align-middle")}> 
                      <button
                        className={cls(
                          "inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md px-2 text-[13px] font-medium shadow-sm",
                          canSend
                            ? "bg-[#008e4e] text-white hover:brightness-110"
                            : "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                        )}
                        disabled={!canSend}
                        onClick={handleCreateAndSend}
                        title="Send request"
                      >
                        <Send className="h-4 w-4" />
                        Send
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Sent Requests (below Create Request) */}
          <div className={cls(PLANTILLA_TABLE_WRAP, "mt-3 flex-1 min-h-[320px]")}> 
            <div className="overflow-x-auto">
              <div className={cls(PLANTILLA_SECTION_TITLE, "w-full")}>Sent Requests</div>

              <table className={PLANTILLA_TABLE}>
                <ColGroupSent />
                <thead className={PLANTILLA_THEAD}>
                  <tr className={PLANTILLA_HEAD_TR}>
                    <th className={PLANTILLA_TH}>Course Code &amp; Title</th>
                    <th className={PLANTILLA_TH}>Units</th>
                    <th className={PLANTILLA_TH}>From</th>
                    <th className={PLANTILLA_TH}>To</th>
                    <th className={PLANTILLA_TH}>Status</th>
                  </tr>
                </thead>

                <tbody className="text-gray-800">
                  {sentRows.map((r) => (
                    <tr key={r.fs_id} className={PLANTILLA_ROW}>
                      <td className={cls(PLANTILLA_TD, "text-left")}> 
                        <div className="font-semibold text-emerald-700">{r.course_code}</div>
                        {r.section ? (
                          <div className="text-[12px] text-neutral-700 leading-tight">Section: {r.section}</div>
                        ) : null}
                        <div className="text-[12px] text-neutral-600 leading-tight">{r.course_title}</div>
                      </td>

                      <td className={cls(PLANTILLA_TD, "tabular-nums")}>{r.units ?? ""}</td>

                      <td className={cls(PLANTILLA_TD, "truncate")} title={r.from_department}>
                        {r.from_department}
                      </td>

                      <td className={cls(PLANTILLA_TD, "truncate")} title={r.to_department}>
                        {r.to_department}
                      </td>

                      <td className={PLANTILLA_TD}>
                        <span
                          className={cls(
                            "inline-block rounded-full px-2 py-[2px] text-[12px]",
                            r.status === "responded"
                              ? "bg-emerald-100 text-emerald-700"
                              : r.status === "rejected"
                              ? "bg-red-100 text-red-700"
                              : "bg-amber-100 text-amber-700"
                          )}
                        >
                          {r.status === "responded" ? "Responded" : r.status === "rejected" ? "Rejected" : "Sent"}
                        </span>
                      </td>
                    </tr>
                  ))}

                  {sentRows.length == 0 && !loadingList && (
                    <tr className={PLANTILLA_ROW}>
                      <td className={cls(PLANTILLA_TD, "py-6 text-sm text-gray-500")} colSpan={5}>
                        No sent requests yet.
                      </td>
                    </tr>
                  )}

                  {loadingList && (
                    <tr className={PLANTILLA_ROW}>
                      <td className={cls(PLANTILLA_TD, "py-6 text-sm text-gray-500")} colSpan={5}>
                        Loading…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          </>
        )}

        {/* 2) SENT REQUESTS (from my department) */}
        {/* 3) RECEIVED REQUESTS (editable, full; to my department) */}
        {tab === "Received Requests" && (
          <div className={cls(PLANTILLA_TABLE_WRAP, "mt-3 flex-1 min-h-[320px] overflow-y-auto")}>
            <div className={cls(PLANTILLA_SECTION_TITLE, "w-full flex items-center justify-between gap-3")}
            >
              <span>Received Requests</span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    undoEdit();
                  }}
                  disabled={!canUndoReceived}
                  className={cls(
                    "inline-flex items-center justify-center rounded-md px-2 py-1",
                    "border border-white/30",
                    canUndoReceived ? "hover:bg-white/10" : "opacity-50 cursor-not-allowed"
                  )}
                  title="Undo (Ctrl/Cmd+Z)"
                  aria-label="Undo"
                >
                  <Undo2 className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    redoEdit();
                  }}
                  disabled={!canRedoReceived}
                  className={cls(
                    "inline-flex items-center justify-center rounded-md px-2 py-1",
                    "border border-white/30",
                    canRedoReceived ? "hover:bg-white/10" : "opacity-50 cursor-not-allowed"
                  )}
                  title="Redo (Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z)"
                  aria-label="Redo"
                >
                  <Redo2 className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className={PLANTILLA_TABLE}>
                <ColGroup14 />
                <thead className={PLANTILLA_THEAD}>
                  <tr className={PLANTILLA_HEAD_TR}>
                    <th className={cls(PLANTILLA_TH, "text-left")}>Course Code &amp; Title</th>
                    <th className={PLANTILLA_TH}>Units</th>
                    <th className={PLANTILLA_TH}>From</th>
                    <th className={PLANTILLA_TH}>To</th>
                    <th className={PLANTILLA_TH}>Faculty</th>
                    <th className={PLANTILLA_TH}>Day1</th>
                    <th className={PLANTILLA_TH}>Begin1</th>
                    <th className={PLANTILLA_TH}>End1</th>
                    <th className={PLANTILLA_TH}>Day2</th>
                    <th className={PLANTILLA_TH}>Begin2</th>
                    <th className={PLANTILLA_TH}>End2</th>
                    <th className={PLANTILLA_TH}>Remarks</th>
                    <th className={PLANTILLA_TH}>Action</th>
                  </tr>
                </thead>

                <tbody className="text-gray-800">
                  {receivedRows.map((r) => {
                    const fsid = r.fs_id!;
                    const dept = r.to_department || "";
                    const e = getEdit(fsid);
                    const facultyOptions = facultyCache[dept] || [];
                    const isClosed = r.status === "responded" || r.status === "rejected";

                    return (
                      <tr
                        key={fsid}
                        className={PLANTILLA_ROW}
                        onMouseEnter={() => ensureFacultyForDept(dept)}
                      >
                        {/* Course */}
                        <td className={cls(PLANTILLA_TD, "text-left")}>
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="font-semibold text-emerald-700">{r.course_code}</div>
                            {r.section ? <div className="text-[12px] text-neutral-700">{r.section}</div> : null}
                          </div>
                          <div className="text-[12px] text-neutral-600 leading-tight">{r.course_title}</div>
                        </td>

                        {/* Units */}
                        <td className={cls(PLANTILLA_TD, "tabular-nums")}>{r.units ?? ""}</td>

                        {/* From */}
                        <td className={cls(PLANTILLA_TD, "truncate")} title={r.from_department}>
                          {r.from_department}
                        </td>

                        {/* To */}
                        <td className={cls(PLANTILLA_TD, "truncate")} title={r.to_department}>
                          {r.to_department}
                        </td>

                        {/* Faculty */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <Dropdown
                              value={
                                e.faculty?.faculty_id
                                  ? facultyOptions.find((f) => f.faculty_id === e.faculty?.faculty_id)?.label || ""
                                  : facultyLabel(e.faculty)
                              }
                              onChange={(label) => {
                                const match = facultyOptions.find((f) => f.label === label);
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
                              options={facultyOptions.map((f) => f.label).filter(Boolean)}
                              placeholder={facultyOptions.length ? "Select faculty…" : "Loading…"}
                              searchable
                            />
                          ) : (
                            <span className="block truncate text-center" title={facultyLabel(r.faculty as any)}>
                              {facultyLabel(r.faculty as any) || "—"}
                            </span>
                          )}
                        </td>

                        {/* Day1 */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <Dropdown
                              value={e.day1 || ""}
                              onChange={(val) => {
                                const d1 = val as DayShort | "";
                                patchEdit(fsid, {
                                  day1: d1,
                                  day2: d1 ? (DAY2_BY_DAY1[d1 as DayShort] as DayShort) : "",
                                });
                              }}
                              options={[...DAY1_OPTIONS]}
                              placeholder=""
                              className="max-w-[90px] mx-auto"
                              searchable={false}
                            />
                          ) : (
                            r.day1 || "—"
                          )}
                        </td>

                        {/* Begin1 */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <Dropdown
                              value={e.begin1 || ""}
                              onChange={(val) => {
                                const v = val;
                                patchEdit(fsid, {
                                  begin1: v,
                                  end1: v ? END_BY_BEGIN[v as keyof typeof END_BY_BEGIN] : "",
                                });
                              }}
                              options={timeBegins}
                              placeholder=""
                              className="max-w-[90px] mx-auto"
                              searchable={false}
                            />
                          ) : (
                            r.begin1 || "—"
                          )}
                        </td>

                        {/* End1 */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <Dropdown
                              value={e.end1 || ""}
                              onChange={(v) => patchEdit(fsid, { end1: v })}
                              options={timeBegins}
                              placeholder="—"
                              className="max-w-[90px] mx-auto"
                              searchable={false}
                            />
                          ) : (
                            r.end1 || "—"
                          )}
                        </td>

                        {/* Day2 */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <Dropdown
                              value={e.day2 || ""}
                              onChange={(v) => patchEdit(fsid, { day2: v as DayShort | "" })}
                              options={[...DAY1_OPTIONS, "H", "F", "S"]}
                              placeholder="—"
                              className="max-w-[90px] mx-auto"
                              searchable={false}
                            />
                          ) : (
                            r.day2 || "—"
                          )}
                        </td>

                        {/* Begin2 */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <Dropdown
                              value={e.begin2 || ""}
                              onChange={(val) => {
                                const v = val;
                                patchEdit(fsid, {
                                  begin2: v,
                                  end2: v ? END_BY_BEGIN[v as keyof typeof END_BY_BEGIN] : "",
                                });
                              }}
                              options={timeBegins}
                              placeholder=""
                              className="max-w-[90px] mx-auto"
                              searchable={false}
                            />
                          ) : (
                            r.begin2 || "—"
                          )}
                        </td>

                        {/* End2 */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <Dropdown
                              value={e.end2 || ""}
                              onChange={(v) => patchEdit(fsid, { end2: v })}
                              options={timeBegins}
                              placeholder="—"
                              className="max-w-[90px] mx-auto"
                              searchable={false}
                            />
                          ) : (
                            r.end2 || "—"
                          )}
                        </td>

                        {/* Remarks */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <input
                              value={e.remarks}
                              onChange={(ev) => patchEdit(fsid, { remarks: ev.target.value })}
                              placeholder="Enter remarks…"
                              className={CONTROL}
                            />
                          ) : (
                            <span className="block whitespace-normal break-words" title={r.remarks || ""}>
                              {r.remarks || "—"}
                            </span>
                          )}
                        </td>

                        {/* Action */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          {!isClosed ? (
                            <div className="flex flex-row items-center justify-center gap-2">
                              {(() => {
                                const canRespond = !!(e.faculty?.faculty_id || e.faculty?.email);
                                return (
                                  <button
                                    className={cls(
                                      "inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium shadow-sm",
                                      canRespond
                                        ? "bg-[#008e4e] text-white hover:brightness-110"
                                        : "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                                    )}
                                    disabled={!canRespond}
                                    onClick={() => handleSendBack(fsid, dept)}
                                    title="Send"
                                  >
                                    <Check className="h-4 w-4" />
                                    Approve
                                  </button>
                                );
                              })()}

                              <button
                                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-red-600 px-2 text-[12px] font-medium text-white shadow-sm hover:brightness-110"
                                onClick={() => handleReject(fsid)}
                                title="Reject"
                              >
                                <X className="h-4 w-4" />
                                Reject
                              </button>
                            </div>
                          ) : (
                            <span
                              className={cls(
                                "inline-block rounded-full px-2 py-[2px] text-[12px]",
                                r.status === "responded"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-red-100 text-red-700"
                              )}
                            >
                              {r.status === "responded" ? "Responded" : "Rejected"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {receivedRows.length === 0 && !loadingList && (
                    <tr className={PLANTILLA_ROW}>
                      <td className={cls(PLANTILLA_TD, "py-6 text-sm text-gray-500")} colSpan={14}>
                        No received requests for your department.
                      </td>
                    </tr>
                  )}

                  {loadingList && (
                    <tr className={PLANTILLA_ROW}>
                      <td className={cls(PLANTILLA_TD, "py-6 text-sm text-gray-500")} colSpan={14}>
                        Loading…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 4) ACCEPTED / RESPONDED REQUESTS (subset of Sent) */}
        {tab === "Accepted Requests" && (
          <div className={cls(PLANTILLA_TABLE_WRAP, "mt-3 overflow-y-visible")}> 
            <div className="overflow-x-auto">
              <div className={cls(PLANTILLA_SECTION_TITLE, "w-full border-b border-emerald-800/10")}>
                <div className="relative flex items-center justify-center">
                  <span>Accepted Requests</span>
                  <span className="absolute right-0 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-medium text-white">
                    {acceptedRows.length} accepted
                  </span>
                </div>
              </div>

              <div className="max-h-[420px] overflow-y-auto">
                <table className={PLANTILLA_TABLE}>
                  <ColGroupAccepted />
                  <thead className={PLANTILLA_THEAD}>
                    <tr className={PLANTILLA_HEAD_TR}>
                      <th className={cls(PLANTILLA_TH, "text-left")}>Course</th>
                      <th className={PLANTILLA_TH}>Units</th>
                      <th className={PLANTILLA_TH}>From Department</th>
                      <th className={PLANTILLA_TH}>Faculty</th>
                      <th className={PLANTILLA_TH}>Schedule</th>
                      <th className={PLANTILLA_TH}>Status</th>
                      <th className={PLANTILLA_TH}>Remarks</th>
                    </tr>
                  </thead>

                  <tbody>
                    {!loadingList && acceptedRows.length === 0 && (
                      <tr className={PLANTILLA_ROW}>
                        <td className={cls(PLANTILLA_TD, "py-6 text-sm text-gray-500")} colSpan={7}>
                          No accepted requests yet.
                        </td>
                      </tr>
                    )}

                    {acceptedRows.map((r) => (
                      <tr key={r.fs_id || r.id} className={PLANTILLA_ROW}>
                        {/* Course */}
                        <td className={cls(PLANTILLA_TD, "text-left")}> 
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="font-semibold text-emerald-700">{r.course_code}</div>
                            {r.section ? <div className="text-[12px] text-neutral-700">{r.section}</div> : null}
                          </div>
                          <div className="text-[12px] text-neutral-600 leading-tight">{r.course_title}</div>
                        </td>

                        {/* Units */}
                        <td className={cls(PLANTILLA_TD, "tabular-nums")}>{r.units ?? "—"}</td>

                        {/* From Department */}
                        <td className={PLANTILLA_TD}>{r.from_department}</td>

                        {/* Faculty */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}> 
                          {r.faculty?.last_name || r.faculty?.first_name ? (
                            <div className="space-y-0.5">
                              <p className="text-xs font-medium text-neutral-800">
                                {[r.faculty?.last_name, r.faculty?.first_name].filter(Boolean).join(", ")}
                              </p>
                              {r.faculty?.email && <p className="text-[11px] text-neutral-500">{r.faculty.email}</p>}
                            </div>
                          ) : (
                            <span className="text-xs italic text-neutral-400">Not set</span>
                          )}
                        </td>

                        {/* Schedule */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}> 
                          <div className="space-y-0.5">
                            {(r.day1 || r.begin1 || r.end1) && (
                              <div>
                                <span className="font-medium">{r.day1 || "—"}</span>{" "}
                                <span className="tabular-nums">
                                  {r.begin1 || "—"}–{r.end1 || "—"}
                                </span>
                              </div>
                            )}
                            {(r.day2 || r.begin2 || r.end2) && (
                              <div className="text-neutral-500">
                                <span className="font-medium">{r.day2 || "—"}</span>{" "}
                                <span className="tabular-nums">
                                  {r.begin2 || "—"}–{r.end2 || "—"}
                                </span>
                              </div>
                            )}
                            {!r.day1 && !r.begin1 && !r.end1 && !r.day2 && !r.begin2 && !r.end2 && (
                              <span className="text-xs italic text-neutral-400">No schedule set</span>
                            )}
                          </div>
                        </td>

                        {/* Status */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          <span className="inline-flex items-center justify-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                            Responded
                          </span>
                        </td>


                        {/* Remarks */}
                        <td className={cls(PLANTILLA_TD, "align-middle")}> 
                          {r.remarks || <span className="italic text-neutral-400">No remarks</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
``