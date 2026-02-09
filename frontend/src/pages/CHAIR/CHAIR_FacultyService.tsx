// frontend/src/pages/CHAIR/CHAIR_FacultyService.tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Send, ChevronDown, X, CheckCircle2, AlertCircle, Info, Undo2, Redo2, Plus, Trash2 } from "lucide-react";
import {
  getFSOptions,
  listFacultyService,
  createFacultyService,
  sendFacultyService,
  respondFacultyService,
  rejectFacultyService,
  restoreFacultyService,
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
  "min-w-full w-full text-sm table-fixed border-collapse leading-snug [&_td]:align-middle [&_td]:whitespace-normal [&_td]:break-words";

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
const DAY1_OPTIONS: DayShort[] = ["M", "T", "W", "H", "F", "S"];

const DAY2_BY_DAY1: Partial<Record<DayShort, DayShort>> = {
  M: "H", // MH
  T: "F", // TF
  W: "S", // WS
};


/** full receiver layout (13 columns)
 *  NOTE: day/begin/end columns are intentionally wider for better readability.
 */
const COLS_14 = [
  "34ch", // Course Code & Title
  "18ch", // Section
  "8ch", // Units
  "30ch", // From
  "36ch", // Faculty
  "16ch", // Day1
  "16ch", // Begin1
  "16ch", // End1
  "16ch", // Day2
  "16ch", // Begin2
  "16ch", // End2
  "28ch", // Remarks
  "16ch", // Status
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

/** combined create + sent layout (14 columns) */
const COLS_COMBINED = [
  "6ch", // checkbox
  "34ch", // course code & title
  "23ch", // section
  "8ch", // units
  "30ch", // to
  "30ch", // faculty
  "10ch", // day1
  "10ch", // begin1
  "10ch", // end1
  "10ch", // day2
  "10ch", // begin2
  "10ch", // end2
  "30ch", // remarks
  "14ch", // status
];

function ColGroupCombined() {
  return (
    <colgroup>
      {COLS_COMBINED.map((w, i) => (
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
  remarks: string;
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

  // NOTE: Faculty Service is shown in a single compact view (no top tabs).

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

  
  // Sent list: keep "most recent" at the bottom (oldest -> newest)
  const mySentRows = useMemo(() => {
    const rows = (sentRows || []).filter((r) => eqDept(r.from_department, activeDeptName));
    return rows.slice().reverse();
  }, [sentRows, activeDeptName]);

  // Undo/Redo button enablement (uses historyTick to keep lint happy and force rerenders)
  const canUndoReceived = historyTick >= 0 && undoRef.current.length > 0;
  const canRedoReceived = historyTick >= 0 && redoRef.current.length > 0;

/* ---------------- UI ---------------- */
  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <ToastViewport items={toasts} onClose={closeToast} />

      <div className="sticky top-0 z-10 bg-white px-8 pt-8">
        <header className="mb-2">
          <h1 className="text-2xl font-bold">Faculty Service</h1>
          <p className="text-sm text-gray-600">
            Create &amp; send faculty service requests, track request status, and respond to received requests.
            {termLabel ? ` for ${termLabel}` : ""}
          </p>
        </header>
      </div>

      <main className="w-full px-8 pb-24 space-y-10">
        {/* 1) CREATE & SENT REQUESTS (From = activeDeptName) */}
        <div className={cls(PLANTILLA_TABLE_WRAP, "overflow-y-visible")}>
          <div className={cls(PLANTILLA_SECTION_TITLE, "w-full flex items-center justify-between gap-3")}>
            <span>Sent Requests</span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addDraftRow}
                className={cls(
                  "inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium shadow-sm",
                  "bg-white text-emerald-800 border border-white/40 hover:bg-white/10"
                )}
                title="Add another request row"
              >
                <Plus className="h-4 w-4" />
                Add Row
              </button>

              <button
                type="button"
                onClick={handleCreateAndSend}
                className={cls(
                  "inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium shadow-sm",
                  "bg-blue-600 text-white hover:bg-blue-700"
                )}
                title="Send selected requests"
              >
                <Send className="h-4 w-4" />
                Send
              </button>

            </div>
          </div>

          <div className="overflow-x-auto">
            <table className={PLANTILLA_TABLE}>
              <ColGroupCombined />
              <thead className={PLANTILLA_THEAD}>
                <tr className={PLANTILLA_HEAD_TR}>
                  <th className={PLANTILLA_TH}>
                    <span className="sr-only">Select</span>
                  </th>
                  <th className={PLANTILLA_TH}>Course Code &amp; Title<span className="text-red-600 ml-0.5">*</span></th>
                  <th className={PLANTILLA_TH}>Section<span className="text-red-600 ml-0.5">*</span></th>
                  <th className={PLANTILLA_TH}>Units</th>
                  <th className={PLANTILLA_TH}>To<span className="text-red-600 ml-0.5">*</span></th>
                  <th className={PLANTILLA_TH}>Faculty</th>
                  <th className={PLANTILLA_TH}>Day1</th>
                  <th className={PLANTILLA_TH}>Begin1</th>
                  <th className={PLANTILLA_TH}>End1</th>
                  <th className={PLANTILLA_TH}>Day2</th>
                  <th className={PLANTILLA_TH}>Begin2</th>
                  <th className={PLANTILLA_TH}>End2</th>
                  <th className={PLANTILLA_TH}>Remarks</th>
                  <th className={PLANTILLA_TH}>Status</th>
                </tr>
              </thead>

              <tbody className="text-gray-800">
                {/* Draft rows (editable before sending) */}
                {draftRows.map((r) => {
                  const checked = selectedDraftIds[r._tmpId] ?? true;
                  const secs = sectionOptionsByCode[(r.course_code || "").trim()] || [];
                  const sectionCodes = Array.from(new Set(secs.map((s) => s.section_code))).sort();
                  return (
                    <tr key={r._tmpId} className={PLANTILLA_ROW}>
                      <td className={cls(PLANTILLA_TD, "align-middle")}>
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
                      </td>

                      <td className={cls(PLANTILLA_TD, "text-left")}>
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
                          placeholder="Select code…"
                          searchable
                          className="block w-full [&_button]:h-9 [&_button]:px-2 [&_input]:h-9 [&_input]:px-2"
                          onOpen={() => setCourseTerm("")}
                        />
                        <div className="mt-1 text-[12px] text-neutral-600 leading-tight">{r.course_title || ""}</div>
                      </td>

                      <td className={cls(PLANTILLA_TD, "align-middle")}>
                        <Dropdown
                          value={r.section}
                          onChange={(sec) => {
                            const hit = secs.find((s) => s.section_code === sec);
                            updateDraftRow(r._tmpId, { section: sec, section_id: hit?.section_id || "" });
                          }}
                          options={sectionCodes}
                          placeholder={r.course_code ? "Select section…" : "Select course first"}
                          className="block w-full [&_button]:h-9 [&_button]:px-2 [&_input]:h-9 [&_input]:px-2"
                        />
                      </td>

                      <td className={cls(PLANTILLA_TD, "align-middle tabular-nums")}>
                        <span className="inline-block leading-6">{r.units ?? "—"}</span>
                      </td>

                      <td className={cls(PLANTILLA_TD, "align-middle")}>
                        <Dropdown
                          value={r.to_department}
                          onChange={(v) => updateDraftRow(r._tmpId, { to_department: v })}
                          options={toDepts}
                          placeholder="Select department…"
                          className="block w-full [&_button]:h-9 [&_button]:px-2 [&_input]:h-9 [&_input]:px-2"
                        />
                      </td>

                      {/* disabled fields until receiver responds */}
                      <td className={PLANTILLA_TD}>—</td>
                      <td className={PLANTILLA_TD}>—</td>
                      <td className={PLANTILLA_TD}>—</td>
                      <td className={PLANTILLA_TD}>—</td>
                      <td className={PLANTILLA_TD}>—</td>
                      <td className={PLANTILLA_TD}>—</td>
                      <td className={PLANTILLA_TD}>—</td>

                      <td className={cls(PLANTILLA_TD, "text-left")}>
                        <input
                          className={cls(CONTROL, "h-9 px-2")}
                          value={r.remarks}
                          onChange={(ev) => updateDraftRow(r._tmpId, { remarks: ev.target.value })}
                          placeholder="Remarks…"
                        />
                      </td>

                      <td className={PLANTILLA_TD}>
                        <div className="flex items-center justify-center gap-2">
                          <span className="inline-block rounded-full px-2 py-[2px] text-[12px] bg-neutral-200 text-neutral-700">
                            Draft
                          </span>
                          <button
                            type="button"
                            onClick={() => removeDraftRow(r._tmpId)}
                            className={cls(
                              "inline-flex items-center justify-center rounded-md p-1.5",
                              "hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500/30"
                            )}
                            title="Delete draft row"
                            aria-label="Delete draft row"
                          >
                            <Trash2 className="h-4 w-4 text-red-600" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {/* Sent rows (read-only) */}
                {mySentRows.map((r) => {
                  const label = r.status === "responded" ? "Approved" : r.status === "rejected" ? "Rejected" : "Pending";
                  const badge =
                    r.status === "responded"
                      ? "bg-emerald-100 text-emerald-700"
                      : r.status === "rejected"
                      ? "bg-red-100 text-red-700"
                      : "bg-amber-100 text-amber-700";

                  return (
                    <tr key={r.fs_id || r.id} className={PLANTILLA_ROW}>
                      <td className={PLANTILLA_TD}>
                        <input type="checkbox" className="h-4 w-4" disabled />
                      </td>

                      <td className={cls(PLANTILLA_TD, "text-left")}>
                        <div className="font-semibold text-emerald-700">{r.course_code}</div>
                        <div className="text-[12px] text-neutral-600 leading-tight">{r.course_title}</div>
                      </td>

                      <td className={PLANTILLA_TD}>{r.section || "—"}</td>
                      <td className={cls(PLANTILLA_TD, "tabular-nums")}>{r.units ?? "—"}</td>
                      <td className={cls(PLANTILLA_TD, "truncate")} title={r.to_department}>
                        {r.to_department}
                      </td>
                      <td className={cls(PLANTILLA_TD, "truncate")} title={facultyLabel(r.faculty)}>
                        {facultyLabel(r.faculty) || "—"}
                      </td>
                      <td className={PLANTILLA_TD}>{r.day1 || "—"}</td>
                      <td className={PLANTILLA_TD}>{r.begin1 || "—"}</td>
                      <td className={PLANTILLA_TD}>{r.end1 || "—"}</td>
                      <td className={PLANTILLA_TD}>{r.day2 || "—"}</td>
                      <td className={PLANTILLA_TD}>{r.begin2 || "—"}</td>
                      <td className={PLANTILLA_TD}>{r.end2 || "—"}</td>
                      <td className={cls(PLANTILLA_TD, "text-left")}>
                        <span className="block whitespace-normal break-words" title={r.remarks || ""}>
                          {r.remarks || "—"}
                        </span>
                      </td>
                      <td className={PLANTILLA_TD}>
                        <span className={cls("inline-block rounded-full px-2 py-[2px] text-[12px]", badge)}>{label}</span>
                      </td>
                    </tr>
                  );
                })}

                {mySentRows.length === 0 && !loadingList && (
                  <tr className={PLANTILLA_ROW}>
                    <td className={cls(PLANTILLA_TD, "py-6 text-sm text-gray-500")} colSpan={14}>
                      No sent requests yet.
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

        {/* 2) RECEIVED REQUESTS (To = activeDeptName) */}
          <div className={cls(PLANTILLA_TABLE_WRAP, "mt-3 flex-1 min-h-[320px] overflow-y-auto")}>
            <div className={cls(PLANTILLA_SECTION_TITLE, "w-full flex items-center justify-between gap-3")}
            >
				  <span className="inline-flex items-center gap-2">
				    Received Requests
				    {hasNewReceived && (
				      <span
				        className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800"
				        title="New requests received"
				      >
				        New
				      </span>
				    )}
				  </span>

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
                    <th className={PLANTILLA_TH}>Section</th>
                    <th className={PLANTILLA_TH}>Units</th>
                    <th className={PLANTILLA_TH}>From</th>
                    <th className={PLANTILLA_TH}>Faculty<span className="text-red-600 ml-0.5">*</span></th>
                    <th className={PLANTILLA_TH}>Day1<span className="text-red-600 ml-0.5">*</span></th>
                    <th className={PLANTILLA_TH}>Begin1<span className="text-red-600 ml-0.5">*</span></th>
                    <th className={PLANTILLA_TH}>End1<span className="text-red-600 ml-0.5">*</span></th>
                    <th className={PLANTILLA_TH}>Day2<span className="text-red-600 ml-0.5">*</span></th>
                    <th className={PLANTILLA_TH}>Begin2<span className="text-red-600 ml-0.5">*</span></th>
                    <th className={PLANTILLA_TH}>End2<span className="text-red-600 ml-0.5">*</span></th>
                    <th className={PLANTILLA_TH}>Remarks</th>
                    <th className={PLANTILLA_TH}>Status<span className="text-red-600 ml-0.5">*</span></th>
                  </tr>
                </thead>

                <tbody className="text-gray-800">
                  {receivedRows.map((r) => {
                    const fsid = r.fs_id!;
                    const dept = r.to_department || "";
                    const e = getEdit(fsid);
                    const facultyOptions = facultyCache[dept] || [];

                    const statusLabel =
                      r.status === "responded" ? "Approved" : r.status === "rejected" ? "Rejected" : "Pending";

                    const setStatus = async (nextLabel: string) => {
                      if (nextLabel === statusLabel) return;

                      if (nextLabel === "Approved") {
                        const missing: string[] = [];
                        if (!e.faculty?.faculty_id && !e.faculty?.email) missing.push("Faculty");
                        if (!e.day1) missing.push("Day1");
                        if (!e.begin1) missing.push("Begin1");
                        if (!e.end1) missing.push("End1");
                        if (!e.day2) missing.push("Day2");
                        if (!e.begin2) missing.push("Begin2");
                        if (!e.end2) missing.push("End2");

                        if (missing.length) {
                          showToast({
                            type: "info",
                            title: "Missing details",
                            message: `Please complete: ${missing.join(", ")}.`,
                          });
                          return;
                        }

                        await handleSendBack(fsid, dept);
                        return;
                      }

                      if (nextLabel === "Rejected") {
                        await handleReject(fsid);
                        return;
                      }

                      try {
                        await restoreFacultyService(fsid, { status: "sent" as any });
                        await refresh();
                        showToast({ type: "info", message: "Status set to Pending." });
                      } catch (err: any) {
                        showToast({ type: "error", title: "Update failed", message: friendlyError(err) });
                      }
                    };

                    return (
                      <tr key={fsid} className={PLANTILLA_ROW} onMouseEnter={() => ensureFacultyForDept(dept)}>
                        <td className={cls(PLANTILLA_TD, "text-left align-top")}>
                          <div className="font-semibold text-emerald-700">{r.course_code}</div>
                          <div className="text-[12px] text-neutral-600 leading-tight">{r.course_title}</div>
                        </td>

                        <td className={cls(PLANTILLA_TD, "tabular-nums")}>{r.section || "—"}</td>

                        <td className={cls(PLANTILLA_TD, "tabular-nums")}>{r.units ?? ""}</td>

                        <td className={cls(PLANTILLA_TD, "truncate")} title={r.from_department}>
                          {r.from_department}
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
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
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
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
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
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
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          <Dropdown
                            value={e.end1 || ""}
                            onChange={(v) => patchEdit(fsid, { end1: v })}
                            options={timeBegins}
                            placeholder="—"
                            className="max-w-[90px] mx-auto"
                            searchable={false}
                          />
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          <Dropdown
                            value={e.day2 || ""}
                            onChange={(v) => patchEdit(fsid, { day2: v as DayShort | "" })}
                            options={[...DAY1_OPTIONS]}
                            placeholder="—"
                            className="max-w-[90px] mx-auto"
                            searchable={false}
                          />
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
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
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          <Dropdown
                            value={e.end2 || ""}
                            onChange={(v) => patchEdit(fsid, { end2: v })}
                            options={timeBegins}
                            placeholder="—"
                            className="max-w-[90px] mx-auto"
                            searchable={false}
                          />
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          <input
                            value={e.remarks}
                            onChange={(ev) => patchEdit(fsid, { remarks: ev.target.value })}
                            placeholder="Enter remarks…"
                            className={CONTROL}
                          />
                        </td>

                        <td className={cls(PLANTILLA_TD, "align-middle")}>
                          <Dropdown
                            value={statusLabel}
                            onChange={(v) => {
                              setStatus(v).catch(() => {});
                            }}
                            options={["Pending", "Approved", "Rejected"]}
                            placeholder="Pending"
                            className={cls(
                              "max-w-[140px] mx-auto",
                              // color-coordinate statuses (Approved=green, Pending=yellow, Rejected=red)
                              "[&>div>button]:border",
                              statusLabel === "Approved" &&
                                "[&>div>button]:bg-emerald-100 [&>div>button]:text-emerald-800 [&>div>button]:border-emerald-300",
                              statusLabel === "Rejected" &&
                                "[&>div>button]:bg-red-100 [&>div>button]:text-red-800 [&>div>button]:border-red-300",
                              statusLabel === "Pending" &&
                                "[&>div>button]:bg-amber-100 [&>div>button]:text-amber-800 [&>div>button]:border-amber-300"
                            )}
                            searchable={false}
                          />
                        </td>
                      </tr>
                    );
                  })}

                  {receivedRows.length === 0 && !loadingList && (
                    <tr className={PLANTILLA_ROW}>
                      <td className={cls(PLANTILLA_TD, "py-6 text-sm text-gray-500")} colSpan={13}>
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
      </main>
    </div>
  );
}