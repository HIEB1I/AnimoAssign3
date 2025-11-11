import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Send, ChevronDown, CornerUpLeft, X } from "lucide-react";
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
} from "@/api";

/* ---------------- tiny utils ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const toast = (msg: string) => alert(msg);

/** unify control heights — roomier */
const CONTROL =
  "h-10 w-full rounded-md border border-gray-300 px-3 text-[13px] shadow-sm focus:ring-2 focus:ring-emerald-500/30";

/* ---------------- Dropdown (portal-less, fixed-positioned) ---------------- */
function Dropdown({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "",
  searchable = false,
  align = "left",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  searchable?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);

  // fixed menu placement data
  const [menuRect, setMenuRect] = useState<{ left: number; top: number; width: number; place: "down" | "up" }>();

  const shown = useMemo(
    () => (!searchable || !term ? options : options.filter((o) => o.toLowerCase().includes(term.toLowerCase()))),
    [term, options, searchable]
  );

  // compute fixed coordinates so the menu is never clipped by overflow
  const compute = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const estMenuH = Math.min(48 + shown.length * 36, Math.floor(vh * 0.6)); // approx header + items
    const roomBelow = vh - r.bottom;
    const place: "down" | "up" = roomBelow >= estMenuH || r.top < estMenuH ? "down" : "up";
    let left = r.left;
    const width = Math.max(r.width, 220);
    if (align === "right") left = Math.max(8, Math.min(vw - width - 8, r.right - width));
    else left = Math.max(8, Math.min(vw - width - 8, r.left));
    const top = place === "down" ? Math.min(vh - 8, r.bottom + 8) : Math.max(8, r.top - 8);
    setMenuRect({ left, top, width, place });
  };

  // open/close + listeners
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open) return;
      const t = e.target as Node;
      if (btnRef.current && !btnRef.current.contains(t)) {
        // clicks outside menu (which is fixed) close as well
        const menu = document.getElementById(menuId);
        if (!menu || !menu.contains(t)) setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // recalc on open / resize / scroll
  useLayoutEffect(() => {
    if (!open) return;
    compute();
    const onResize = () => compute();
    const onScroll = () => compute();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    // ensure button is visible in a scrollable container
    btnRef.current?.scrollIntoView({ block: "nearest" });
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, term, align, shown.length]);

  const menuId = useMemo(() => `dd-${Math.random().toString(36).slice(2)}`, []);

  return (
    <div className={cls("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cls(CONTROL, "truncate pr-8 text-left")}
        title={value || undefined}
      >
        {value || <span className="text-neutral-400">{placeholder}</span>}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      </button>

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
            "shadow-[0_8px_24px_rgba(0,0,0,0.15)] overscroll-contain"
          )}
        >
          {searchable && (
            <div className="p-2 border-b border-neutral-200 bg-neutral-50/70 sticky top-0">
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Search…"
                className={cls(CONTROL, "h-9")}
                autoFocus
              />
            </div>
          )}
          <div className="py-1">
            {shown.map((opt) => (
              <button
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
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
        </div>
      )}
    </div>
  );
}

/* ---------------- Spec constants ---------------- */
const DAY_OPTIONS: DayShort[] = ["M", "T", "W", "H", "F", "S"];

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

/** spacious column widths */
const COLS = [
  "14%", // Course Code
  "28%", // Course Title
  "6%",  // Units
  "16%", // From
  "18%", // To
  "14%", // Faculty
  "5%",  // Day 1
  "6%",  // Begin 1
  "6%",  // End 1
  "5%",  // Day 2
  "6%",  // Begin 2
  "6%",  // End 2
  "12%", // Remarks
  "8%",  // Action/Status
];

function ColGroup() {
  return (
    <colgroup>
      {COLS.map((w, i) => (
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
  return (L || F) ? `${L}, ${F}${f.email ? ` (${f.email})` : ""}` : "";
}

export default function CHAIR_FacultyService() {
  const user = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  }, []);

  const userDeptName: string =
    user?.department ||
    user?.department_name ||
    user?.dept_name ||
    "Department of Software Technology";

  const isRequester = /software technology/i.test(userDeptName);

  const [toDepts, setToDepts] = useState<ToDept[]>([]);
  const [timeBegins] = useState<string[]>([...BEGIN_OPTIONS]);

  const [facultyCache, setFacultyCache] = useState<
    Record<string, { faculty_id: string; first_name: string; last_name: string; email?: string }[]>
  >({});

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
  const [edits, setEdits] = useState<Record<string, ReceiverEdit>>({});
  const getEdit = (id: string): ReceiverEdit =>
    edits[id] || { day1: "", begin1: "", end1: "", day2: "", begin2: "", end2: "", remarks: "" };
  const patchEdit = (id: string, patch: Partial<ReceiverEdit>) =>
    setEdits((p) => ({ ...p, [id]: { ...getEdit(id), ...patch } }));

  const [rows, setRows] = useState<FacultyServiceRow[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  useEffect(() => {
    (async () => {
      const o = await getFSOptions({ requesterDepartment: userDeptName });
      if (o?.ok) setToDepts((o.departments || []).filter((d) => d !== userDeptName) as ToDept[]);
    })().catch(() => {});
  }, [userDeptName]);

  async function ensureFacultyForDept(dept: string) {
    if (!dept || facultyCache[dept]) return;
    try {
      const o = await getFSOptions({ toDepartment: dept as ToDept });
      const list =
        (o.facultyOptions || []).map((f: any) => ({
          faculty_id: f.faculty_id,
          first_name: f.first_name,
          last_name: f.last_name,
          email: f.email,
        })) ?? [];
      setFacultyCache((prev) => ({ ...prev, [dept]: list }));
    } catch {}
  }

  async function refresh() {
    setLoadingList(true);
    try {
      const r = await listFacultyService({ dept: userDeptName });
      if (r?.ok) setRows(r.rows || []);
    } finally {
      setLoadingList(false);
    }
  }
  useEffect(() => {
    refresh().catch(() => {});
  }, [userDeptName]);

  const sentRows = rows.filter((r) => r.from_department === userDeptName);
  const receivedRows = rows.filter((r) => r.to_department === userDeptName);

  const [courseTerm, setCourseTerm] = useState("");
  const [courseSuggestions, setCourseSuggestions] = useState<Array<{ code: string; title: string; units?: number }>>([]);
  useEffect(() => {
    let active = true;
    (async () => {
      const res = await getFSOptions({ q: courseTerm, requesterDepartment: userDeptName });
      if (active && res?.ok) setCourseSuggestions(res.courses || []);
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [courseTerm, userDeptName]);

  const codeOptions = useMemo(
    () => Array.from(new Set((courseSuggestions || []).map((c) => c.code))).sort(),
    [courseSuggestions]
  );

  const canSend = Boolean(draft.course_code && draft.course_title && draft.units != null && draft.to_department);

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
        from_department: userDeptName,
      });
      if (!crt?.ok || !crt.row?.fs_id) {
        toast("Failed to create request.");
        return;
      }
      const snd = await sendFacultyService(crt.row.fs_id);
      if (snd?.ok) {
        toast("Request sent.");
        setDraft({ course_code: "", course_title: "", units: null, to_department: "" });
        setCourseTerm("");
        await refresh();
      } else {
        toast("Failed to send.");
      }
    } catch (e: any) {
      toast(e?.message || "Error sending request.");
    }
  }

  async function handleSendBack(fs_id: string, dept: string) {
    const e = getEdit(fs_id);
    try {
      if (!e.faculty?.faculty_id && !e.faculty?.email) {
        toast("Select a faculty.");
        return;
      }
      const r = await respondFacultyService(fs_id, {
        faculty: e.faculty || {},
        day1: e.day1,
        begin1: e.begin1,
        end1: e.end1,
        day2: e.day2,
        begin2: e.begin2,
        end2: e.end2,
        remarks: e.remarks,
      });
      if (r?.ok) {
        toast("Sent back to requesting department.");
        setEdits((p) => ({
          ...p,
          [fs_id]: { day1: "", begin1: "", end1: "", day2: "", begin2: "", end2: "", remarks: "" },
        }));
        await refresh();
        ensureFacultyForDept(dept);
      } else {
        toast("Failed to send back.");
      }
    } catch (err: any) {
      toast(err?.message || "Error saving response.");
    }
  }

  async function handleReject(fs_id: string) {
    try {
      const r = await rejectFacultyService(fs_id, { remarks: getEdit(fs_id).remarks || "" });
      if (r?.ok) {
        toast("Request rejected.");
        await refresh();
      } else toast("Failed to reject.");
    } catch (err: any) {
      toast(err?.message || "Error rejecting request.");
    }
  }

  /* ---------------- UI ---------------- */
  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900 px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Service</h1>
        <p className="text-sm text-neutral-600">
          Requesting departments send out course requests; receiving departments send back available faculty & schedule.
        </p>
      </header>

      {/* REQUESTER view: creation + sent table */}
      {isRequester && (
        <>
          {/* Creation (Requester) */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-x-auto overflow-y-visible mb-8">
            <table className="w-full table-fixed text-[13px] min-w-[1200px]">
              <ColGroup />
              <thead className="bg-gray-50 border-y text-gray-700 text-left text-xs">
                <tr className="[&>th]:py-3 [&>th]:px-4 uppercase tracking-wide">
                  <th>Course Code</th>
                  <th>Course Title</th>
                  <th className="text-center">Units</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Faculty</th>
                  <th className="text-center">Day 1</th>
                  <th className="text-center">Begin 1</th>
                  <th className="text-center">End 1</th>
                  <th className="text-center">Day 2</th>
                  <th className="text-center">Begin 2</th>
                  <th className="text-center">End 2</th>
                  <th>Remarks</th>
                  <th className="text-center">Action</th>
                </tr>
              </thead>

              <tbody className="whitespace-nowrap text-neutral-800">
                <tr className="align-middle hover:bg-emerald-50/30">
                  {/* Course Code (dropdown) */}
                  <td className="px-4 py-3">
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
                        setCourseTerm(code);
                      }}
                      options={codeOptions}
                      placeholder="Select code…"
                      searchable
                    />
                  </td>

                  {/* Course Title (readonly, auto-filled) */}
                  <td className="px-4 py-3">
                    <input value={draft.course_title} readOnly placeholder="—" className={cls(CONTROL, "bg-neutral-50")} />
                  </td>

                  {/* Units */}
                  <td className="px-4 py-3 text-center tabular-nums">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={draft.units ?? ""}
                      onChange={(e) => {
                        const v = e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0);
                        setDraft((d) => ({ ...d, units: v }));
                      }}
                      className={cls(CONTROL, "text-center")}
                    />
                  </td>

                  {/* From (readonly chip) */}
                  <td className="px-4 py-3">
                    <span
                      className="inline-block rounded-md border border-gray-300 bg-white px-3 py-1.5 text-[13px] leading-tight shadow-sm max-w-full truncate"
                      title={userDeptName}
                    >
                      {userDeptName}
                    </span>
                  </td>

                  {/* To */}
                  <td className="px-4 py-3">
                    <Dropdown
                      value={draft.to_department}
                      onChange={(v) => setDraft((d) => ({ ...d, to_department: v as ToDept }))}
                      options={toDepts}
                      placeholder="Select department…"
                    />
                  </td>

                  {/* Placeholders (Requester cannot edit) */}
                  <td className="px-4 py-3 text-neutral-400">—</td>
                  <td className="px-4 py-3 text-center text-neutral-400">—</td>
                  <td className="px-4 py-3 text-center text-neutral-400">—</td>
                  <td className="px-4 py-3 text-center text-neutral-400">—</td>
                  <td className="px-4 py-3 text-center text-neutral-400">—</td>
                  <td className="px-4 py-3 text-center text-neutral-400">—</td>
                  <td className="px-4 py-3 text-left text-neutral-400">—</td>

                  <td className="px-4 py-3 text-center">
                    <button
                      className={cls(
                        "inline-flex items-center justify-center gap-1.5 rounded-md px-3 font-medium shadow-sm h-10",
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

          {/* Sent Requests (Requester) */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-x-auto overflow-y-visible">
            <div className="px-5 pt-4 text-[13px] text-neutral-600">Sent Requests</div>
            <table className="w-full table-fixed text-[13px] min-w-[1200px]">
              <ColGroup />
              <thead className="bg-gray-50 border-y text-gray-700 text-left text-xs">
                <tr className="[&>th]:py-3 [&>th]:px-4 uppercase tracking-wide">
                  <th>Course Code &amp; Title</th>
                  <th className="text-center">Units</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Faculty</th>
                  <th className="text-center">Day1</th>
                  <th className="text-center">Begin1</th>
                  <th className="text-center">End1</th>
                  <th className="text-center">Day2</th>
                  <th className="text-center">Begin2</th>
                  <th className="text-center">End2</th>
                  <th>Remarks</th>
                  <th className="text-center">Status</th>
                </tr>
              </thead>
              <tbody className="whitespace-nowrap text-neutral-800">
                {sentRows.map((r) => (
                  <tr key={r.fs_id} className="align-middle border-b last:border-0 odd:bg-white even:bg-neutral-50/60">
                    <td className="px-4 py-3">
                      <span className="block truncate" title={`${r.course_code} — ${r.course_title}`}>
                        <span className="font-semibold text-emerald-700">{r.course_code}</span> — {r.course_title}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center tabular-nums">{r.units ?? ""}</td>
                    <td className="px-4 py-3 truncate" title={r.from_department}>{r.from_department}</td>
                    <td className="px-4 py-3 truncate" title={r.to_department}>{r.to_department}</td>
                    <td className="px-4 py-3 truncate" title={facultyLabel(r.faculty as any)}>{facultyLabel(r.faculty as any) || "—"}</td>
                    <td className="px-4 py-3 text-center">{r.day1 || "—"}</td>
                    <td className="px-4 py-3 text-center">{r.begin1 || "—"}</td>
                    <td className="px-4 py-3 text-center">{r.end1 || "—"}</td>
                    <td className="px-4 py-3 text-center">{r.day2 || "—"}</td>
                    <td className="px-4 py-3 text-center">{r.begin2 || "—"}</td>
                    <td className="px-4 py-3 text-center">{r.end2 || "—"}</td>
                    <td className="px-4 py-3 truncate" title={r.remarks || ""}>{r.remarks || "—"}</td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={cls(
                          "inline-block rounded-full px-2 py-[2px] text-[12px]",
                          r.status === "responded" ? "bg-emerald-100 text-emerald-700"
                            : r.status === "rejected" ? "bg-red-100 text-red-700"
                            : "bg-amber-100 text-amber-700"
                        )}
                      >
                        {r.status === "responded" ? "Responded" : r.status === "rejected" ? "Rejected" : "Sent"}
                      </span>
                    </td>
                  </tr>
                ))}
                {sentRows.length === 0 && !loadingList && (
                  <tr><td className="px-4 py-10 text-neutral-500 text-center" colSpan={13}>No sent requests yet.</td></tr>
                )}
                {loadingList && (
                  <tr><td className="px-4 py-10 text-neutral-500 text-center" colSpan={13}>Loading…</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* RECEIVER view */}
      {!isRequester && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-x-auto overflow-y-visible">
          <div className="px-5 pt-4 text-[13px] text-neutral-600">Received Requests</div>
          <table className="w-full table-fixed text-[13px] min-w-[1200px]">
            <ColGroup />
            <thead className="bg-gray-50 border-y text-gray-700 text-left text-xs">
              <tr className="[&>th]:py-3 [&>th]:px-4 uppercase tracking-wide">
                <th>Course Code</th>
                <th>Course Title</th>
                <th className="text-center">Units</th>
                <th>From</th>
                <th>To</th>
                <th>Faculty</th>
                <th className="text-center">Day1</th>
                <th className="text-center">Begin1</th>
                <th className="text-center">End1</th>
                <th className="text-center">Day2</th>
                <th className="text-center">Begin2</th>
                <th className="text-center">End2</th>
                <th>Remarks</th>
                <th className="text-center">Action</th>
              </tr>
            </thead>

            <tbody className="whitespace-nowrap text-neutral-800">
              {receivedRows.map((r) => {
                const fsid = r.fs_id!;
                const dept = r.to_department || "";
                const e = getEdit(fsid);
                const facultyOptions = facultyCache[dept] || [];
                const isClosed = r.status === "responded" || r.status === "rejected";

                return (
                  <tr
                    key={fsid}
                    className="align-middle border-b last:border-0 odd:bg-white even:bg-neutral-50/60 hover:bg-emerald-50/30 transition-colors"
                    onMouseEnter={() => ensureFacultyForDept(dept)}
                  >
                    <td className="px-4 py-3">
                      <span className="font-semibold text-emerald-700">{r.course_code}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="block truncate" title={r.course_title}>{r.course_title}</span>
                    </td>

                    <td className="px-4 py-3 text-center tabular-nums">{r.units ?? ""}</td>
                    <td className="px-4 py-3 truncate" title={r.from_department}>{r.from_department}</td>
                    <td className="px-4 py-3 truncate" title={r.to_department}>{r.to_department}</td>

                    {/* Faculty */}
                    <td className="px-4 py-3">
                      {!isClosed ? (
                        <Dropdown
                          value={facultyLabel(e.faculty)}
                          onChange={(label) => {
                            const match = facultyOptions.find((f) => facultyLabel(f) === label);
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
                          options={facultyOptions.map((f) => facultyLabel(f)).filter(Boolean)}
                          placeholder={facultyOptions.length ? "Select faculty…" : "Loading…"}
                          searchable
                        />
                      ) : (
                        <span className="block truncate" title={facultyLabel(r.faculty as any)}>
                          {facultyLabel(r.faculty as any) || "—"}
                        </span>
                      )}
                    </td>

                    {/* Day/Begin/End */}
                    <td className="px-4 py-3 text-center">
                      {!isClosed ? (
                        <Dropdown value={e.day1} onChange={(v) => patchEdit(fsid, { day1: v as DayShort })} options={DAY_OPTIONS} placeholder="—" />
                      ) : (r.day1 || "—")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {!isClosed ? (
                        <Dropdown
                          value={e.begin1}
                          onChange={(v) => patchEdit(fsid, { begin1: v, end1: END_BY_BEGIN[v as keyof typeof END_BY_BEGIN] })}
                          options={timeBegins}
                          placeholder="—"
                          align="right"
                        />
                      ) : (r.begin1 || "—")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {!isClosed ? (
                        <input value={e.end1 ? String(e.end1) : ""} readOnly className={cls(CONTROL, "text-center bg-neutral-50")} placeholder="—" />
                      ) : (r.end1 || "—")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {!isClosed ? (
                        <Dropdown value={e.day2} onChange={(v) => patchEdit(fsid, { day2: v as DayShort })} options={DAY_OPTIONS} placeholder="—" />
                      ) : (r.day2 || "—")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {!isClosed ? (
                        <Dropdown
                          value={e.begin2}
                          onChange={(v) => patchEdit(fsid, { begin2: v, end2: END_BY_BEGIN[v as keyof typeof END_BY_BEGIN] })}
                          options={timeBegins}
                          placeholder="—"
                          align="right"
                        />
                      ) : (r.begin2 || "—")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {!isClosed ? (
                        <input value={e.end2 ? String(e.end2) : ""} readOnly className={cls(CONTROL, "text-center bg-neutral-50")} placeholder="—" />
                      ) : (r.end2 || "—")}
                    </td>

                    {/* Remarks */}
                    <td className="px-4 py-3">
                      {!isClosed ? (
                        <input
                          value={e.remarks}
                          onChange={(ev) => patchEdit(fsid, { remarks: ev.target.value })}
                          placeholder="Enter remarks…"
                          className={CONTROL}
                        />
                      ) : (
                        <span className="block truncate" title={r.remarks || ""}>{r.remarks || "—"}</span>
                      )}
                    </td>

                    {/* Action */}
                    <td className="px-4 py-3 text-center">
                      {!isClosed ? (
                        <div className="flex items-center justify-center gap-3">
                          <button
                            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-[#008e4e] px-3 text-[13px] font-medium text-white shadow-sm hover:brightness-110"
                            onClick={() => handleSendBack(fsid, dept)}
                            title="Send Back"
                          >
                            <CornerUpLeft className="h-4 w-4" />
                            Send Back
                          </button>
                          <button
                            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-red-600 px-3 text-[13px] font-medium text-white shadow-sm hover:brightness-110"
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
                            r.status === "responded" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
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
                <tr><td className="px-4 py-10 text-neutral-500 text-center" colSpan={13}>No received requests for your department.</td></tr>
              )}
              {loadingList && (
                <tr><td className="px-4 py-10 text-neutral-500 text-center" colSpan={13}>Loading…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-5 text-[11px] text-neutral-500">
        Directory (per spec): Computer Technology → Katrina Ysabel Solomon (katrina.solomon@dlsu.edu.ph);
        Information Technology → Danny Cheng (danny.cheng@dlsu.edu.ph);
        Literature → Shirley Lua (shirley.lua@dlsu.edu.ph).
      </div>
    </div>
  );
}
