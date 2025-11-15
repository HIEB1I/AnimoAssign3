// frontend/src/pages/CHAIR/CHAIR_FacultyService.tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Send, ChevronDown, X } from "lucide-react";
import {
  getFSOptions,
  listFacultyService,
  createFacultyService,
  sendFacultyService,
  respondFacultyService,
  rejectFacultyService,
  type FacultyServiceRow,
  type ToDept,
  type DayShort,
  getChairHeader,
} from "@/api";

/* ---------------- tiny utils ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const toast = (msg: string) => alert(msg);
const norm = (s?: string) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
const eqDept = (a?: string, b?: string) => norm(a) === norm(b);

/** unify control heights */
const CONTROL =
  "h-10 w-full rounded-md border border-gray-300 px-3 text-[13px] shadow-sm focus:ring-2 focus:ring-emerald-500/30";

/** shared table look */
const SHARED_TABLE = "w-full table-fixed border-collapse text-[13px]";
const CELL = "px-4 py-2 align-middle";
const TH = "px-4 py-2 font-medium text-xs text-gray-600 tracking-wide text-center";

/** tighter cells just for REQUESTER tables */
const CELL_TIGHT = "px-3 py-1.5 align-middle";
const TH_TIGHT = "px-3 py-1.5 font-medium text-xs text-gray-600 tracking-wide text-center";

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
            className={cls(
              CONTROL,
              "pr-8 text-left",
              !value && "text-neutral-400"
            )}
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
        <ChevronDown
          className="pointer-events-none absolute right-1.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500"
        />
      </div>

      {open && menuRect && (
        <div
          id={menuId}
          style={{
            position: "fixed",
            left: menuRect.left,
            top: menuRect.place === "down" ? menuRect.top : undefined,
            bottom:
              menuRect.place === "up" ? window.innerHeight - menuRect.top : undefined,
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
          {shown.length === 0 && (
            <div className="px-3 py-2 text-[13px] text-neutral-500">No results</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Spec constants ---------------- */
const BEGIN_OPTIONS = [
  "07:30",
  "09:15",
  "11:00",
  "12:45",
  "14:30",
  "16:15",
  "18:00",
  "19:45",
] as const;
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


// Use only M/T/W for the first day, and auto-pair Day2
const DAY1_OPTIONS: DayShort[] = ["M", "T", "W"];

const DAY2_BY_DAY1: Partial<Record<DayShort, DayShort>> = {
  M: "H", // MH
  T: "F", // TF
  W: "S", // WS
};

function ColGroup14() {
  return (
    <colgroup>
      {COLS_14.map((w, i) => (
        <col key={i} style={{ width: w }} />
      ))}
    </colgroup>
  );
}

/** compact requester layout (6 columns) */
const COLS_REQ = ["22ch", "36ch", "8ch", "36ch", "36ch", "14ch"];
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
  course_title: string;
  units: number | null;
  to_department: ToDept | "";
};

function facultyLabel(f?: { first_name?: string; last_name?: string; email?: string }) {
  if (!f) return "";
  const L = (f.last_name || "").toUpperCase();
  const F = (f.first_name || "").toUpperCase();
  return (L || F) ? `${L}, ${F}` : "";
}


/* ---------------- Departments ---------------- */
const REQUESTER_DEPT = "Department of Software Technology"; // only this can send

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
   * If omitted, we default to ST (requester) for backwards compatibility.
   */
  chairDepartmentName?: string;
};

export default function CHAIR_FacultyService({
  chairDepartmentName,
}: ChairFacultyServiceProps) {
  /**
   * DEPARTMENT-BASED BRANCHING (core logic):
   *
   * We derive the "active" department from the logged-in chair.
   * - If it's Software Technology (ST), this screen acts as REQUESTER.
   * - Otherwise, it acts as RECEIVER (IT, CT, LIT).
   */

  // Start with ST (requester) as a safe default while we load the real dept.
  const [activeDeptName, setActiveDeptName] = useState<string>(
    chairDepartmentName || REQUESTER_DEPT
  );

  const isRequesterDept = eqDept(activeDeptName, REQUESTER_DEPT);

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
        const derivedDept =
          header?.dept_label ||
          (subtitle ? subtitle.split("|")[1]?.trim() : "");

        if (derivedDept) {
          setActiveDeptName(derivedDept);
        }
      } catch {
        // ignore; we’ll stay on REQUESTER_DEPT (ST) as fallback
      }
    })();
  }, [chairDepartmentName]);

  const [toDepts, setToDepts] = useState<ToDept[]>([]);
  const [timeBegins] = useState<string[]>([...BEGIN_OPTIONS]);
  const [facultyCache, setFacultyCache] = useState<Record<string, FacultyOption[]>>({});

  const [draft, setDraft] = useState<FSCreate>({
    course_code: "",
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

  const getEditFrom = (all: Record<string, ReceiverEdit>, id: string): ReceiverEdit =>
    all[id] || EMPTY_EDIT;

  const getEdit = (id: string): ReceiverEdit => getEditFrom(edits, id);

  const patchEdit = (id: string, patch: Partial<ReceiverEdit>) =>
    setEdits((prev) => ({
      ...prev,
      [id]: { ...getEditFrom(prev, id), ...patch },
    }));

  const [rows, setRows] = useState<FacultyServiceRow[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // Requester (Software Tech) options for creating requests
  // Only needed when the logged-in CHAIR belongs to ST.
  useEffect(() => {
    if (!isRequesterDept) return;

    (async () => {
      try {
        const o = await getFSOptions({ requesterDepartment: REQUESTER_DEPT });
        if (o?.ok) {
          setToDepts(
            (o.departments || []).filter((d: string) => !eqDept(d, REQUESTER_DEPT)) as ToDept[]
          );
        }
      } catch {
        // ignore
      }
    })();
  }, [isRequesterDept]);

  // Load faculty list per receiver dept
  async function ensureFacultyForDept(dept: string) {
    if (!dept || facultyCache[dept]) return;
    try {
      const o = await getFSOptions({ toDepartment: dept as ToDept });
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
   * Fetch rows for the logged-in CHAIR's department.
   * - ST (requester) sees its SENT requests.
   * - Other departments (IT/CT/LIT) see their RECEIVED requests only.
   */
  async function refresh() {
    setLoadingList(true);
    try {
      const deptForList = isRequesterDept ? REQUESTER_DEPT : activeDeptName;
      const box = (isRequesterDept ? "sent" : "received") as "sent" | "received";
      const res = await listFacultyService({ dept: deptForList, box });
      const rows = (res?.rows || []) as FacultyServiceRow[];
      setRows(rows);
    } finally {
      setLoadingList(false);
    }
  }

  // Course suggestions (Software Tech as requester)
  const [courseTerm, setCourseTerm] = useState("");
  const [courseSuggestions, setCourseSuggestions] = useState<
    Array<{ code: string; title: string; units?: number }>
  >([]);

  useEffect(() => {
    let mounted = true;
    if (!isRequesterDept) return () => {
      mounted = false;
    };

    (async () => {
      try {
        const res = await getFSOptions({ q: courseTerm, requesterDepartment: REQUESTER_DEPT });
        if (mounted && res?.ok) setCourseSuggestions(res.courses || []);
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, [courseTerm, isRequesterDept]);

  const codeOptions = useMemo(
    () => Array.from(new Set((courseSuggestions || []).map((c) => c.code))).sort(),
    [courseSuggestions]
  );

  const canSend = Boolean(
    draft.course_code && draft.course_title && draft.units != null && draft.to_department
  );

  function friendlyError(e: any) {
    const m =
      e?.response?.data?.detail ||
      e?.response?.data?.message ||
      e?.message ||
      "Something went wrong.";
    return typeof m === "string" ? m : JSON.stringify(m);
  }

  async function handleCreateAndSend() {
    try {
      if (!canSend) {
        toast("Please complete Course, Units, and To Department.");
        return;
      }
      const crt = await createFacultyService({
        course_code: draft.course_code,
        course_title: draft.course_title,
        units: draft.units,
        to_department: draft.to_department as ToDept,
        from_department: REQUESTER_DEPT,
      });
      if (!crt?.ok || !crt.row?.fs_id) {
        toast("Failed to create request.");
        return;
      }

      const snd = await sendFacultyService(crt.row.fs_id);

      setRows((prev) => {
        const byId = new Map(prev.map((r) => [r.fs_id!, r]));
        byId.set(snd.row.fs_id!, snd.row);
        return Array.from(byId.values());
      });

      setDraft({ course_code: "", course_title: "", units: null, to_department: "" });
      setCourseTerm("");

      await refresh();
      toast("Request sent.");
    } catch (e: any) {
      toast(friendlyError(e));
    }
  }

  // Preload faculty (for receiver departments only) and reset edits
  // whenever the logged-in CHAIR's department "role" changes.
  useEffect(() => {
    setEdits({});
    if (!isRequesterDept) {
      // Only receiver departments (IT/CT/LIT) need faculty dropdown options.
      ensureFacultyForDept(activeDeptName);
    }
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDeptName, isRequesterDept]);

  async function handleSendBack(fs_id: string, dept: string) {
    const e = getEdit(fs_id);
    try {
      if (!e.faculty?.faculty_id && !e.faculty?.email) {
        toast("Select a faculty.");
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
      toast("Sent back to requesting department.");
    } catch (err: any) {
      toast(friendlyError(err));
    }
  }

  async function handleReject(fs_id: string) {
    try {
      await rejectFacultyService(fs_id, { remarks: getEdit(fs_id).remarks || "" });
      await refresh();
      toast("Request rejected.");
    } catch (err: any) {
      toast(friendlyError(err));
    }
  }

  // For ST, rows are "sent" by ST; for other departments, rows are "received" by that dept.
  const sentRows = isRequesterDept
    ? rows.filter((r) => eqDept(r.from_department, REQUESTER_DEPT))
    : [];

  const receivedRows = !isRequesterDept
    ? rows.filter((r) => eqDept(r.to_department, activeDeptName))
    : [];

  const acceptedRows = useMemo(
    () =>
      isRequesterDept
        ? rows.filter(
            (r) =>
              eqDept(r.from_department, REQUESTER_DEPT) && r.status === "responded"
          )
        : [],
    [isRequesterDept, rows]
  );

  /* ---------------- UI ---------------- */
  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900 px-8 py-8">
      <header className="mb-4">
        <h1 className="text-2xl font-bold">Faculty Service</h1>
        <p className="text-sm text-neutral-600">
          {isRequesterDept
            ? "Create faculty service requests from Software Technology and track their status."
            : `View and respond to faculty service requests addressed to your department.`}
        </p>
      </header>

      {/* REQUESTER VIEW (ST only): Create Request + Sent Requests + Accepted Requests */}
      {isRequesterDept && (
        <>
          {/* 1) CREATE REQUEST (Software Technology as fixed requester) */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-x-auto overflow-y-visible mb-8">
            <div className="px-5 pt-4 text-[14px] text-sm font-semibold text-neutral-800 text-center">
              Create Request
            </div>
            <table className={cls(SHARED_TABLE, "border-t border-gray-200")}>
              <ColGroupReq />
              <thead className="bg-neutral-50">
                <tr>
                  <th className={TH_TIGHT}>Course Code</th>
                  <th className={TH_TIGHT}>Course Title</th>
                  <th className={TH_TIGHT}>Units</th>
                  <th className={TH_TIGHT}>From</th>
                  <th className={TH_TIGHT}>To</th>
                  <th className={TH_TIGHT}>Action</th>
                </tr>
              </thead>

              <tbody className="text-gray-800">
              <tr className="even:bg-gray-50">
                {/* Course Code */}
                <td className={CELL_TIGHT}>
                  <div className="relative">
                    <Dropdown
                      value={draft.course_code}
                      onChange={(code) => {
                        const hit = courseSuggestions.find((c) => c.code === code);
                        setDraft((d) => ({
                          ...d,
                          course_code: code,
                          course_title: hit?.title ?? d.course_title,
                          units: hit?.units ?? d.units,
                        }));
                        setCourseTerm("");
                      }}
                      options={codeOptions}
                      placeholder="Select code…"
                      searchable
                      className="min-w-[10rem] [&>button]:h-9 [&>button]:px-2"
                      onOpen={() => setCourseTerm("")}
                    />
                  </div>
                </td>

                  {/* Course Title (readonly) */}
                  <td className={cls(CELL_TIGHT, "text-center")}>
                    <span className="inline-block max-w-full truncate leading-6 px-1">
                      {draft.course_title || "\u00A0"}
                    </span>
                  </td>

                  {/* Units (readonly) */}
                  <td className={cls(CELL_TIGHT, "text-center tabular-nums")}>
                    <span className="inline-block leading-6">{draft.units ?? "\u00A0"}</span>
                  </td>

                  {/* From */}
                  <td className={cls(CELL_TIGHT, "text-center")}>
                    <span className="inline-block leading-6" title={REQUESTER_DEPT}>
                      {REQUESTER_DEPT}
                    </span>
                  </td>

                  {/* To */}
                  <td className={cls(CELL_TIGHT, "text-center")}>
                    <Dropdown
                      value={draft.to_department}
                      onChange={(v) => setDraft((d) => ({ ...d, to_department: v as ToDept }))}
                      options={toDepts}
                      placeholder="Select department…"
                      className="[&>button]:h-9 [&>button]:px-2"
                    />
                  </td>

                  {/* Action */}
                  <td className={cls(CELL_TIGHT, "text-center")}>
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

         {/* 2) SENT REQUESTS (from Software Technology) */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-x-auto overflow-y-visible">
            <div className="px-5 pt-4 text-[14px] text-sm font-semibold text-neutral-800 text-center">
              Sent Requests
            </div>
            <table className={cls(SHARED_TABLE, "border-t border-gray-200")}>
            <ColGroupSent />
            <thead className="bg-neutral-50">
              <tr>
                <th className={TH_TIGHT}>Course Code & Title</th>
                <th className={TH_TIGHT}>Units</th>
                <th className={TH_TIGHT}>From</th>
                <th className={TH_TIGHT}>To</th>
                <th className={TH_TIGHT}>Status</th>
              </tr>
            </thead>
              <tbody className="text-gray-800">
                {sentRows.map((r, i) => (
                  <tr
                    key={r.fs_id}
                    className={cls(
                      "align-middle",
                      i % 2 === 0 ? "bg-white" : "bg-gray-50",
                      "border-b border-gray-200"
                    )}
                  >
                    <td className={CELL}>
                      <div className="font-semibold text-emerald-700">{r.course_code}</div>
                      <div className="text-[12px] text-neutral-600 leading-tight">
                        {r.course_title}
                      </div>
                    </td>

                    <td className={cls(CELL_TIGHT, "text-center tabular-nums")}>{r.units ?? ""}</td>
                    <td className={cls(CELL_TIGHT, "text-center truncate")} title={r.from_department}>
                      {r.from_department}
                    </td>
                    <td className={cls(CELL_TIGHT, "text-center truncate")} title={r.to_department}>
                      {r.to_department}
                    </td>
                    <td className={cls(CELL_TIGHT, "text-center")}>
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
                        {r.status === "responded"
                          ? "Responded"
                          : r.status === "rejected"
                          ? "Rejected"
                          : "Sent"}
                      </span>
                    </td>
                  </tr>
                ))}
                {sentRows.length === 0 && !loadingList && (
                  <tr>
                    <td className="px-4 py-6 text-center text-sm text-gray-500" colSpan={6}>
                      No sent requests yet.
                    </td>
                  </tr>
                )}
                {loadingList && (
                  <tr>
                    <td className="px-4 py-6 text-center text-sm text-gray-500" colSpan={6}>
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* 3) ACCEPTED REQUESTS (Requester view, already responded) */}
          <div className="mt-8 rounded-xl border border-neutral-200 bg-white/80 shadow-sm">
            <div className="border-b border-neutral-100 px-4 py-3 sm:px-6">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-neutral-800">Accepted Requests</h3>
                </div>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                  {acceptedRows.length} accepted
                </span>
              </div>
            </div>
            <div className="max-h-[420px] overflow-auto">
            <table className="min-w-full table-fixed border-separate border-spacing-0 text-[13px] text-center">
              <ColGroupAccepted />
              <thead className="sticky top-0 z-[1] bg-neutral-50">
                <tr>
                  <th className={`${TH_TIGHT} text-center`}>Course</th>
                  <th className={`${TH_TIGHT} text-center`}>Units</th>
                  <th className={`${TH_TIGHT} text-center`}>From Department</th>
                  <th className={`${TH_TIGHT} text-center`}>Faculty</th>
                  <th className={`${TH_TIGHT} text-center`}>Schedule</th>
                  <th className={`${TH_TIGHT} text-center`}>Status</th>
                  <th className={`${TH_TIGHT} text-center`}>Remarks</th>
                </tr>
              </thead>
                <tbody>
                  {!loadingList && acceptedRows.length === 0 && (
                    <tr>
                      <td
                        className="px-4 py-6 text-center text-sm text-neutral-500"
                        colSpan={7}
                      >
                        No accepted requests yet.
                      </td>
                    </tr>
                  )}
                  {acceptedRows.map((r) => (
                    <tr key={r.fs_id || r.id} className="border-t border-neutral-100">
                      {/* Course */}
                      <td className="whitespace-nowrap px-3 py-2 align-middle text-center">
                        <div className="font-medium text-neutral-800">{r.course_code}</div>
                        <div className="text-xs text-neutral-500">{r.course_title}</div>
                      </td>
                      {/* Units */}
                      <td className="whitespace-nowrap px-3 py-2 align-middle text-center text-xs text-neutral-700">
                        {r.units ?? "—"}
                      </td>
                      {/* From Department */}
                      <td className="whitespace-nowrap px-3 py-2 align-middle text-center text-xs text-neutral-700">
                        {r.from_department}
                      </td>
                      {/* Faculty */}
                      <td className="px-3 py-2 align-middle text-center">
                        {r.faculty?.last_name || r.faculty?.first_name ? (
                          <div className="space-y-0.5">
                            <p className="text-xs font-medium text-neutral-800">
                              {[r.faculty?.last_name, r.faculty?.first_name]
                                .filter(Boolean)
                                .join(", ")}
                            </p>
                            {r.faculty?.email && (
                              <p className="text-[11px] text-neutral-500">{r.faculty.email}</p>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs italic text-neutral-400">Not set</span>
                        )}
                      </td>
                      {/* Schedule */}
                      <td className="px-3 py-2 align-middle text-center text-xs text-neutral-700">
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
                          {!r.day1 &&
                            !r.begin1 &&
                            !r.end1 &&
                            !r.day2 &&
                            !r.begin2 &&
                            !r.end2 && (
                              <span className="text-xs italic text-neutral-400">
                                No schedule set
                              </span>
                            )}
                        </div>
                      </td>
                      {/* Status */}
                      <td className="whitespace-nowrap px-3 py-2 align-middle text-center text-xs">
                        <span className="inline-flex items-center justify-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                          Responded
                        </span>
                      </td>
                      {/* Remarks */}
                      <td className="px-3 py-2 align-middle text-center text-xs text-neutral-700">
                        {r.remarks || (
                          <span className="italic text-neutral-400">No remarks</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* RECEIVER VIEW (IT/CT/LIT): Received Requests only */}
      {!isRequesterDept && (
        <>
          {/* RECEIVED REQUESTS (editable, full; based on logged-in receiver department) */}
          <div className="mt-8 rounded-xl border border-gray-200 bg-white shadow-sm overflow-x-auto overflow-y-visible">
            <div className="px-5 pt-4 text-[13px] text-neutral-600">Received Requests</div>
            <table className={cls(SHARED_TABLE, "border-t border-gray-200")}>
              <ColGroup14 />
              <thead className="bg-neutral-50">
                <tr>
                  <th className={cls(TH, "text-left")}>Course Code &amp; Title</th>
                  <th className={TH}>Units</th>
                  <th className={TH}>From</th>
                  <th className={TH}>To</th>
                  <th className={TH}>Faculty</th>
                  <th className={TH}>Day1</th>
                  <th className={TH}>Begin1</th>
                  <th className={TH}>End1</th>
                  <th className={TH}>Day2</th>
                  <th className={TH}>Begin2</th>
                  <th className={TH}>End2</th>
                  <th className={TH}>Remarks</th>
                  <th className={TH}>Action</th>
                </tr>
              </thead>


              <tbody className="text-gray-800">
                {receivedRows.map((r, idx) => {
                  const fsid = r.fs_id!;
                  const dept = r.to_department || "";
                  const e = getEdit(fsid);
                  const facultyOptions = facultyCache[dept] || [];
                  const isClosed = r.status === "responded" || r.status === "rejected";

                  return (
                    <tr
                      key={fsid}
                      className={cls(
                        "align-middle",
                        idx % 2 === 0 ? "bg-white" : "bg-gray-50",
                        "border-b border-gray-200"
                      )}
                      onMouseEnter={() => ensureFacultyForDept(dept)}
                    >
                      <td className={CELL}>
                        <div className="font-semibold text-emerald-700">{r.course_code}</div>
                        <div className="text-[12px] text-neutral-600 leading-tight">
                          {r.course_title}
                        </div>
                      </td>


                      <td className={cls(CELL, "text-center tabular-nums")}>{r.units ?? ""}</td>
                      <td className={cls(CELL, "text-center truncate")} title={r.from_department}>
                        {r.from_department}
                      </td>
                      <td className={cls(CELL, "text-center truncate")} title={r.to_department}>
                        {r.to_department}
                      </td>

                      {/* Faculty */}
                      <td className={CELL}>
                        {!isClosed ? (
                          <Dropdown
                            value={
                              e.faculty?.faculty_id
                                ? facultyOptions.find(
                                    (f) => f.faculty_id === e.faculty?.faculty_id
                                  )?.label || ""
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
                          <span
                            className="block truncate text-center"
                            title={facultyLabel(r.faculty as any)}
                          >
                            {facultyLabel(r.faculty as any) || "—"}
                          </span>
                        )}
                      </td>

                      {/* Day1 (M/T/W only, auto-pairs Day2) */}
                      <td className={cls(CELL, "text-center")}>
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
                      <td className={cls(CELL, "text-center")}>
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
                      <td className={cls(CELL, "text-center")}>
                        {!isClosed ? (
                          <input
                            value={e.end1 ? String(e.end1) : ""}
                            readOnly
                            className={cls(CONTROL, "text-center bg-neutral-50")}
                            placeholder="—"
                          />
                        ) : (
                          r.end1 || "—"
                        )}
                      </td>

                      {/* Day2 (auto from Day1: MH / TF / WS) */}
                      <td className={cls(CELL, "text-center")}>
                        {!isClosed ? (
                          <input
                            className={cls(CONTROL, "h-9 text-center bg-neutral-50")}
                            readOnly
                            value={e.day2 || ""}
                            placeholder="—"
                          />
                        ) : (
                          r.day2 || "—"
                        )}
                      </td>

                      {/* Begin2 */}
                      <td className={cls(CELL, "text-center")}>
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
                      <td className={cls(CELL, "text-center")}>
                        {!isClosed ? (
                          <input
                            value={e.end2 ? String(e.end2) : ""}
                            readOnly
                            className={cls(CONTROL, "text-center bg-neutral-50")}
                            placeholder="—"
                          />
                        ) : (
                          r.end2 || "—"
                        )}
                      </td>

                      {/* Remarks */}
                      <td className={CELL}>
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
                      <td className={cls(CELL, "text-center")}>
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
                                  <Send className="h-4 w-4" />
                                  Send
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
                  <tr>
                    <td className="px-4 py-6 text-center text-sm text-gray-500" colSpan={14}>
                      No received requests for your department.
                    </td>
                  </tr>
                )}
                {loadingList && (
                  <tr>
                    <td className="px-4 py-6 text-center text-sm text-gray-500" colSpan={14}>
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
