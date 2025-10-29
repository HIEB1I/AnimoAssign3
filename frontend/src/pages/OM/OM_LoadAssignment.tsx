import React, { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import AppShell from "../../base/AppShell";

import {
  getOmLoadAssignmentList,
  getOmLoadAssignmentProfile,   // ← add this
  submitOmLoadAssignment,
} from "../../api";


import { cls } from "../../utilities/cls";
import {
  ChevronDown,
  Search as SearchIcon,
  Upload,
  Play,
  RefreshCcw,
  Send,
  Save,
  CheckCheck,
  Plus,
  MessageSquareText,
  Check,
  Trash2,
  X,
} from "lucide-react";
import { InboxContent as OMInboxContent } from "./OM_Inbox";

/* ---------------- Small inputs ---------------- */
function SelectBox({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<number>(() =>
    Math.max(0, options.findIndex((o) => o === value))
  );
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className={cls("relative min-w-[120px]", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cls(
          "w-full rounded-md border border-gray-300 bg-white",
          "px-1.5 py-1 text-center text-[13px] leading-tight",
          "shadow-sm focus:ring-2 focus:ring-emerald-500/30"
        )}
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2" />
      </button>

      {open && (
        <div
          ref={listRef}
          className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl"
        >
          {options.map((opt, i) => (
            <button
              key={opt}
              onMouseEnter={() => setHover(i)}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls(
                "block w-full px-4 py-2 text-left text-sm",
                i === hover && "bg-emerald-50",
                value === opt && "bg-emerald-100 text-emerald-800 font-medium"
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TextBox({
  value,
  onChange,
  placeholder = "",
  className = "",
  disabled = false,
  align = "left",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  align?: "left" | "center";
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cls(
        "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
        "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
        "placeholder-gray-400",
        align === "center" && "text-center",
        disabled && "cursor-not-allowed bg-gray-100 text-gray-400 opacity-70",
        className
      )}
    />
  );
}

/* --------- Searchable + typeable ComboBox (for Faculty) --------- */
function ComboBox({
  value,
  onChange,
  options,
  placeholder = "— Select or type —",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value ?? "");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value ?? ""), [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div ref={wrapRef} className={cls("relative", className)}>
      <input
        className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-8 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          onChange(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
      />
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />

      {open && (
        <div className="absolute z-30 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl">
          {filtered.length === 0 ? (
            <div className="px-4 py-2 text-sm text-gray-500">No matches</div>
          ) : (
            filtered.map((opt) => (
              <button
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setQuery(opt);
                  setOpen(false);
                }}
                className="block w-full px-4 py-2 text-left text-sm hover:bg-emerald-50"
              >
                {opt}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Types + helpers ---------------- */
type Row = {
  id: string;
  selected?: boolean;
  course: string;
  title: string;
  units: number | "";
  section: string;
  faculty: string;
  day1: string;
  begin1: string;
  end1: string;
  room1: string;
  day2: string;
  begin2: string;
  end2: string;
  room2: string;
  capacity: number | "";
  status?: "" | "Confirmed" | "Pending" | "Unassigned" | "Conflict";
  conflictNote?: string;
  editable?: boolean;
};

const toPrettyTime = (t?: string) => {
  if (!t) return "";
  const s = t.trim();
  if (!/^\d{3,4}$/.test(s)) return t;
  const hh = s.length === 3 ? s.slice(0, 1) : s.slice(0, 2);
  const mm = s.slice(-2);
  return `${parseInt(hh, 10)}:${mm}`;
};
const timeRange = (begin?: string, end?: string) => {
  const b = toPrettyTime(begin);
  const e = toPrettyTime(end);
  return b && e ? `${b}–${e}` : b || e || "—";
};

const DAY_OPTIONS = ["M", "T", "W", "H", "F", "S"];
function buildTimeStartOptions() {
  const out: string[] = [];
  let h = 7;
  let m = 30;
  while (h < 21) {
    const hh = String(h).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    out.push(`${hh}${mm}`);
    m += 105;
    if (m >= 60) {
      h += Math.floor(m / 60);
      m = m % 60;
    }
    if (h >= 21) break;
  }
  return out;
}
function buildTimeEndOptions() {
  const starts = buildTimeStartOptions();
  return starts.map((t) => {
    const h = parseInt(t.slice(0, 2));
    const m = parseInt(t.slice(2));
    let endH = h;
    let endM = m + 90;
    if (endM >= 60) {
      endH += Math.floor(endM / 60);
      endM = endM % 60;
    }
    return `${String(endH).padStart(2, "0")}${String(endM).padStart(2, "0")}`;
  });
}
const TIME_BEGIN_OPTIONS = buildTimeStartOptions();
const TIME_END_OPTIONS = buildTimeEndOptions();

/* ---------------- Reusable small components ---------------- */
const StatusChip = ({ r }: { r: Row }) => {
  const [show, setShow] = useState(false);
  const [place, setPlace] = useState<"top" | "bottom">("bottom");
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!show || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setPlace(below < 72 ? "top" : "bottom");
  }, [show]);

  if (!r.status) return <span className="inline-block w-24 h-6" />;
  const tone =
    r.status === "Confirmed"
      ? "bg-green-100 text-green-700"
      : r.status === "Pending"
      ? "bg-yellow-100 text-yellow-700"
      : r.status === "Unassigned"
      ? "bg-gray-200 text-gray-700"
      : "bg-red-600 text-white";

  return (
    <span
      ref={ref}
      className={cls(
        "inline-flex h-6 min-w-[6rem] items-center justify-center rounded-full px-3 text-xs font-semibold",
        tone,
        "relative"
      )}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      tabIndex={0}
    >
      {r.status === "Conflict" ? "Conflict" : r.status}
      {r.status === "Conflict" && r.conflictNote && show && (
        <div
          className={cls(
            "absolute z-[2000] w-[min(70vw,260px)] rounded-md border border-gray-200 bg-white px-3 py-2",
            "text-[12px] leading-snug text-gray-900 shadow-xl whitespace-normal break-words",
            place === "bottom"
              ? "top-[110%] left-1/2 -translate-x-1/2"
              : "bottom-[110%] left-1/2 -translate-x-1/2"
          )}
          role="status"
        >
          <span
            className={cls(
              "absolute block h-2 w-2 rotate-45 border border-gray-200 bg-white",
              place === "bottom"
                ? "-top-1 left-1/2 -translate-x-1/2 border-b-0 border-r-0"
                : "-bottom-1 left-1/2 -translate-x-1/2 border-t-0 border-l-0"
            )}
          />
          {r.conflictNote}
        </div>
      )}
    </span>
  );
};

const ApproveModal = ({
  open,
  onClose,
  onApprove,
}: {
  open: boolean;
  onClose: () => void;
  onApprove: () => void;
}) =>
  !open ? null : (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
          <Check className="h-8 w-8" strokeWidth={2.5} />
        </div>
        <h3 className="mb-2 text-center text-2xl font-semibold">Are you sure?</h3>
        <p className="mx-auto mb-6 max-w-md text-center text-sm text-neutral-600">
          Please confirm that this is the final <span className="font-semibold">Faculty Load
          Assignment</span> to be submitted to the <span className="font-semibold">Office Assistant</span>.
          Once submitted, this action cannot be undone and the button will be disabled.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200">Cancel</button>
          <button onClick={onApprove} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110">Yes, I Approve</button>
        </div>
      </div>
    </div>
  );

const SendModal = ({
  open,
  onClose,
  rows,
}: {
  open: boolean;
  onClose: () => void;
  rows: Row[];
}) => {
  if (!open) return null;
  const byFaculty = Object.entries(
    rows.reduce<Record<string, Row[]>>((acc, r) => {
      const k = r.faculty || "Unassigned";
      (acc[k] ||= []).push(r);
      return acc;
    }, {})
  );
  const manyGroups = byFaculty.length > 1;

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-5xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-1">
          <h3 className="text-[22px] font-extrabold text-emerald-700">
            Teaching Load Assignments for Term 1, AY 2025 - 2026
          </h3>
          <div className="mt-0.5 text-[11px] text-gray-600">
            To: {Array.from(new Set(rows.map((r) => r.faculty || "Unassigned"))).join(", ")}
          </div>
        </div>

        <p className="mt-5 text-[13px] text-gray-700">
          Please let me know if the following teaching load below is acceptable to you:
        </p>

        <div className="mt-4">
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full table-fixed text-[13px]">
              <colgroup>
                <col className="w-[140px]" />
                <col />
                <col className="w-[90px]" />
                <col className="w-[72px]" />
                <col className="w-[120px]" />
                <col className="w-[110px]" />
                <col className="w-[70px]" />
                <col className="w-[120px]" />
                <col className="w-[120px]" />
              </colgroup>
              <thead className="bg-gray-50 text-gray-700">
                <tr className="[&>th]:border-b [&>th]:border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold">Course Code</th>
                  <th className="px-4 py-3 text-left font-semibold">Course Title</th>
                  <th className="px-4 py-3 text-left font-semibold">Section</th>
                  <th className="px-4 py-3 text-left font-semibold">Units</th>
                  <th className="px-4 py-3 text-left font-semibold">Campus</th>
                  <th className="px-4 py-3 text-left font-semibold">Mode</th>
                  <th className="px-4 py-3 text-left font-semibold">Day</th>
                  <th className="px-4 py-3 text-left font-semibold">Room</th>
                  <th className="px-4 py-3 text-left font-semibold">Time</th>
                </tr>
              </thead>
              <tbody className="text-gray-900">
                {byFaculty.map(([faculty, items]) => (
                  <React.Fragment key={faculty}>
                    {manyGroups && (
                      <tr className="bg-white">
                        <td colSpan={9} className="px-4 pt-5 pb-2 text-[12px] font-semibold text-gray-900">
                          {faculty}
                        </td>
                      </tr>
                    )}
                    {items.map((r) => (
                      <tr key={r.id} className={cls("bg-white", "[&>td]:border-t [&>td]:border-gray-100")}>
                        <td className="px-4 py-3 align-middle">{r.course || "—"}</td>
                        <td className="px-4 py-3 align-middle truncate">{r.title || "—"}</td>
                        <td className="px-4 py-3 align-middle">{r.section || "—"}</td>
                        <td className="px-4 py-3 align-middle">{r.units !== "" ? String(r.units) : "—"}</td>
                        <td className="px-4 py-3 align-middle text-gray-800">—</td>
                        <td className="px-4 py-3 align-middle text-gray-800">—</td>
                        <td className="px-4 py-3 align-middle">{r.day1 || "—"}</td>
                        <td className="px-4 py-3 align-middle">{r.room1 || "—"}</td>
                        <td className="px-4 py-3 align-middle">{timeRange(r.begin1, r.end1)}</td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-sm text-gray-500">
                      No rows selected.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200">Cancel</button>
          <button onClick={onClose} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:brightness-110">
            <Send className="h-4 w-4" />
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

const RequestChangeModal = ({
  open,
  from,
  onClose,
}: {
  open: boolean;
  from?: string;
  onClose: () => void;
}) =>
  !open ? null : (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl relative">
        <button
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 hover:bg-gray-100"
          onClick={onClose}
        >
          <X className="h-5 w-5 text-gray-500" />
        </button>

        <h3 className="text-lg font-semibold text-emerald-700 mb-4">Request for Change</h3>
        <div className="text-sm text-gray-600 mb-4">
          From: <span className="font-semibold">{from}</span>
        </div>

        <div className="grid gap-2 text-sm mb-4">
          <div>
            <div className="font-semibold text-gray-900">Change</div>
            <div className="text-gray-700">Change Class Time</div>
          </div>
          <div>
            <div className="font-semibold text-gray-900">Time</div>
            <div className="text-gray-700">11:00AM - 12:30PM</div>
          </div>
          <div>
            <div className="font-semibold text-gray-900">Other remarks</div>
            <div className="text-gray-700">Other commitments to that timeframe.</div>
          </div>
        </div>

        <label className="block text-sm font-medium mb-1">Reply</label>
        <textarea
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30 mb-6"
          rows={4}
          placeholder="Type your reply..."
        />

        <div className="flex justify-end gap-2">
          <button className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm">Reject</button>
          <button className="px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm">Approve</button>
          <button className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm" onClick={onClose}>
            Reply
          </button>
        </div>
      </div>
    </div>
  );

/* ---------------- Main ---------------- */
export default function OM_LoadAssignment() {
    // Session (DB-driven, no hardcodes)
  const session: { user_id?: string; full_name?: string; roles?: string[] } | null = (() => {
    try { return JSON.parse(localStorage.getItem("animo.user") || "null"); } catch { return null; }
  })();
  const userId = session?.user_id || localStorage.getItem("userId") || "";

  // TopBar profile from DB (fallback to session)
  const [profileName, setProfileName] = useState<string>(session?.full_name || "");
  const [profileSubtitle, setProfileSubtitle] = useState<string>("");

  // Term label from backend (no hardcoding)
  const [term, setTerm] = useState<string>("");

  useEffect(() => {
    (async () => {
      if (!userId) return;
      try {
        const p = await getOmLoadAssignmentProfile(userId);
        // p: { ok: boolean; staff_id?: string; position_title?: string }
        if (session?.roles?.includes("office_manager")) {
          setProfileSubtitle("Office Manager"); // role-driven label only
        } else if (p?.position_title) {
          setProfileSubtitle(p.position_title);
        }
        // prefer session full_name; if missing, keep whatever the TopBar shows
        if (!profileName && session?.full_name) setProfileName(session.full_name);
      } catch {/* ignore; non-blocking for UI */}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  type Mode = "idle" | "manual" | "run";
  const [mode, setMode] = useState<Mode>("idle");
  const isRunning = mode !== "idle";
  const isRun = mode === "run";
  const hasReco = isRunning && rows.length > 0;
  const [showApprove, setShowApprove] = useState(false);
  const [approved, setApproved] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [reqChange, setReqChange] = useState<{ open: boolean; from?: string }>({
    open: false,
  });

  // Show the main Load Assignment content only on /om or /om/load-assignment
  const loc = useLocation();
  const isIndex = /\/om(\/load-assignment)?$/.test(loc.pathname);


  // === Inbox-as-tab behavior (mirrors Faculty) ===
  const [showInbox, setShowInbox] = useState(false);
  useEffect(() => {
    const onOpen = () => setShowInbox(true);
    const onClose = () => setShowInbox(false);
    window.addEventListener("om:openInbox" as any, onOpen);
    window.addEventListener("om:closeInbox" as any, onClose);
    return () => {
      window.removeEventListener("om:openInbox" as any, onOpen);
      window.removeEventListener("om:closeInbox" as any, onClose);
    };
  }, []);

  const setCell = <K extends keyof Row>(id: string, key: K, val: Row[K]) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [key]: val } : r)));

  const filtered = rows.filter((r) => {
    const s = search.trim().toLowerCase();
    if (!s) return true;
    return (
      r.course.toLowerCase().includes(s) ||
      (r.faculty || "").toLowerCase().includes(s) ||
      (r.section || "").toLowerCase().includes(s)
    );
  });

  const allSelected = isRunning && filtered.length > 0 && filtered.every((r) => r.selected);
  const toggleSelectAll = (checked: boolean) =>
    setRows((prev) =>
      prev.map((r) => (filtered.some((fr) => fr.id === r.id) ? { ...r, selected: checked } : r))
    );
  const selectedRows = rows.filter((r) => r.selected);
  const anySelected = selectedRows.length > 0;

    const loadFromServer = async () => {
    if (!userId) return;
    const res = await getOmLoadAssignmentList(userId);
    setRows(Array.isArray(res?.rows) ? res.rows : []);
    setTerm(typeof res?.term === "string" ? res.term : ""); // term label joined in backend
    setMode("run");
    setApproved(false);
  };



  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        course: "",
        title: "",
        units: "",
        section: "",
        faculty: "",
        day1: "",
        begin1: "",
        end1: "",
        room1: "",
        day2: "",
        begin2: "",
        end2: "",
        room2: "",
        capacity: "",
        status: "",
        editable: true,
      },
    ]);
    setMode("manual");
    setApproved(false);
  };

  const getEditFlags = (r: Row) => {
    const editAll = !!r.editable;
    const editSchedule = editAll || isRun;
    return {
      course: editAll,
      title: editAll,
      units: editAll,
      section: editAll,
      faculty: editSchedule,
      day1: editSchedule,
      begin1: editSchedule,
      end1: editSchedule,
      room1: editAll,
      day2: editSchedule,
      begin2: editSchedule,
      end2: editSchedule,
      room2: editAll,
      capacity: editAll,
    } as const;
  };

  const Cell = ({
    editable,
    value,
    onChange,
    className = "",
    align = "left",
    placeholder = "",
    displayClass = "",
  }: {
    editable: boolean;
    value: string;
    onChange: (v: string) => void;
    className?: string;
    align?: "left" | "center";
    placeholder?: string;
    displayClass?: string;
  }) =>
    editable ? (
      <TextBox
        value={value}
        onChange={onChange}
        className={className}
        align={align}
        placeholder={placeholder}
      />
    ) : value ? (
      <span className={displayClass}>{value}</span>
    ) : (
      <>—</>
    );

    const facultyOptions = useMemo(() => {
    // strictly DB-derived: only from fetched rows
    const set = new Set<string>();
    rows.forEach((r) => r.faculty && set.add(r.faculty));
    return Array.from(set).sort();
    }, [rows]);


  return (
      <AppShell
      // make TopBar’s Inbox icon open our OM Inbox-as-tab
      topbarProfileName={profileName || " "}
      topbarProfileSubtitle={profileSubtitle || " "}
      // @ts-ignore
      topbarInboxEvent="om:openInbox"
    >

      {/* If Inbox is opened from the TopBar, show it like a tab */}
      {showInbox ? (
        <OMInboxContent />
      ) : (
        <>
          {/* Child “tabs” (Course Mgt, Faculty Form, etc.) render here */}
          <Outlet />

          {/* Show the main Load Assignment UI only on /om or /om/load-assignment */}
          {isIndex && (
            <main className="w-full px-8 py-8">
          <header className="mb-6 flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">
                Load Assignment <span className="text-gray-400">|</span>{" "}
                <span className="font-black">{term}</span>
              </h1>
              <p className="text-sm text-gray-600">
                Manage course assignments and faculty workload distribution
              </p>
            </div>
          </header>

          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="relative flex-1 min-w-[260px]">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by course, section, or faculty..."
                className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                disabled={!hasReco || approved}
                className={cls(
                  "inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium shadow-sm",
                  hasReco && !approved
                    ? "bg-gray-800 text-white hover:brightness-110"
                    : "bg-gray-200 text-gray-500 cursor-not-allowed"
                )}
                title={
                  !hasReco
                    ? "No recommendations to save yet"
                    : approved
                    ? "Already approved"
                    : "Save Draft"
                }
              >
                <Save className="h-4 w-4" />
                Save Draft
              </button>
              <button
                disabled={!hasReco || approved}
                onClick={() => setShowApprove(true)}
                className={cls(
                  "inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium shadow-sm",
                  hasReco && !approved
                    ? "bg-emerald-700 text-white hover:brightness-110"
                    : "bg-gray-200 text-gray-500 cursor-not-allowed"
                )}
                title={
                  !hasReco
                    ? "No recommendations to approve yet"
                    : approved
                    ? "Already approved"
                    : "Approve"
                }
              >
                <CheckCheck className="h-4 w-4" />
                Approve
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-4">
              <h2 className="text-lg font-semibold">Load Recommendations</h2>

              {!isRunning ? (
                <div className="flex items-center gap-2">
                  <button className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
                    <Upload className="h-4 w-4" />
                    Import CSV
                  </button>
                  <button
                    onClick={loadFromServer}
                    className="inline-flex items-center gap-2 rounded-md border border-emerald-700 text-emerald-800 bg-white px-3.5 py-2 text-sm font-medium hover:bg-emerald-50"
                  >
                    <Play className="h-4 w-4" />
                    Run
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    disabled={!anySelected}
                    onClick={() => setShowSend(true)}
                    className={cls(
                      "inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium shadow-sm",
                      anySelected
                        ? "bg-blue-600 text-white hover:brightness-110"
                        : "bg-gray-200 text-gray-500 cursor-not-allowed"
                    )}
                    title={anySelected ? "Send to selected faculty" : "Select at least one row"}
                  >
                    <Send className="h-4 w-4" />
                    To Faculty
                  </button>
                  <button
                    onClick={loadFromServer}
                    className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium hover:bg-gray-50"
                  >
                    <RefreshCcw className="h-4 w-4" />
                    Refresh
                  </button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto overflow-y-auto max-h-[58vh] mt-3">
              <table className="min-w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-[46px]" />
                  <col className="w-[160px]" />
                  <col className="w-[26%]" />
                  <col className="w-[70px]" />
                  <col className="w-[80px]" />
                  <col className="w-[18%]" />
                  <col className="w-[72px]" />
                  <col className="w-[96px]" />
                  <col className="w-[96px]" />
                  <col className="w-[96px]" />
                  <col className="w-[72px]" />
                  <col className="w-[96px]" />
                  <col className="w-[96px]" />
                  <col className="w-[96px]" />
                  <col className="w-[80px]" />
                  <col className="w-[100px]" />
                  <col className="w-[110px]" />
                </colgroup>

                <thead className="bg-gray-50 border-y text-gray-700">
                  <tr className="whitespace-nowrap">
                    <th className="px-3 py-2 text-center">
                      {isRunning && (
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={(e) => toggleSelectAll(e.target.checked)}
                          className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                          title="Select all"
                        />
                      )}
                    </th>
                    <th className="text-left px-4 py-2">Course & Title</th>
                    <th className="text-center px-2 py-2">Units</th>
                    <th className="text-center px-2 py-2">Section</th>
                    <th className="text-left px-4 py-2">Faculty</th>
                    <th className="text-center px-2 py-2">Day 1</th>
                    <th className="text-center px-2 py-2">Begin 1</th>
                    <th className="text-center px-2 py-2">End 1</th>
                    <th className="text-center px-2 py-2">Room 1</th>
                    <th className="text-center px-2 py-2">Day 2</th>
                    <th className="text-center px-2 py-2">Begin 2</th>
                    <th className="text-center px-2 py-2">End 2</th>
                    <th className="text-center px-2 py-2">Room 2</th>
                    <th className="text-center px-2 py-2">Capacity</th>
                    <th className="text-center px-2 py-2">Status</th>
                    <th className="text-center px-2 py-2">Actions</th>
                  </tr>
                </thead>

                <tbody className="divide-y">
                  {filtered.map((r, idx) => {
                    const e = getEditFlags(r);
                    const unread = r.status === "Pending";
                    return (
                      <tr key={r.id} className="hover:bg-gray-50 whitespace-nowrap">
                        <td className="px-3 py-2 text-center">
                          {isRunning && (
                            <input
                              type="checkbox"
                              checked={!!r.selected}
                              onChange={(ev) => setCell(r.id, "selected", ev.target.checked as any)}
                              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                              title={`Select row ${idx + 1}`}
                            />
                          )}
                        </td>

                        <td className="px-4 py-2 align-top">
                          <div>
                            <div className="font-semibold text-emerald-700">{r.course || "—"}</div>
                            <div className="text-gray-600 text-sm">{r.title || "—"}</div>
                          </div>
                        </td>

                        <td className="px-2 py-2 text-center">
                          <Cell
                            editable={e.units}
                            value={String(r.units ?? "")}
                            onChange={(v) => setCell(r.id, "units", v as any)}
                            className="w-[60px]"
                            align="center"
                          />
                        </td>

                        <td className="px-2 py-2 text-center">
                          <Cell
                            editable={e.section}
                            value={r.section}
                            onChange={(v) => setCell(r.id, "section", v)}
                            className="w-[68px]"
                            align="center"
                          />
                        </td>

                        <td className="px-4 py-2">
                          {e.faculty ? (
                            <ComboBox
                              value={r.faculty}
                              onChange={(v) => setCell(r.id, "faculty", v)}
                              options={facultyOptions}
                              className="w-[200px] md:w-[240px] lg:w-[280px]"
                            />
                          ) : (
                            <span className="block w-[200px] md:w-[240px] lg:w-[280px] truncate">
                              {r.faculty || "—"}
                            </span>
                          )}
                        </td>

                        <td className="px-2 py-2 text-center">
                          {e.day1 ? (
                            <SelectBox
                              value={r.day1}
                              onChange={(v) => setCell(r.id, "day1", v)}
                              options={DAY_OPTIONS}
                              className="w-[70px] text-center"
                            />
                          ) : (
                            <span>{r.day1 || "—"}</span>
                          )}
                        </td>

                        <td className="px-2 py-2 text-center">
                          {e.begin1 ? (
                            <SelectBox
                              value={r.begin1}
                              onChange={(v) => setCell(r.id, "begin1", v)}
                              options={TIME_BEGIN_OPTIONS}
                              className="w-[70px] text-center"
                            />
                          ) : (
                            <span>{r.begin1 || "—"}</span>
                          )}
                        </td>

                        <td className="px-2 py-2 text-center">
                          {e.end1 ? (
                            <SelectBox
                              value={r.end1}
                              onChange={(v) => setCell(r.id, "end1", v)}
                              options={TIME_END_OPTIONS}
                              className="w-[70px] text-center"
                            />
                          ) : (
                            <span>{r.end1 || "—"}</span>
                          )}
                        </td>

                        <td className="px-2 py-2 text-center">
                          <Cell
                            editable={e.room1}
                            value={r.room1}
                            onChange={(v) => setCell(r.id, "room1", v)}
                            className="w-[96px]"
                            align="center"
                          />
                        </td>

                        <td className="px-2 py-2 text-center">
                          {e.day2 ? (
                            <SelectBox
                              value={r.day2}
                              onChange={(v) => setCell(r.id, "day2", v)}
                              options={DAY_OPTIONS}
                              className="w-[70px] text-center"
                            />
                          ) : (
                            <span>{r.day2 || "—"}</span>
                          )}
                        </td>

                        <td className="px-2 py-2 text-center">
                          {e.begin2 ? (
                            <SelectBox
                              value={r.begin2}
                              onChange={(v) => setCell(r.id, "begin2", v)}
                              options={TIME_BEGIN_OPTIONS}
                              className="w-[70px] text-center"
                            />
                          ) : (
                            <span>{r.begin2 || "—"}</span>
                          )}
                        </td>

                        <td className="px-2 py-2 text-center">
                          {e.end2 ? (
                            <SelectBox
                              value={r.end2}
                              onChange={(v) => setCell(r.id, "end2", v)}
                              options={TIME_END_OPTIONS}
                              className="w-[70px] text-center"
                            />
                          ) : (
                            <span>{r.end2 || "—"}</span>
                          )}
                        </td>

                        <td className="px-2 py-2 text-center">
                          <Cell
                            editable={e.room2}
                            value={r.room2}
                            onChange={(v) => setCell(r.id, "room2", v)}
                            className="w-[96px]"
                            align="center"
                          />
                        </td>

                        <td className="px-2 py-2 text-center">
                          <Cell
                            editable={e.capacity}
                            value={String(r.capacity ?? "")}
                            onChange={(v) => setCell(r.id, "capacity", v as any)}
                            className="w-[64px]"
                            align="center"
                          />
                        </td>

                        <td className="px-2 py-2 text-center">
                          <StatusChip r={r} />
                        </td>

                        <td className="px-2 py-2 text-center">
                          {isRunning && (
                            <div className="relative flex items-center justify-center gap-3 text-emerald-700">
                              <button
                                className="relative hover:brightness-110"
                                title="Message"
                                onClick={() => setReqChange({ open: true, from: r.faculty || "Faculty" })}
                              >
                                <MessageSquareText className="h-5 w-5" />
                                {unread && (
                                  <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-600" />
                                )}
                              </button>

                              <button
                                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-emerald-700 text-emerald-700 hover:bg-emerald-50"
                                title="Approve row"
                              >
                                <Check className="h-4 w-4" strokeWidth={2.5} />
                              </button>

                              {String(r.id).startsWith("manual-") && (
                                <button
                                  className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                                  title="Remove this line"
                                  onClick={() =>
                                    setRows((prev) => prev.filter((row) => row.id !== r.id))
                                  }
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={17} className="px-4 py-10 text-center text-sm text-gray-500">
                        No data yet. Click <span className="font-medium">Run</span> or{" "}
                        <span className="font-medium">Add new line</span> to begin.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="border-t px-4 py-3">
              <div className="flex justify-start">
                <button
                  onClick={addRow}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-400 px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-100"
                  title="Add new line"
                >
                  <Plus className="h-4 w-4" />
                  Add new line
                </button>
              </div>
            </div>
          </div>
        </main>
          )}
        </>
      )}
      
      <ApproveModal

        open={showApprove}
        onClose={() => setShowApprove(false)}
                onApprove={() => {
          (async () => {
            try {
              if (userId) {
                // minimal optimistic submit; backend returns display-ready rows
                await submitOmLoadAssignment(userId, { rows });
              }
              setApproved(true);
            } finally {
              setShowApprove(false);
            }
          })();
        }}
      />

      <SendModal open={showSend} onClose={() => setShowSend(false)} rows={selectedRows} />

      <RequestChangeModal
        open={reqChange.open}
        from={reqChange.from}
        onClose={() => setReqChange({ open: false })}
      />
    </AppShell>
  );
}
