import React, { useEffect, useMemo, useState } from "react";
import { Edit, Trash2, Check, Search, X, Send, Plus, ChevronDown } from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import {
  getApoCourseOfferings,
  addApoOfferingRow,
  editApoOfferingRow,
  deleteApoOfferingRow,
  forwardApoCourseOfferings,
} from "../../api";

/* ---------- utils ---------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const fmtTime = (s?: string) => {
  const t = (s || "").replace(/\D/g, "");
  if (t.length !== 4) return s || "—";
  return `${t.slice(0, 2)}:${t.slice(2)}`;
};
const normCode = (s?: string) =>
  (s || "").trim().toUpperCase().replace(/\s+/g, " ").replace(/^ID\s*(\d+)$/, "ID $1");

type Day = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";

/* ---------- types from API ---------- */
type OfferingRow = {
  program_no: string;
  batch: { batch_id: string; batch_code: string; batch_number?: number | null };
  program: { program_id?: string; program_code?: string };
  course: {
    course_id: string; course_code: string; course_title: string;
    program_level?: string; department_id?: string; department_name?: string
  };
  section: { section_id: string; section_code: string; enrollment_cap: number | null; remarks: string };
  faculty: { faculty_id?: string | null; user_id?: string | null; faculty_name: string };
  slot1?: { schedule_id?: string; day: Day | ""; start_time: string; end_time: string; room_id?: string; room_number?: string };
  slot2?: { schedule_id?: string; day: Day | ""; start_time: string; end_time: string; room_id?: string; room_number?: string };
  sizing: { preenlistment_total: number; suggested_sections?: number | null };
  links: { curriculum_id?: string; term_id: string; course_id: string; batch_id?: string; program_id?: string; section_id?: string };
};

type CourseOption = { course_id: string; course_code: string; course_title: string };

type OfferingsResponse = {
  campus: { campus_id: string; campus_name: string };
  term_id: string; term_label: string;
  filters: {
    levels: string[];
    departments: { department_id: string; department_name: string }[];
    ids: { batch_id: string; batch_code: string }[];
    programs: { program_id: string; program_code: string }[];
  };
  rows: OfferingRow[];
  course_options_by_group: Record<string, CourseOption[]>;
};

/* ---------- page ---------- */
export default function CourseOfferingsPage() {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<string>("All Levels");
  const [departmentName, setDepartmentName] = useState<string>("All Departments");
  const [programCode, setProgramCode] = useState<string>("All Programs");
  const [batchCode, setBatchCode] = useState<string>("All ID");

  const [data, setData] = useState<OfferingsResponse | null>(null);
  const [rows, setRows] = useState<OfferingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);
  const fullName = user?.fullName ?? "APO";
  const roleName = useMemo(() => {
    if (!user?.roles) return "Academic Programming Officer";
    return (user.roles as string[]).some((r) => /^apo\b/i.test(r))
      ? "Academic Programming Officer"
      : user.roles[0] || "User";
  }, [user]);

  const campusLabel = data?.campus?.campus_name || "";

  const resolveFilterIds = () => {
    const deptId =
      departmentName === "All Departments"
        ? undefined
        : data?.filters.departments.find((d) => d.department_name === departmentName)?.department_id;
    const progId =
      programCode === "All Programs"
        ? undefined
        : data?.filters.programs.find((p) => p.program_code === programCode)?.program_id;
    const bId =
      batchCode === "All ID"
        ? undefined
        : data?.filters.ids.find((b) => normCode(b.batch_code) === normCode(batchCode))?.batch_id;
    return { deptId, progId, bId };
  };

  const load = async () => {
    if (!user?.userId) return;
    setLoading(true);
    setErr(null);
    try {
      const { deptId, progId, bId } = resolveFilterIds();
      const resp = await getApoCourseOfferings(user.userId, {
        level: level === "All Levels" ? undefined : level,
        department_id: deptId,
        program_id: progId,
        batch_id: bId,
      });
      setData(resp);
      setRows(resp.rows);
    } catch (e: any) {
      setErr(e?.message || "Failed to load course offerings.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line */ }, []);
  useEffect(() => { (async () => { await load(); })(); /* eslint-disable-line */ }, [level, departmentName, programCode, batchCode]);

  /* -------- options: unique normalized ID list -------- */
  const idOptions = useMemo(() => {
    const seen = new Set<string>();
    const arr: string[] = ["All ID"];
    (data?.filters.ids || []).forEach((b) => {
      const label = normCode(b.batch_code);
      if (!seen.has(label)) {
        seen.add(label);
        arr.push(label);
      }
    });
    return arr;
  }, [data?.filters.ids]);

  /* -------- search filter -------- */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    const hit = (s?: string | number | null) =>
      (s === 0 ? "0" : (s || "")).toString().toLowerCase().includes(q);
    return rows.filter((r) => {
      const { course: c, section: sec, faculty: f, slot1: s1, slot2: s2 } = r;
      return (
        hit(r.program_no) ||
        hit(c.course_code) ||
        hit(c.course_title) ||
        hit(c.program_level) ||
        hit(c.department_name) ||
        hit(sec.section_code) ||
        hit(sec.enrollment_cap ?? "") ||
        hit(sec.remarks) ||
        hit(f.faculty_name) ||
        (s1 &&
          (hit(s1.day) || hit(fmtTime(s1.start_time)) || hit(fmtTime(s1.end_time)) || hit(s1.room_id) || hit(s1.room_number))) ||
        (s2 &&
          (hit(s2.day) || hit(fmtTime(s2.start_time)) || hit(fmtTime(s2.end_time)) || hit(s2.room_id) || hit(s2.room_number))) ||
        hit(r.batch.batch_code) ||
        hit(r.program.program_code)
      );
    });
  }, [rows, search]);

  const groups = useMemo(() => {
    const out: Record<string, Record<string, OfferingRow[]>> = {};
    for (const r of filtered) {
      const idKey = normCode(r.batch.batch_code) || "—";
      const progKey = r.program.program_code || "—";
      (out[idKey] ||= {});
      (out[idKey][progKey] ||= []).push(r);
    }
    return out;
  }, [filtered]);

  /* ---------- inline edit ---------- */
  const [editing, setEditing] = useState<{ row: OfferingRow; draft: any } | null>(null);
  const startEdit = (row: OfferingRow) => {
    if (!row.section.section_id) return;
    setEditing({
      row,
      draft: {
        section_id: row.section.section_id,
        section_code: row.section.section_code,
        enrollment_cap: row.section.enrollment_cap ?? "",
        remarks: row.section.remarks ?? "",
        slot1: { room_id: row.slot1?.room_id ?? "" },
        slot2: { room_id: row.slot2?.room_id ?? "" },
      },
    });
  };
  const saveEdit = async () => {
    if (!editing || !user?.userId) return;
    await editApoOfferingRow(user.userId, editing.draft);
    await load();
    setEditing(null);
  };

  /* ---------- add row (anchor under clicked row) ---------- */
  const rowKeyOf = (r: OfferingRow) =>
    r.section.section_id ? `sec:${r.section.section_id}` : `combo:${r.batch.batch_id}|${r.program.program_id}|${r.course.course_id}`;

  const [addAnchorKey, setAddAnchorKey] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<any>({
    batch_id: "", course_id: "", enrollment_cap: 20, remarks: "",
    slot1: { room_id: "" }, slot2: { room_id: "" }
  });
  const [addCourseCode, setAddCourseCode] = useState<string>("— Select a course —");
  const [adding, setAdding] = useState(false);

  const doAdd = async () => {
    if (!user?.userId || !addDraft.course_id) return;
    setAdding(true);
    try {
      await addApoOfferingRow(user.userId, addDraft);
      await load();
      setAddAnchorKey(null);
      setAddCourseCode("— Select a course —");
      setAddDraft({ batch_id: "", course_id: "", enrollment_cap: 20, remarks: "", slot1: { room_id: "" }, slot2: { room_id: "" } });
    } finally {
      setAdding(false);
    }
  };

  const doDelete = async (row: OfferingRow) => {
    if (!user?.userId || !row.section.section_id) return;
    if (!confirm("Delete this section? This cannot be undone.")) return;
    await deleteApoOfferingRow(user.userId, { section_id: row.section.section_id });
    await load();
  };

  /* ---------- collapsible ---------- */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed((p) => ({ ...p, [key]: !p[key] }));

  /* ---------- forward modal ---------- */
  const [showForward, setShowForward] = useState(false);
  const [forwardTo, setForwardTo] = useState("");
  const [forwardSubject, setForwardSubject] = useState("Forwarding Course Offerings for Approval");
  const [forwardMsg, setForwardMsg] = useState("");
  const openForward = () => setShowForward(true);
  const sendForward = async () => {
    if (!user?.userId) return;
    const container = document.querySelector("[data-course-offerings]") as HTMLElement | null;
    if (!container) return;
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("button, svg, select, input, textarea").forEach((el) => el.remove());
    clone.querySelectorAll("th:last-child, td:last-child").forEach((el) => el.remove());
    await forwardApoCourseOfferings(user.userId, {
      to: forwardTo, subject: forwardSubject, message: forwardMsg, attachment_html: clone.innerHTML,
    });
    setShowForward(false);
    alert("Sent to outbox.");
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role={campusLabel ? `${roleName} | ${campusLabel}` : roleName} />
      <Tabs mode="nav" items={[
        { label: "Pre-Enlistment", to: "/apo/preenlistment" },
        { label: "Course Offerings", to: "/apo/courseofferings" },
        { label: "Room Allocation", to: "/apo/roomallocation" },
      ]} />

      <main className="p-6 w-full">
        {/* filters */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by Program No., code, title, faculty, room…"
              className="w-full rounded-lg border px-9 py-2 text-sm"
            />
          </div>
          <SelectBox value={level} onChange={(v: string) => setLevel(v)} options={["All Levels", ...(data?.filters.levels || [])]} />
          <SelectBox value={departmentName} onChange={(v: string) => setDepartmentName(v)}
                     options={["All Departments", ...(data?.filters.departments || []).map((d) => d.department_name)]} />
          <SelectBox value={batchCode} onChange={(v: string) => setBatchCode(v)} options={idOptions} />
          <SelectBox value={programCode} onChange={(v: string) => setProgramCode(v)}
                     options={["All Programs", ...(data?.filters.programs || []).map((p) => p.program_code)]} />
          <button onClick={openForward}
                  className="ml-auto inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm">
            <Send className="h-4 w-4" /> Forward
          </button>
        </div>

        {/* table */}
        <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-4 sm:p-6 w-full" data-course-offerings>
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <div>
              <h2 className="text-lg font-bold">Course Offerings</h2>
              <p className="text-sm text-gray-500">{loading ? "Loading…" : data?.term_label || ""}</p>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
          </div>

          <div className="space-y-6">
            {Object.entries(groups).map(([idLabel, byProgram]) => (
              <div key={idLabel} className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-hidden">
                <div className="bg-[#21804A] text-white px-4 py-3 text-center font-semibold">{idLabel}</div>

                {Object.entries(byProgram).map(([progLabel, list]) => {
                  const key = `${idLabel}::${progLabel}`;
                  const isClosed = !!collapsed[key];
                  return (
                    <div key={key} className="border-t border-gray-200">
                      <button onClick={() => toggle(key)}
                              className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left">
                        <span className="font-semibold text-emerald-800">{progLabel}</span>
                        <ChevronDown className={cls("h-4 w-4 transition-transform", isClosed && "rotate-180")} />
                      </button>

                      {!isClosed && (
                        <div className="p-0">
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm table-fixed border-separate" style={{ borderSpacing: 0 }}>
                              <colgroup>
                                <col className="w-24" />
                                <col className="min-w-[220px] w-[280px]" />
                                <col className="w-24" />
                                <col className="min-w-[160px] w-[180px]" />
                                <col className="w-24" />
                                <col className="w-24" />
                                <col className="w-24" />
                                <col className="w-28" />
                                <col className="w-24" />
                                <col className="w-24" />
                                <col className="w-24" />
                                <col className="w-28" />
                                <col className="w-24" />
                                <col className="min-w-[160px] w-[200px]" />
                                <col className="w-28" />
                              </colgroup>
                              <thead className="bg-gray-50 text-emerald-800 sticky top-0 z-10">
                                <tr className="text-[13px] font-semibold">
                                  {[
                                    "Program No.","Course Code & Title","Section","Faculty",
                                    "Day 1","Begin 1","End 1","Room 1",
                                    "Day 2","Begin 2","End 2","Room 2",
                                    "Capacity","Remarks","Actions",
                                  ].map((h, i) => (
                                    <th key={i} className="px-3 py-2 text-left border border-gray-300">{h}</th>
                                  ))}
                                </tr>
                              </thead>

                              <tbody>
                                {list.map((r) => {
                                  const isEditing = editing?.row.section.section_id === r.section.section_id;
                                  const canEditDelete = !!r.section.section_id;

                                  const rowKey = rowKeyOf(r);

                                  const view = (
                                    <tr key={(r.section.section_id || r.course.course_id) + "-v"} className="hover:bg-neutral-50">
                                      <td className="px-3 py-2 border border-gray-300">{r.program_no}</td>
                                      <td className="px-3 py-2 border border-gray-300 align-top">
                                        <div className="font-semibold text-emerald-700 break-words">{r.course.course_code}</div>
                                        <div className="text-xs text-gray-500 leading-snug break-words whitespace-normal">
                                          {r.course.course_title}
                                        </div>
                                      </td>
                                      <td className="px-3 py-2 border border-gray-300">{r.section.section_code || "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">
                                        <span className={r.faculty.faculty_name === "UNASSIGNED" ? "text-red-600 font-medium" : ""}>
                                          {r.faculty.faculty_name}
                                        </span>
                                      </td>
                                      <td className="px-3 py-2 border border-gray-300">{r.slot1?.day || "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.start_time)}</td>
                                      <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.end_time)}</td>
                                      <td className="px-3 py-2 border border-gray-300">{r.slot1?.room_number || r.slot1?.room_id || "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">{r.slot2?.day || "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.start_time)}</td>
                                      <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.end_time)}</td>
                                      <td className="px-3 py-2 border border-gray-300">{r.slot2?.room_number || r.slot2?.room_id || "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">{r.section.enrollment_cap ?? "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">{r.section.remarks || "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">
                                        <div className="flex gap-3">
                                          {canEditDelete && (
                                            <>
                                              <button className="text-emerald-700 hover:text-emerald-900" title="Edit" onClick={() => startEdit(r)}>
                                                <Edit className="h-4 w-4" />
                                              </button>
                                              <button className="text-red-500 hover:text-red-700" title="Delete" onClick={() => doDelete(r)}>
                                                <Trash2 className="h-4 w-4" />
                                              </button>
                                            </>
                                          )}
                                          <button
                                            className="text-emerald-700 hover:text-emerald-900"
                                            title="Add row (create section)"
                                            onClick={() => {
                                              setAddAnchorKey(rowKey);
                                              setAddCourseCode("— Select a course —");
                                              setAddDraft({
                                                batch_id: r.batch.batch_id,
                                                course_id: "",
                                                enrollment_cap: r.section.enrollment_cap ?? 20,
                                                remarks: "",
                                                slot1: { room_id: "" },
                                                slot2: { room_id: "" },
                                              });
                                            }}
                                          >
                                            <Plus className="h-4 w-4" />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  );

                                  const edit = (
                                    <tr key={r.section.section_id + "-e"} className="bg-emerald-50/40">
                                      <td className="px-3 py-2 border border-gray-300">{r.program_no}</td>
                                      <td className="px-3 py-2 border border-gray-300 align-top">
                                        <div className="font-semibold text-emerald-700 break-words">{r.course.course_code}</div>
                                        <div className="text-xs text-gray-500 leading-snug break-words whitespace-normal">{r.course.course_title}</div>
                                      </td>
                                      <td className="px-3 py-2 border border-gray-300">
                                        <input
                                          value={editing?.draft.section_code || ""}
                                          onChange={(e) =>
                                            setEditing((p) => p && { ...p, draft: { ...p.draft, section_code: e.target.value } })
                                          }
                                          className="w-full rounded-md border px-2 py-1 text-sm"
                                        />
                                      </td>
                                      <td className="px-3 py-2 border border-gray-300">{r.faculty.faculty_name || "UNASSIGNED"}</td>
                                      <td className="px-3 py-2 border border-gray-300">{r.slot1?.day || "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.start_time)}</td>
                                      <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.end_time)}</td>
                                      <td className="px-3 py-2 border border-gray-300">
                                        <input
                                          value={editing?.draft.slot1?.room_id || ""}
                                          onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot1: { room_id: e.target.value } } })}
                                          className="w-full rounded-md border px-2 py-1 text-sm"
                                        />
                                      </td>
                                      <td className="px-3 py-2 border border-gray-300">{r.slot2?.day || "—"}</td>
                                      <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.start_time)}</td>
                                      <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.end_time)}</td>
                                      <td className="px-3 py-2 border border-gray-300">
                                        <input
                                          value={editing?.draft.slot2?.room_id || ""}
                                          onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot2: { room_id: e.target.value } } })}
                                          className="w-full rounded-md border px-2 py-1 text-sm"
                                        />
                                      </td>
                                      <td className="px-3 py-2 border border-gray-300">
                                        <input
                                          value={editing?.draft.enrollment_cap ?? ""}
                                          onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, enrollment_cap: Number(e.target.value || 0) } })}
                                          className="w-full rounded-md border px-2 py-1 text-sm"
                                        />
                                      </td>
                                      <td className="px-3 py-2 border border-gray-300">
                                        <input
                                          value={editing?.draft.remarks || ""}
                                          onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, remarks: e.target.value } })}
                                          className="w-full rounded-md border px-2 py-1 text-sm"
                                        />
                                      </td>
                                      <td className="px-3 py-2 border border-gray-300">
                                        <div className="flex items-center gap-2">
                                          <button onClick={saveEdit}
                                                  className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50" title="Save">
                                            <Check className="h-4 w-4" strokeWidth={2.5} />
                                          </button>
                                          <button onClick={() => setEditing(null)}
                                                  className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50" title="Cancel">
                                            <X className="h-4 w-4" strokeWidth={2.5} />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  );

                                  const addInline =
                                    addAnchorKey === rowKey && (
                                      <tr key={(r.section.section_id || r.course.course_id) + "-a"} className="bg-emerald-50/60">
                                        <td className="px-3 py-2 border border-gray-300">{r.program_no}</td>
                                        <td className="px-3 py-2 border border-gray-300 align-top">
                                          {(() => {
                                            const groupKey = `${r.batch.batch_id}|${r.program.program_id}`;
                                            const groupOptions: CourseOption[] = data?.course_options_by_group?.[groupKey] || [];
                                            const codes = ["— Select a course —", ...groupOptions.map((o) => o.course_code)];
                                            const codeToId: Record<string, string> = {};
                                            const codeToTitle: Record<string, string> = {};
                                            groupOptions.forEach((o) => {
                                              codeToId[o.course_code] = o.course_id;
                                              codeToTitle[o.course_code] = o.course_title;
                                            });
                                            return (
                                              <>
                                                <div className="mb-2">
                                                  <SelectBox
                                                    value={addCourseCode}
                                                    onChange={(v: string) => {
                                                      setAddCourseCode(v);
                                                      setAddDraft((p: any) => ({
                                                        ...p,
                                                        batch_id: r.batch.batch_id,
                                                        course_id: codeToId[v] || "",
                                                      }));
                                                    }}
                                                    options={codes}
                                                  />
                                                </div>
                                                <div className="text-xs text-neutral-600">
                                                  {codeToTitle[addCourseCode] || "—"}
                                                </div>
                                              </>
                                            );
                                          })()}
                                        </td>
                                        <td className="px-3 py-2 border border-gray-300">Auto</td>
                                        <td className="px-3 py-2 border border-gray-300">UNASSIGNED</td>
                                        <td className="px-3 py-2 border border-gray-300">—</td>
                                        <td className="px-3 py-2 border border-gray-300">—</td>
                                        <td className="px-3 py-2 border border-gray-300">—</td>
                                        <td className="px-3 py-2 border border-gray-300">
                                          <input
                                            value={addDraft.slot1.room_id || ""}
                                            onChange={(e) => setAddDraft((p: any) => ({ ...p, slot1: { room_id: e.target.value } }))}
                                            className="w-full rounded-md border px-2 py-1 text-sm"
                                          />
                                        </td>
                                        <td className="px-3 py-2 border border-gray-300">—</td>
                                        <td className="px-3 py-2 border border-gray-300">—</td>
                                        <td className="px-3 py-2 border border-gray-300">—</td>
                                        <td className="px-3 py-2 border border-gray-300">
                                          <input
                                            value={addDraft.slot2.room_id || ""}
                                            onChange={(e) => setAddDraft((p: any) => ({ ...p, slot2: { room_id: e.target.value } }))}
                                            className="w-full rounded-md border px-2 py-1 text-sm"
                                          />
                                        </td>
                                        <td className="px-3 py-2 border border-gray-300">
                                          <input
                                            value={addDraft.enrollment_cap}
                                            onChange={(e) => setAddDraft((p: any) => ({ ...p, enrollment_cap: Number(e.target.value || 0) }))}
                                            className="w-full rounded-md border px-2 py-1 text-sm"
                                          />
                                        </td>
                                        <td className="px-3 py-2 border border-gray-300">
                                          <input
                                            value={addDraft.remarks}
                                            onChange={(e) => setAddDraft((p: any) => ({ ...p, remarks: e.target.value }))}
                                            className="w-full rounded-md border px-2 py-1 text-sm"
                                          />
                                        </td>
                                        <td className="px-3 py-2 border border-gray-300">
                                          <div className="flex justify-start gap-2">
                                            <button
                                              disabled={adding || !addDraft.course_id}
                                              onClick={doAdd}
                                              className={cls(
                                                "flex h-8 w-8 items-center justify-center rounded-full border-2",
                                                "border-green-600 text-green-600 hover:bg-green-50 disabled:opacity-50"
                                              )}
                                              title="Save"
                                            >
                                              <Check className="h-4 w-4" strokeWidth={2.5} />
                                            </button>
                                            <button
                                              onClick={() => setAddAnchorKey(null)}
                                              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                                              title="Cancel"
                                            >
                                              <X className="h-4 w-4" strokeWidth={2.5} />
                                            </button>
                                          </div>
                                        </td>
                                      </tr>
                                    );

                                  return (
                                    <React.Fragment key={r.section.section_id || r.course.course_id}>
                                      {isEditing ? edit : view}
                                      {addInline}
                                    </React.Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Forward modal */}
        {showForward && (
          <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-emerald-700">Forward Course Offerings</h3>
                <button onClick={() => setShowForward(false)} className="rounded-full p-1 hover:bg-gray-100">
                  <X className="h-5 w-5 text-gray-600" />
                </button>
              </div>
              <div className="border border-gray-200 bg-gray-50 p-3 rounded-lg text-sm flex items-center justify-between mb-4">
                <span>📎 Attached: <strong>Course_Offerings_{data?.term_label || ""}.html</strong></span>
                <span className="text-xs text-neutral-600">Preview is generated from the table</span>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium">To:</label>
                  <input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} type="email"
                         placeholder="Recipient email" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium">Subject:</label>
                  <input value={forwardSubject} onChange={(e) => setForwardSubject(e.target.value)}
                         className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium">Message:</label>
                  <textarea value={forwardMsg} onChange={(e) => setForwardMsg(e.target.value)}
                            className="h-40 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5">
                <button onClick={() => setShowForward(false)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50">Cancel</button>
                <button onClick={sendForward} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110">Send</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
