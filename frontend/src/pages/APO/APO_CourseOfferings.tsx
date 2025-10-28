// frontend/src/pages/APO/CourseOfferingsPage.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Edit, Trash2, Check, Search, Upload, X, Send, Plus } from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import {
  getApoCourseOfferings,
  addApoOfferingRow,
  editApoOfferingRow,
  deleteApoOfferingRow,
  importApoOfferingsCSV,
  forwardApoCourseOfferings,
} from "../../api";

/* ---------------- Utilities ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const fmtTime = (s?: string) => {
  const t = (s || "").replace(/\D/g, "");
  if (t.length !== 4) return s || "—";
  return `${t.slice(0, 2)}:${t.slice(2)}`;
};

type Day = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";

/* ---------------- Types from API ---------------- */
type OfferingRow = {
  batch: { batch_id: string; batch_code: string; batch_number?: number };
  program: { program_id?: string; program_code?: string };
  course: { course_id: string; course_code: string; course_title: string; program_level?: string; department_id?: string; department_name?: string };
  section: { section_id: string; section_code: string; enrollment_cap: number; remarks: string };
  faculty: { faculty_id?: string; user_id?: string; faculty_name: string };
  slot1?: { day: Day; start_time: string; end_time: string; room_id?: string; room_type?: string };
  slot2?: { day: Day; start_time: string; end_time: string; room_id?: string; room_type?: string };
  sizing: { preenlistment_total: number; suggested_sections?: number | null };
};
type OfferingsResponse = {
  campus: { campus_id: string; campus_name: string };
  term_id: string;
  filters: {
    levels: string[];
    departments: { department_id: string; department_name: string }[];
    ids: { batch_id: string; batch_code: string }[];
    programs: { program_id: string; program_code: string }[];
  };
  rows: OfferingRow[];
};

/* ---------------- Page ---------------- */
export default function CourseOfferingsPage() {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<string>("All Levels");

  // store user-visible labels for these; map to IDs when calling the API
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
    return user.roles.includes("apo") ? "Academic Programming Officer" : user.roles[0] || "User";
  }, [user]);

  const campusLabel = data?.campus?.campus_name || "";

  const resolveFilterIds = () => {
    const deptId = departmentName === "All Departments"
      ? undefined
      : data?.filters.departments.find(d => d.department_name === departmentName)?.department_id;

    const progId = programCode === "All Programs"
      ? undefined
      : data?.filters.programs.find(p => p.program_code === programCode)?.program_id;

    const bId = batchCode === "All ID"
      ? undefined
      : data?.filters.ids.find(b => b.batch_code === batchCode)?.batch_id;

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

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // re-query when filters change
  useEffect(() => {
    (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, departmentName, programCode, batchCode]);

  // search & filter locally
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (q) {
      const hit = (s?: string) => (s || "").toLowerCase().includes(q);
      list = rows.filter((r) => {
        const c = r.course;
        const sec = r.section;
        const f = r.faculty;
        const s1 = r.slot1, s2 = r.slot2;
        return (
          hit(c.course_code) || hit(c.course_title) || hit(c.program_level) || hit(c.department_name) ||
          hit(sec.section_code) || hit(`${sec.enrollment_cap}`) || hit(sec.remarks) ||
          hit(f.faculty_name) ||
          (s1 && (hit(s1.day) || hit(fmtTime(s1.start_time)) || hit(fmtTime(s1.end_time)) || hit(s1.room_id) || hit(s1.room_type))) ||
          (s2 && (hit(s2.day) || hit(fmtTime(s2.start_time)) || hit(fmtTime(s2.end_time)) || hit(s2.room_id) || hit(s2.room_type))) ||
          hit(r.batch.batch_code)
        );
      });
    }
    return list;
  }, [rows, search]);

  // group by ID (batch_code)
  const grouped = useMemo(() => {
    const byId: Record<string, OfferingRow[]> = {};
    for (const r of filtered) {
      const key = r.batch.batch_code || "—";
      byId[key] = byId[key] || [];
      byId[key].push(r);
    }
    return byId;
  }, [filtered]);

  // helpers to compute Program No. per course (roughly based on preenlistment sizing + order)
  function computeProgramNos(list: OfferingRow[]) {
    const byCourse: Record<string, OfferingRow[]> = {};
    list.forEach((r) => {
      byCourse[r.course.course_id] = byCourse[r.course.course_id] || [];
      byCourse[r.course.course_id].push(r);
    });
    const labelFor = (row: OfferingRow, index: number) => {
      const pc = row.program?.program_code || "";
      const base = pc ? (pc.split("-").slice(-1)[0] || pc) : (row.course.course_code.split("-").slice(-1)[0] || "SEC");
      return `${base}-${index + 1}`;
    };
    const map: Record<string, string> = {};
    Object.keys(byCourse).forEach((cid) => {
      const arr = [...byCourse[cid]].sort((a, b) => {
        const an = parseInt(a.section.section_code.replace(/\D/g, "") || "0", 10);
        const bn = parseInt(b.section.section_code.replace(/\D/g, "") || "0", 10);
        return an - bn;
      });
      arr.forEach((row, i) => {
        map[row.section.section_id] = labelFor(row, i);
      });
    });
    return map;
  }

  // editable state
  const [editing, setEditing] = useState<{ row: OfferingRow; draft: any } | null>(null);
  const startEdit = (row: OfferingRow) => {
    setEditing({
      row,
      draft: {
        section_id: row.section.section_id,
        enrollment_cap: row.section.enrollment_cap,
        remarks: row.section.remarks,
        slot1: row.slot1
          ? { ...row.slot1 }
          : { day: "" as Day, start_time: "", end_time: "", room_id: "" },
        slot2: row.slot2
          ? { ...row.slot2 }
          : { day: "" as Day, start_time: "", end_time: "", room_id: "" },
      },
    });
  };
  const saveEdit = async () => {
    if (!editing || !user?.userId) return;
    await editApoOfferingRow(user.userId, editing.draft);
    await load();
    setEditing(null);
  };

  const [addAnchor, setAddAnchor] = useState<OfferingRow | null>(null);
  const [addDraft, setAddDraft] = useState<any>({
    batch_id: "",
    course_id: "",
    enrollment_cap: 40,
    remarks: "",
    slot1: { day: "" as Day, start_time: "", end_time: "", room_id: "" },
    slot2: { day: "" as Day, start_time: "", end_time: "", room_id: "" },
  });
  const doAdd = async () => {
    if (!user?.userId) return;
    await addApoOfferingRow(user.userId, addDraft);
    await load();
    setAddAnchor(null);
    setAddDraft({
      batch_id: "",
      course_id: "",
      enrollment_cap: 40,
      remarks: "",
      slot1: { day: "" as Day, start_time: "", end_time: "", room_id: "" },
      slot2: { day: "" as Day, start_time: "", end_time: "", room_id: "" },
    });
  };

  const doDelete = async (row: OfferingRow) => {
    if (!user?.userId) return;
    if (!confirm("Delete this section? This cannot be undone.")) return;
    await deleteApoOfferingRow(user.userId, { section_id: row.section.section_id });
    await load();
  };

  // Forward modal
  const [showForward, setShowForward] = useState(false);
  const [forwardTo, setForwardTo] = useState("");
  const [forwardSubject, setForwardSubject] = useState("Forwarding Course Offerings for Approval");
  const [forwardMsg, setForwardMsg] = useState("");

  const onImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f || !user?.userId) return;
    await importApoOfferingsCSV(user.userId, f);
    await load();
    e.currentTarget.value = "";
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role={campusLabel ? `${roleName} | ${campusLabel}` : roleName} />
      <Tabs
        mode="nav"
        items={[
          { label: "Pre-Enlistment", to: "/apo/preenlistment" },
          { label: "Course Offerings", to: "/apo/courseofferings" },
          { label: "Room Allocation", to: "/apo/roomallocation" },
        ]}
      />

      <main className="p-6 w-full">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by faculty, course code..."
              className="w-full rounded-lg border px-9 py-2 text-sm"
            />
          </div>

          <SelectBox
            value={level}
            onChange={(v: string) => setLevel(v)}
            options={["All Levels", ...(data?.filters.levels || [])]}
          />
          <SelectBox
            value={departmentName}
            onChange={(v: string) => setDepartmentName(v)}
            options={["All Departments", ...(data?.filters.departments || []).map((d) => d.department_name)]}
          />
          <SelectBox
            value={batchCode}
            onChange={(v: string) => setBatchCode(v)}
            options={["All ID", ...(data?.filters.ids || []).map((b) => b.batch_code)]}
          />
          <SelectBox
            value={programCode}
            onChange={(v: string) => setProgramCode(v)}
            options={["All Programs", ...(data?.filters.programs || []).map((p) => p.program_code)]}
          />

          <button
            onClick={() => setShowForward(true)}
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110"
          >
            <Send className="h-4 w-4" />
            Forward
          </button>
        </div>

        {/* Header & CSV */}
        <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-6 w-full" data-course-offerings>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold">Course Offerings</h2>
              <p className="text-sm text-gray-500">{loading ? "Loading…" : `Term ${data?.term_id || ""}`}</p>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
            <label className="cursor-pointer inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110">
              <Upload className="h-4 w-4" />
              Import CSV
              <input type="file" accept=".csv" onChange={onImportCSV} className="hidden" />
            </label>
          </div>

          {/* Workflow chips */}
          <div className="flex flex-wrap items-center gap-2 mt-3 mb-4">
            {["APO", "Office Manager", "APO", "Department Chair"].map((step, i) => (
              <React.Fragment key={i}>
                <span className={cls("rounded-full px-3 py-1 text-[13px] font-medium border", i === 0 ? "border-emerald-700 bg-emerald-700 text-white" : "border-gray-300 bg-white text-gray-800")}>
                  {step}
                </span>
                {i < 3 && <span className="text-gray-400">—</span>}
              </React.Fragment>
            ))}
          </div>

          {/* Group by ID card */}
          <div className="space-y-6">
            {Object.entries(grouped).map(([batchCodeKey, list]) => {
              const localProgramNos = computeProgramNos(list);
              return (
                <div key={batchCodeKey} className="rounded-xl border border-gray-300 bg-white shadow-sm">
                  <div className="bg-[#21804A] text-white rounded-t-xl px-4 py-3 flex items-center justify-center">
                    <h2 className="text-lg font-semibold text-center">{batchCodeKey}</h2>
                  </div>

                  <div className="p-4">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border-collapse table-fixed">
                        <thead className="bg-gray-50 text-emerald-800">
                          <tr className="text-[13px] font-semibold border-b border-gray-300">
                            <th className="px-3 py-2 text-left border-r">Program No.</th>
                            <th className="px-3 py-2 text-left border-r">Course Code & Title</th>
                            <th className="px-3 py-2 text-left border-r">Section</th>
                            <th className="px-3 py-2 text-left border-r">Faculty</th>
                            <th className="px-3 py-2 text-left border-r">Day 1</th>
                            <th className="px-3 py-2 text-left border-r">Begin 1</th>
                            <th className="px-3 py-2 text-left border-r">End 1</th>
                            <th className="px-3 py-2 text-left border-r">Room 1</th>
                            <th className="px-3 py-2 text-left border-r">Day 2</th>
                            <th className="px-3 py-2 text-left border-r">Begin 2</th>
                            <th className="px-3 py-2 text-left border-r">End 2</th>
                            <th className="px-3 py-2 text-left border-r">Room 2</th>
                            <th className="px-3 py-2 text-left border-r">Capacity</th>
                            <th className="px-3 py-2 text-left border-r">Remarks</th>
                            <th className="px-3 py-2 text-center">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((r) => {
                            const isEditing = editing?.row.section.section_id === r.section.section_id;
                            const renderView = (
                              <tr key={r.section.section_id} className="group border-t hover:bg-neutral-50">
                                <td className="px-3 py-2 border-r">{localProgramNos[r.section.section_id] || "—"}</td>
                                <td className="px-4 py-3 border-r font-semibold text-emerald-700">
                                  {r.course.course_code}
                                  <div className="text-xs text-gray-500">{r.course.course_title}</div>
                                </td>
                                <td className="px-3 py-2 border-r">{r.section.section_code}</td>
                                <td className="px-3 py-2 border-r">
                                  <span className={r.faculty.faculty_name === "UNASSIGNED" ? "text-red-600 font-medium" : ""}>
                                    {r.faculty.faculty_name}
                                  </span>
                                </td>
                                <td className="px-3 py-2 border-r">{r.slot1?.day || "—"}</td>
                                <td className="px-3 py-2 border-r">{fmtTime(r.slot1?.start_time)}</td>
                                <td className="px-3 py-2 border-r">{fmtTime(r.slot1?.end_time)}</td>
                                <td className="px-3 py-2 border-r">{r.slot1?.room_id || "—"}</td>
                                <td className="px-3 py-2 border-r">{r.slot2?.day || "—"}</td>
                                <td className="px-3 py-2 border-r">{fmtTime(r.slot2?.start_time)}</td>
                                <td className="px-3 py-2 border-r">{fmtTime(r.slot2?.end_time)}</td>
                                <td className="px-3 py-2 border-r">{r.slot2?.room_id || "—"}</td>
                                <td className="px-3 py-2 border-r">{r.section.enrollment_cap || "—"}</td>
                                <td className="px-3 py-2 border-r">{r.section.remarks || "—"}</td>
                                <td className="px-3 py-2 text-center">
                                  <div className="flex justify-center gap-3">
                                    <button className="text-emerald-700 hover:text-emerald-900" title="Edit" onClick={() => startEdit(r)}>
                                      <Edit className="h-4 w-4" />
                                    </button>
                                    <button className="text-red-500 hover:text-red-700" title="Delete" onClick={() => doDelete(r)}>
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                    <button
                                      className="text-emerald-700 hover:text-emerald-900"
                                      title="Add row after"
                                      onClick={() => {
                                        setAddAnchor(r);
                                        setAddDraft({
                                          batch_id: r.batch.batch_id, // prefill ID group
                                          course_id: r.course.course_id,
                                          enrollment_cap: r.section.enrollment_cap || 40,
                                          remarks: "",
                                          slot1: { day: "" as Day, start_time: "", end_time: "", room_id: "" },
                                          slot2: { day: "" as Day, start_time: "", end_time: "", room_id: "" },
                                        });
                                      }}
                                    >
                                      <Plus className="h-4 w-4" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );

                            const renderEdit = (
                              <tr key={r.section.section_id} className="border-t bg-neutral-50">
                                <td className="px-3 py-2 border-r">{localProgramNos[r.section.section_id] || "—"}</td>
                                <td className="px-4 py-3 border-r">
                                  <div className="font-semibold text-emerald-700">{r.course.course_code}</div>
                                  <div className="text-xs text-gray-500">{r.course.course_title}</div>
                                </td>
                                <td className="px-3 py-2 border-r">{r.section.section_code}</td>
                                <td className="px-3 py-2 border-r">{r.faculty.faculty_name || "UNASSIGNED"}</td>

                                <td className="px-3 py-2 border-r">
                                  <SelectBox
                                    value={editing?.draft.slot1?.day || ""}
                                    onChange={(v: string) =>
                                      setEditing((p) => p && { ...p, draft: { ...p.draft, slot1: { ...p.draft.slot1, day: v as Day } } })
                                    }
                                    options={["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]}
                                  />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input
                                    value={editing?.draft.slot1?.start_time || ""}
                                    onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot1: { ...p.draft.slot1, start_time: e.target.value } } })}
                                    className="w-full rounded-md border px-2 py-1 text-sm"
                                  />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input
                                    value={editing?.draft.slot1?.end_time || ""}
                                    onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot1: { ...p.draft.slot1, end_time: e.target.value } } })}
                                    className="w-full rounded-md border px-2 py-1 text-sm"
                                  />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input
                                    value={editing?.draft.slot1?.room_id || ""}
                                    onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot1: { ...p.draft.slot1, room_id: e.target.value } } })}
                                    className="w-full rounded-md border px-2 py-1 text-sm"
                                  />
                                </td>

                                <td className="px-3 py-2 border-r">
                                  <SelectBox
                                    value={editing?.draft.slot2?.day || ""}
                                    onChange={(v: string) =>
                                      setEditing((p) => p && { ...p, draft: { ...p.draft, slot2: { ...p.draft.slot2, day: v as Day } } })
                                    }
                                    options={["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]}
                                  />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input
                                    value={editing?.draft.slot2?.start_time || ""}
                                    onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot2: { ...p.draft.slot2, start_time: e.target.value } } })}
                                    className="w-full rounded-md border px-2 py-1 text-sm"
                                  />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input
                                    value={editing?.draft.slot2?.end_time || ""}
                                    onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot2: { ...p.draft.slot2, end_time: e.target.value } } })}
                                    className="w-full rounded-md border px-2 py-1 text-sm"
                                  />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input
                                    value={editing?.draft.slot2?.room_id || ""}
                                    onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot2: { ...p.draft.slot2, room_id: e.target.value } } })}
                                    className="w-full rounded-md border px-2 py-1 text-sm"
                                  />
                                </td>

                                <td className="px-3 py-2 border-r">
                                  <input
                                    value={editing?.draft.enrollment_cap || ""}
                                    onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, enrollment_cap: Number(e.target.value || 0) } })}
                                    className="w-full rounded-md border px-2 py-1 text-sm"
                                  />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input
                                    value={editing?.draft.remarks || ""}
                                    onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, remarks: e.target.value } })}
                                    className="w-full rounded-md border px-2 py-1 text-sm"
                                  />
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <div className="flex items-center justify-center gap-2">
                                    <button onClick={saveEdit} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50" title="Save">
                                      <Check className="h-4 w-4" strokeWidth={2.5} />
                                    </button>
                                    <button onClick={() => setEditing(null)} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50" title="Cancel">
                                      <X className="h-4 w-4" strokeWidth={2.5} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );

                            const renderAddInline = addAnchor?.section.section_id === r.section.section_id && (
                              <tr key={r.section.section_id + "-add"} className="bg-emerald-50/50 border-t">
                                <td className="px-3 py-2 border-r">—</td>
                                <td className="px-4 py-2 border-r">
                                  <div className="text-sm font-semibold text-emerald-700">{r.course.course_code}</div>
                                  <div className="text-xs text-neutral-600">{r.course.course_title}</div>
                                </td>
                                <td className="px-3 py-2 border-r">Auto</td>
                                <td className="px-3 py-2 border-r">UNASSIGNED</td>

                                <td className="px-3 py-2 border-r">
                                  <SelectBox value={addDraft.slot1.day || ""} onChange={(v: string) => setAddDraft((p: any) => ({ ...p, slot1: { ...p.slot1, day: v } }))} options={["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]} />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input value={addDraft.slot1.start_time || ""} onChange={(e) => setAddDraft((p: any) => ({ ...p, slot1: { ...p.slot1, start_time: e.target.value } }))} className="w-full rounded-md border px-2 py-1 text-sm" />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input value={addDraft.slot1.end_time || ""} onChange={(e) => setAddDraft((p: any) => ({ ...p, slot1: { ...p.slot1, end_time: e.target.value } }))} className="w-full rounded-md border px-2 py-1 text-sm" />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input value={addDraft.slot1.room_id || ""} onChange={(e) => setAddDraft((p: any) => ({ ...p, slot1: { ...p.slot1, room_id: e.target.value } }))} className="w-full rounded-md border px-2 py-1 text-sm" />
                                </td>

                                <td className="px-3 py-2 border-r">
                                  <SelectBox value={addDraft.slot2.day || ""} onChange={(v: string) => setAddDraft((p: any) => ({ ...p, slot2: { ...p.slot2, day: v } }))} options={["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]} />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input value={addDraft.slot2.start_time || ""} onChange={(e) => setAddDraft((p: any) => ({ ...p, slot2: { ...p.slot2, start_time: e.target.value } }))} className="w-full rounded-md border px-2 py-1 text-sm" />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input value={addDraft.slot2.end_time || ""} onChange={(e) => setAddDraft((p: any) => ({ ...p, slot2: { ...p.slot2, end_time: e.target.value } }))} className="w-full rounded-md border px-2 py-1 text-sm" />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input value={addDraft.slot2.room_id || ""} onChange={(e) => setAddDraft((p: any) => ({ ...p, slot2: { ...p.slot2, room_id: e.target.value } }))} className="w-full rounded-md border px-2 py-1 text-sm" />
                                </td>

                                <td className="px-3 py-2 border-r">
                                  <input value={addDraft.enrollment_cap} onChange={(e) => setAddDraft((p: any) => ({ ...p, enrollment_cap: Number(e.target.value || 0) }))} className="w-full rounded-md border px-2 py-1 text-sm" />
                                </td>
                                <td className="px-3 py-2 border-r">
                                  <input value={addDraft.remarks} onChange={(e) => setAddDraft((p: any) => ({ ...p, remarks: e.target.value }))} className="w-full rounded-md border px-2 py-1 text-sm" />
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <div className="flex justify-center gap-2">
                                    <button onClick={doAdd} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50" title="Save">
                                      <Check className="h-4 w-4" strokeWidth={2.5} />
                                    </button>
                                    <button onClick={() => setAddAnchor(null)} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50" title="Cancel">
                                      <X className="h-4 w-4" strokeWidth={2.5} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );

  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      {steps.map((step, i) => {
        const isFirstApo = step === "APO" && !seenFirstApo;
        if (isFirstApo) seenFirstApo = true;
        return (
          <React.Fragment key={`${step}-${i}`}>
            <span
              className={cls(
                "rounded-full px-3 py-1 text-[13px] font-medium border",
                isFirstApo
                  ? "border-emerald-700 bg-emerald-700 text-white"
                  : "border-gray-300 bg-white text-gray-800"
              )}
            >
              {step}
            </span>
            {i < steps.length - 1 && <span className="text-gray-400">—</span>}
          </React.Fragment>
        );
      })}
    </div>
  );
};

/* ----------------------- Page ----------------------- */
export default function CourseOfferingsScreen() {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("All Levels");
  const [department, setDepartment] = useState("All Departments");
  const [program, setProgram] = useState("All Programs");
  const [idFilter, setIdFilter] = useState("All ID");
  const [courses, setCourses] = useState<Course[]>([]);
  const [showForward, setShowForward] = useState(false);

  const filteredCourses = courses.filter((c) => {
    const N = (s: string) => norm(s, { upper: false }); // lower, trimmed, spaces collapsed
    const q = N(search);

    const matchesSearch =
      !q ||
      N(c.code).includes(q) ||
      N(c.title).includes(q) ||
      N(c.level).includes(q) ||
      N(c.department).includes(q) ||
      c.ids.some((id) => N(id).includes(q)) ||
      c.programs.some((p) => N(p).includes(q)) ||
      c.sections.some((s) =>
        [
          s[2],
          s[3],
          s[4],
          s[5],
          s[6],
          s[7],
          s[8],
          s[9],
          s[10],
          s[11],
          s[12],
          fmtTime(s[5]),
          fmtTime(s[6]),
          fmtTime(s[9]),
          fmtTime(s[10]),
        ]
          .filter(Boolean)
          .some((v) => N(v).includes(q))
      );

    const matchesLevel = level === "All Levels" || c.level === level;
    const matchesDept = department === "All Departments" || c.department === department;
    const matchesId = idFilter === "All ID" || c.ids.includes(idFilter);
    const matchesProgram = program === "All Programs" || c.programs.includes(program);

    return matchesSearch && matchesLevel && matchesDept && matchesId && matchesProgram;
  });

  // Removed old "addingCourse" panel/state and related busy flagging.
  const [editingCourseCode] = useState<string | null>(null); // kept for compatibility if you repurpose later
  const [busyByCourse] = useState<Record<string, boolean>>({});

  const busy = Object.values(busyByCourse).some(Boolean) || editingCourseCode !== null;

  const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const rows = parseCSV(text);
      if (!rows.length) {
        alert("⚠️ CSV is empty or invalid!");
        return;
      }

      const headerRow = rows[0].map((h, idx) =>
        idx === 0 ? h.replace(/^\uFEFF/, "").toLowerCase() : h.toLowerCase()
      );
      const dataRows = rows.slice(1);
      const idxOf = (key: string) => headerRow.indexOf(key.toLowerCase());
      const get = (cols: string[], key: string) => {
        const i = idxOf(key);
        return i === -1 ? "" : cols[i]?.trim() ?? "";
      };

      const courseMap: Record<string, Course> = {};
      // GLOBAL section counters per COURSE CODE, seeded from what’s already on the page
      const sectionCounterByCode: Record<string, number> = {};
      for (const existing of courses) {
        const codeKey = norm(existing.code);
        let maxNum = 10; // so the next becomes at least S11
        for (const s of existing.sections) {
          const m = /^S(\d+)$/.exec(s[2] || "");
          if (m) {
            const n = parseInt(m[1], 10);
            if (n > maxNum) maxNum = n;
          }
        }
        sectionCounterByCode[codeKey] = Math.max(sectionCounterByCode[codeKey] ?? 10, maxNum);
      }

      for (const cols of dataRows) {
        const rawId = get(cols, "id");
        const rawProgram = get(cols, "program");
        const rawProgCode = get(cols, "program code");
        const rawCode = get(cols, "course code");
        const rawTitle = get(cols, "course title");
        const rawDept = get(cols, "department");
        const rawFaculty = get(cols, "faculty");
        const rawCap = get(cols, "capacity");

        const id = norm(rawId);
        const program = norm(rawProgram);
        const programCode = norm(rawProgCode);
        const code = norm(rawCode);
        const title = norm(rawTitle, { upper: false });
        const faculty = rawFaculty?.trim() ? rawFaculty.trim() : "Unassigned";
        const cap = rawCap?.trim() || "40";

        if (!id || !programCode || !code || !title) continue;

        // The unique key uses program + programCode + code (not ID)
        const uniqueKey = `${program}|${programCode}|${code}`;

        if (sectionCounterByCode[code] == null) sectionCounterByCode[code] = 10;
        const sectionCode = `S${++sectionCounterByCode[code]}`;

        if (!courseMap[uniqueKey]) {
          courseMap[uniqueKey] = {
            code,
            title: rawTitle.trim(),
            level: "Undergraduate",
            department:
              (rawDept as Course["department"]) || "Department of Software Technology",
            ids: [id],
            programs: [program],
            programCodes: [programCode],
            sections: [],
          };
        } else {
          if (!courseMap[uniqueKey].ids.includes(id)) courseMap[uniqueKey].ids.push(id);
        }

        const existing = courseMap[uniqueKey].sections.find(
          (s) => s[2] === sectionCode && s[3] === faculty
        );
        if (!existing) {
          const newSection: SectionRow = [
            courseMap[uniqueKey].title,
            "3",
            sectionCode,
            faculty,
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            cap,
            "", // Remarks
          ];
          courseMap[uniqueKey].sections.push(newSection);
        }
      }

      const loaded = Object.values(courseMap);
      if (!loaded.length) {
        alert("⚠️ No valid course data found in CSV!");
        return;
      }
      setCourses(loaded);
      alert("✅ CSV imported successfully!");
    };
    reader.readAsText(file);
  };

  const courseCatalog = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of courses) if (c.code && c.title && !map[c.code]) map[c.code] = c.title;
    return map;
  }, [courses]);

  const replaceCourse = (prevCourse: Course, updated: Course) => {
    setCourses((arr) => arr.map((c) => (c === prevCourse ? updated : c)));
  };

  const addCourse = (course: Course) => {
    setCourses((prev) => [...prev, course]);
  };

  const removeCourse = (target: Course) => {
    setCourses((arr) => arr.filter((c) => c !== target));
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName="Hazel Ventura" role="Academic Programming Officer" />

      <main className="p-6 w-full">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by faculty, course code..."
              disabled={busy}
              className={cls(
                "w-full rounded-lg border px-9 py-2 text-sm",
                busy && "bg-gray-100 cursor-not-allowed opacity-50"
              )}
            />
          </div>

          <SelectBox
            value={level}
            onChange={setLevel}
            options={["All Levels", "Senior High School", "Undergraduate", "Graduate"]}
            disabled={busy}
          />
          <SelectBox
            value={department}
            onChange={setDepartment}
            options={[
              "All Departments",
              "Department of Software Technology",
              "Department of Computer Technology",
              "Department of Information Technology",
            ]}
            disabled={busy}
          />
          <SelectBox
            value={idFilter}
            onChange={setIdFilter}
            options={["All ID", "ID 125", "ID 124", "ID 123", "ID 122", "ID 121", "ID 120"]}
            disabled={busy}
          />
          <SelectBox
            value={program}
            onChange={setProgram}
            options={[
              "All Programs",
              "BSCS-ST",
              "BSCS-NIS",
              "BSCS-CSE",
              "BSMS-CS",
              "BS IET-GD",
              "BS IET-AD",
              "BSIT",
              "BSIS",
              "Others",
            ]}
            disabled={busy}
          />

          <button
            onClick={() => setShowForward(true)}
            disabled={busy}
            className={cls(
              "ml-auto inline-flex items-center gap-2 rounded-md bg-[#006045] px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110",
              busy && "opacity-50 cursor-not-allowed hover:brightness-100"
            )}
            title={busy ? "Finish current action first" : "Forward"}
          >
            <Send className="h-4 w-4" />
            Forward
          </button>
        </div>

        <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-6 w-full" data-course-offerings>
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold">Course Offerings</h2>
              <p className="text-sm text-gray-500">Term 1 AY 2025-2026</p>
            </div>

            <label className="cursor-pointer inline-flex items-center gap-2 rounded-md bg-[#008e4e] px-4 py-2 text-sm font-medium text-white hover:brightness-110">
              <Upload className="h-4 w-4" />
              Import CSV
              <input type="file" accept=".csv" onChange={handleImportCSV} className="hidden" />
            </label>
          </div>

          {/* Workflow */}
          <div className="my-4">
            <WorkflowChips />
          </div>

          {/* ID Cards */}
          <div className="space-y-6">
            {[...new Set(filteredCourses.flatMap((c) => c.ids))].map((id) => {
              const idCourses = filteredCourses.filter((c) => c.ids.includes(id));
              if (!idCourses.length) return null;
              return (
                <IDCard
                  key={id}
                  id={id}
                  courses={idCourses}
                  allCourses={courses}
                  globalBusy={busy}
                  onAddCourse={addCourse}
                  onReplaceCourse={replaceCourse}
                  onRemoveCourse={removeCourse}
                  courseCatalog={courseCatalog}
                />
              );
            })}
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
                  <span>📎 Attached: <strong>Course_Offerings_Term_{data?.term_id || ""}.html</strong></span>
                  <span className="text-xs text-neutral-600">Preview is generated from table</span>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium">To:</label>
                    <input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} type="email" placeholder="Recipient email" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium">Subject:</label>
                    <input value={forwardSubject} onChange={(e) => setForwardSubject(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium">Message:</label>
                    <textarea value={forwardMsg} onChange={(e) => setForwardMsg(e.target.value)} className="h-40 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30" />
                  </div>
                </div>

                <div className="flex justify-end gap-2 mt-5">
                  <button onClick={() => setShowForward(false)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50">Cancel</button>
                  <button
                    onClick={async () => {
                      const container = document.querySelector("[data-course-offerings]") as HTMLElement | null;
                      if (!container || !user?.userId) return;
                      const clone = container.cloneNode(true) as HTMLElement;
                      // Remove controls from attachment
                      clone.querySelectorAll("button, svg, select, input").forEach((el) => el.remove());
                      clone.querySelectorAll("th:last-child, td:last-child").forEach((el) => el.remove());
                      await forwardApoCourseOfferings(user.userId, {
                        to: forwardTo,
                        subject: forwardSubject,
                        message: forwardMsg,
                        attachment_html: clone.innerHTML,
                      });
                      setShowForward(false);
                      alert("Sent to outbox.");
                    }}
                    className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
