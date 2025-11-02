// frontend/src/pages/APO/CourseOfferingsPage.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Edit,
  Trash2,
  Check,
  Search,
  X,
  Send,
  Plus,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import {
  getApoCourseOfferings,
  addApoOfferingRow,
  editApoOfferingRow,
  deleteApoOfferingRow,
  forwardApoCourseOfferings,
  approveApoOfferingsPlan,
  curriculumAddCourse,
  curriculumEditCourse,
  curriculumRemoveCourse,
  type ApiConflict,
} from "../../api";

/* --------------------------------- helpers --------------------------------- */

type RoomOption = {
  room_id: string;
  room_number: string;
  capacity?: number | null;
  room_type?: string | null;
};

const filterRoomsByCap = (options: RoomOption[], cap?: number | null) => {
  const c = typeof cap === "number" ? cap : 0;
  const seen = new Set<string>();
  const unique = (options || []).filter((o) => {
    const key = (o.room_id ?? "") + "::" + (o.room_number ?? "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.filter((r) => typeof r.capacity !== "number" || !c || (r.capacity as number) >= c);
};

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const fmtTime = (s?: string) => {
  const t = (s || "").replace(/\D/g, "");
  if (t.length !== 4) return s || "—";
  return `${t.slice(0, 2)}:${t.slice(2)}`;
};
const normCode = (s?: string) =>
  (s || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^ID\s*(\d+)$/, "ID $1");

type Day = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";

/* ---------------------------------- types ---------------------------------- */

type OfferingRow = {
  program_no: string;
  batch: { batch_id: string; batch_code: string; batch_number?: number | null };
  program: { program_id?: string; program_code?: string };
  course: {
    course_id: string;
    course_code: string;
    course_title: string;
    program_level?: string;
    program_level_label?: string;
    department_id?: string;
    department_name?: string;
  };
  section: { section_id: string; section_code: string; enrollment_cap: number | null; remarks: string };
  faculty: { faculty_id?: string | null; user_id?: string | null; faculty_name: string };
  slot1?: { schedule_id?: string; day: Day | ""; start_time: string; end_time: string; room_id?: string; room_number?: string };
  slot2?: { schedule_id?: string; day: Day | ""; start_time: string; end_time: string; room_id?: string; room_number?: string };
  sizing: {
    preenlistment_total: number;
    cohort_estimate: number;
    planning_demand: number;
    planned_capacity: number;
    existing_sections: number;
    suggest_additional: number;
    deficit: number;
  };
  links: {
    curriculum_id?: string;
    term_id: string;
    course_id: string;
    batch_id?: string;
    program_id?: string;
    section_id?: string;
  };
};

type CourseOption = { course_id: string; course_code: string; course_title: string };

type PlanningChange =
  | {
      type: "add_course_to_curriculum";
      course_id: string;
      count?: number;
      target?: { program_id: string; batch_id: string } | null;
    }
  | { type: "sections_increase"; course_id: string; by_sections?: number; by_capacity?: number }
  | { type: "sections_decrease"; course_id: string; by_sections?: number; by_capacity?: number };

type OfferingsResponse = {
  campus: { campus_id: string; campus_name: string };
  term_id: string;
  term_label: string;
  filters: {
    levels: string[];
    departments: { department_id: string; department_name: string }[];
    ids: { batch_id: string; batch_code: string }[];
    programs: { program_id: string; program_code: string }[];
  };
  rows: OfferingRow[];
  course_options_by_group: Record<string, CourseOption[]>;
  room_options: RoomOption[];
  planning?: {
    needs_import: boolean;
    approval_required: boolean;
    pending_changes?: PlanningChange[];
  };
};

type CurriculumItem = {
  program_id: string;
  program_code: string;
  department_id: string;
  department_name: string;
  batch_id: string;
  batch_code: string;
  courses: {
    course_id: string;
    code: string;
    title: string;
    department_id: string;
    department_name?: string;
    program_level?: string;
    source?: "DB" | "custom" | string;
    units?: number | null;
  }[];
};

type DeptCourseOption = {
  course_id: string;
  course_code: string;
  course_title: string;
  department_id: string;
  program_level?: string;
  program_level_code?: string;
  units?: number | null;
};
type CurriculumResponse = {
  campus: { campus_id: string; campus_name: string };
  term_id: string;
  term_label: string;
  items: CurriculumItem[];
  course_options_by_program: Record<string, DeptCourseOption[]>;
  departments: { department_id: string; department_name: string }[];
};

/* ---------------------------- small action types ---------------------------- */

type ActionKind = "add" | "edit" | "delete";

type AddDraft = {
  batch_id: string;
  program_id?: string;
  course_id: string;
  enrollment_cap?: number;
  remarks?: string;
  slot1?: { room_id?: string };
  slot2?: { room_id?: string };
  section_code?: string;
  auto_approve?: boolean;
};
type EditDraft = {
  section_id: string;
  section_code?: string;
  enrollment_cap?: number | "";
  remarks?: string;
  slot1?: { room_id?: string };
  slot2?: { room_id?: string };
};
type DelDraft = { section_id: string };

type ConflictState = {
  action: ActionKind;
  token: string;
  violations: { code: string; level: string; message: string; data?: any }[];
  preview: any;
  original: AddDraft | EditDraft | DelDraft;
  reason: string;
};

type ViewMode = "offerings" | "curriculum";

/* --------------------------------- component -------------------------------- */

export default function CourseOfferingsPage() {
  const [view, setView] = useState<ViewMode>("offerings");

  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<string>("All Levels");
  const [departmentName, setDepartmentName] = useState<string>("All Departments");
  const [programCode, setProgramCode] = useState<string>("All Programs");
  const [batchCode, setBatchCode] = useState<string>("All ID");

  const [data, setData] = useState<OfferingsResponse | null>(null);
  const [rows, setRows] = useState<OfferingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  // curriculum state
  const [curr, setCurr] = useState<CurriculumResponse | null>(null);
  const [currSearch, setCurrSearch] = useState("");

  // per-program add selection (code-only select still stores course_id)
  const [currAddSel, setCurrAddSel] = useState<Record<string, string>>({}); // program_id -> selected course_id

  // Offerings collapse state (keyed by "ID::PROGRAM")
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fullName = user?.fullName ?? "APO";
  const roleName = useMemo(() => {
    if (!user?.roles) return "Academic Programming Officer";
    return (user.roles as string[]).some((r) => /^apo\b/i.test(r))
      ? "Academic Programming Officer"
      : user.roles[0] || "User";
  }, [user]);
  const campusLabel = data?.campus?.campus_name || curr?.campus?.campus_name || "";

  /* ---------------------------------- load ---------------------------------- */

  const resolveFilterIds = () => {
    const deptId =
      departmentName === "All Departments"
        ? undefined
        : data?.filters.departments.find((d) => d.department_name === departmentName)?.department_id;
    const progId =
      programCode === "All Programs"
        ? undefined
        : (data?.filters.programs || []).find((p) => p.program_code === programCode)?.program_id;
    const bId =
      batchCode === "All ID"
        ? undefined
        : (data?.filters.ids || []).find((b) => normCode(b.batch_code) === normCode(batchCode))?.batch_id;
    return { deptId, progId, bId };
  };

  const loadOfferings = async () => {
    if (!user?.userId) return;
    setLoading(true);
    setErr(null);
    try {
      const { deptId, progId, bId } = resolveFilterIds();
      const resp = await getApoCourseOfferings(user.userId, {
        view: "offerings",
        level: level === "All Levels" ? undefined : level,
        department_id: deptId,
        program_id: progId,
        batch_id: bId,
      });
      setData(resp as OfferingsResponse);
      setRows((resp as OfferingsResponse).rows);
    } catch (e: any) {
      setErr(e?.message || "Failed to load course offerings.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const loadCurriculum = async () => {
    if (!user?.userId) return;
    setLoading(true);
    setErr(null);
    try {
      const resp = (await getApoCourseOfferings(user.userId, { view: "curriculum" })) as unknown as CurriculumResponse;
      setCurr(resp);
    } catch (e: any) {
      setErr(e?.message || "Failed to load curriculum.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (view === "offerings") loadOfferings();
    else loadCurriculum();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (view === "offerings") loadOfferings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, departmentName, programCode, batchCode]);

  /* -------------------------- offerings: gating flags ------------------------- */

  const blockedByImport = view === "offerings" && !!data?.planning?.needs_import;
  const blockedByApproval = view === "offerings" && !blockedByImport && !!data?.planning?.approval_required;

  const [showForward, setShowForward] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  useEffect(() => {
    if (blockedByApproval) setShowPlanModal(true);
  }, [blockedByApproval]);

  /* --------------------------------- filters -------------------------------- */

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

  const searchPlaceholder =
    view === "curriculum"
      ? "Search by Program, ID, code, title…"
      : "Search by Program No., code, title, faculty, room…";

  /* ------------------------------ offerings table ----------------------------- */

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
        hit(c.program_level_label) ||
        hit(c.department_name) ||
        hit(sec.section_code) ||
        hit(sec.enrollment_cap ?? "") ||
        hit(sec.remarks) ||
        hit(f.faculty_name) ||
        (s1 &&
          (hit(s1.day) ||
            hit(fmtTime(s1.start_time)) ||
            hit(fmtTime(s1.end_time)) ||
            hit(s1.room_id) ||
            hit(s1.room_number))) ||
        (s2 &&
          (hit(s2.day) ||
            hit(fmtTime(s2.start_time)) ||
            hit(fmtTime(s2.end_time)) ||
            hit(s2.room_id) ||
            hit(s2.room_number))) ||
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

  /* ---------------------------- offerings: editing --------------------------- */

  const [editing, setEditing] = useState<{ row: OfferingRow; draft: EditDraft } | null>(null);

  const startEdit = (row: OfferingRow) => {
    if (blockedByImport || blockedByApproval) return;
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

  const handleConflict = (action: ActionKind, apiConflict: ApiConflict, original: any) => {
    setConflict({
      action,
      token: apiConflict.override_token,
      violations: (apiConflict.violations || []).map((v: any) => ({
        code: v.code,
        level: v.level ?? "error",
        message: v.message,
        data: v.data,
      })),
      preview: apiConflict.preview_changes || {},
      original,
      reason: "",
    });
  };

  const saveEdit = async () => {
    if (!editing || !user?.userId) return;
    const basePayload: any = { ...editing.draft, course_id: editing.row.course.course_id };
    const res = await editApoOfferingRow(user.userId, basePayload as any);
    if ("conflict" in res) {
      handleConflict("edit", res.conflict, basePayload);
      return;
    }
    await loadOfferings();
    setEditing(null);
  };

  /* ----------------------------- offerings: add row ----------------------------- */

  const rowKeyOf = (r: OfferingRow) =>
    r.section.section_id
      ? `sec:${r.section.section_id}`
      : `combo:${r.batch.batch_id}|${r.program.program_id}|${r.course.course_id}`;

  const [addAnchorKey, setAddAnchorKey] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<AddDraft>({
    batch_id: "",
    program_id: "",
    course_id: "",
    enrollment_cap: 20,
    remarks: "",
    slot1: { room_id: "" },
    slot2: { room_id: "" },
  });
  const [addCourseCode, setAddCourseCode] = useState<string>("— Select a course —");
  const [adding, setAdding] = useState(false);

  const SAFE_AUTO_CODES = new Set([
    "NO_ROOM_SET",
    "SEAT_DEFICIT",
    "PREFIX_MISMATCH",
    "CODE_WITHOUT_NUMBER",
    "PLAN_NOT_APPROVED",
  ]);

  const doAdd = async () => {
    if (blockedByImport || blockedByApproval) return;
    if (!user?.userId || !addDraft.course_id) return;
    setAdding(true);
    try {
      const base = { ...addDraft };
      const res = await addApoOfferingRow(user.userId, base);
      if ("conflict" in res) {
        const allSafe = (res.conflict.violations || []).every((v) => SAFE_AUTO_CODES.has(v.code));
        if (!allSafe) {
          handleConflict("add", res.conflict, base);
          return;
        }
        const ov = await addApoOfferingRow(user.userId, {
          ...base,
          override: true,
          override_token: res.conflict.override_token,
          override_reason: "Proceed despite planning warnings",
        });
        if ("conflict" in ov) {
          handleConflict("add", ov.conflict, base);
          return;
        }
      }
      await loadOfferings();
      setAddAnchorKey(null);
      setAddCourseCode("— Select a course —");
      setAddDraft({
        batch_id: "",
        program_id: "",
        course_id: "",
        enrollment_cap: 20,
        remarks: "",
        slot1: { room_id: "" },
        slot2: { room_id: "" },
      });
    } finally {
      setAdding(false);
    }
  };

  const doDelete = async (row: OfferingRow) => {
    if (blockedByImport || blockedByApproval) return;
    if (!user?.userId || !row.section.section_id) return;
    if (!confirm("Delete this section? This cannot be undone.")) return;
    setRows((prev) => prev.filter((r) => r.section.section_id !== row.section.section_id));
    if (editing?.row.section.section_id === row.section.section_id) setEditing(null);
    const res = await deleteApoOfferingRow(user.userId, { section_id: row.section.section_id });
    if ("conflict" in res) {
      handleConflict("delete", res.conflict, { section_id: row.section.section_id });
      return;
    }
    await loadOfferings();
  };

  /* --------------------------- curriculum structures -------------------------- */

  const currPrograms = useMemo(() => {
    const arr = (curr?.items || []).map((i) => ({ id: i.program_id, code: i.program_code }));
    const uniq = arr.filter((x, idx) => arr.findIndex((a) => a.id === x.id) === idx);
    return uniq;
  }, [curr?.items]);

  const currBatches = useMemo(() => {
    const arr = (curr?.items || []).map((i) => ({ id: i.batch_id, code: i.batch_code }));
    const uniq = arr.filter((x, idx) => arr.findIndex((a) => a.id === x.id) === idx);
    return uniq;
  }, [curr?.items]);

  const selectedProgramId = useMemo(() => {
    if (programCode === "All Programs") return undefined;
    return currPrograms.find((p) => p.code === programCode)?.id;
  }, [programCode, currPrograms]);

  const selectedBatchId = useMemo(() => {
    if (batchCode === "All ID") return undefined;
    return currBatches.find((b) => normCode(b.code) === normCode(batchCode))?.id;
  }, [batchCode, currBatches]);

  const selectedDeptName = useMemo(() => {
    if (!selectedProgramId) return "—";
    const item = (curr?.items || []).find((i) => i.program_id === selectedProgramId);
    return item?.department_name || "—";
  }, [selectedProgramId, curr?.items]);

  const optionsByProgram: Record<string, DeptCourseOption[]> = curr?.course_options_by_program || {};

  // map per-program items (filtered by program/batch)
  const columns = useMemo(() => {
    const map: Record<string, CurriculumItem> = {};
    for (const i of curr?.items || []) {
      if (selectedBatchId && i.batch_id !== selectedBatchId) continue;
      if (selectedProgramId && i.program_id !== selectedProgramId) continue;
      if (!map[i.program_id]) map[i.program_id] = { ...i, courses: [...i.courses] };
      else map[i.program_id].courses = [...map[i.program_id].courses, ...i.courses];
    }
    for (const k of Object.keys(map)) {
      const seen = new Set<string>();
      map[k].courses = map[k].courses
        .filter((c) => (seen.has(c.course_id) ? false : (seen.add(c.course_id), true)))
        .sort((a, b) => a.code.localeCompare(b.code));
    }
    return map;
  }, [curr?.items, selectedBatchId, selectedProgramId]);

  const programOrder = useMemo(
    () => Object.keys(columns).sort((a, b) => (columns[a]?.program_code || "").localeCompare(columns[b]?.program_code || "")),
    [columns]
  );

  // Build whitelist: which course_ids belong to each program’s overall curriculum (across all terms)
  const eligibleCourseIdsByProgram = useMemo(() => {
    const m: Record<string, Set<string>> = {};
    (curr?.items || []).forEach((it) => {
      const bag = (m[it.program_id] ||= new Set<string>());
      it.courses.forEach((c) => bag.add(c.course_id));
    });
    return m;
  }, [curr?.items]);

  /* ------------------------------ curriculum CRUD ----------------------------- */

  const handleCurrAdd = async (program_id: string, batch_id: string, course_id: string) => {
    if (!user?.userId || !course_id) return;
    await curriculumAddCourse(user.userId, { program_id, batch_id, course_id } as any);
    setCurrAddSel((p) => ({ ...p, [program_id]: "" }));
    await loadCurriculum();
  };

  const handleCurrAddCustom = async (
    program_id: string,
    batch_id: string,
    newCourse: { course_code: string; course_title: string; department_id: string; program_level: string; units?: number }
  ) => {
    if (!user?.userId) return;
    await curriculumAddCourse(user.userId, { program_id, batch_id, new_course: newCourse } as any);
    setCurrAddSel((p) => ({ ...p, [program_id]: "" }));
    await loadCurriculum();
  };

  const handleCurrReplace = async (program_id: string, batch_id: string, old_course_id: string, new_course_id: string) => {
    if (!user?.userId) return;
    await curriculumEditCourse(user.userId, { program_id, batch_id, old_course_id, new_course_id } as any);
    await loadCurriculum();
  };

  const handleCurrEditUnits = async (program_id: string, batch_id: string, course_id: string, units: number | null) => {
    if (!user?.userId) return;
    await curriculumEditCourse(user.userId, {
      program_id,
      batch_id,
      old_course_id: course_id,
      update_course: { units },
    } as any);
    await loadCurriculum();
  };

  const handleCurrRemove = async (program_id: string, batch_id: string, course_id: string) => {
    if (!user?.userId) return;
    if (!confirm("Remove this course from the curriculum?")) return;
    await curriculumRemoveCourse(user.userId, { program_id, batch_id, course_id });
    await loadCurriculum();
  };

  /* ----------------------------------- UI ----------------------------------- */

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
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={view === "offerings" ? search : currSearch}
              onChange={(e) => (view === "offerings" ? setSearch(e.target.value) : setCurrSearch(e.target.value))}
              placeholder={searchPlaceholder}
              className="w-full rounded-lg border px-9 py-2 text-sm"
            />
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div className="inline-flex overflow-hidden rounded-lg border border-emerald-700">
              <button
                onClick={() => setView("offerings")}
                className={cls(
                  "px-3 py-1.5 text-sm font-medium",
                  view === "offerings" ? "bg-emerald-700 text-white" : "bg-white text-emerald-700"
                )}
              >
                Offerings
              </button>
              <button
                onClick={() => setView("curriculum")}
                className={cls(
                  "px-3 py-1.5 text-sm font-medium border-l border-emerald-700",
                  view === "curriculum" ? "bg-emerald-700 text-white" : "bg-white text-emerald-700"
                )}
              >
                Curriculum
              </button>
            </div>

            {view === "offerings" && (
              <button
                onClick={() => setShowForward(true)}
                className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm"
              >
                <Send className="h-4 w-4" />
                Forward
              </button>
            )}
          </div>

          {/* Offerings filters */}
          {view === "offerings" && (
            <>
              <SelectBox value={level} onChange={(v: string) => setLevel(v)} options={["All Levels", ...(data?.filters.levels || [])]} />
              <SelectBox
                value={departmentName}
                onChange={(v: string) => setDepartmentName(v)}
                options={["All Departments", ...(data?.filters.departments || []).map((d) => d.department_name)]}
              />
              <SelectBox value={batchCode} onChange={(v: string) => setBatchCode(v)} options={idOptions} />
              <SelectBox
                value={programCode}
                onChange={(v: string) => setProgramCode(v)}
                options={["All Programs", ...(data?.filters.programs || []).map((p) => p.program_code)]}
              />
            </>
          )}

          {/* Curriculum filters */}
          {view === "curriculum" && (
            <>
              <SelectBox
                value={programCode}
                onChange={(v: string) => {
                  setProgramCode(v);
                  setCurrAddSel({});
                }}
                options={["All Programs", ...currPrograms.map((p) => p.code)]}
              />
              <SelectBox
                value={batchCode}
                onChange={(v: string) => {
                  setBatchCode(v);
                  setCurrAddSel({});
                }}
                options={["All ID", ...currBatches.map((b) => b.code)]}
              />
              <div className="text-sm text-neutral-700">
                <span className="font-medium text-emerald-800">Department:</span> {selectedDeptName}
              </div>
            </>
          )}
        </div>

        {/* card */}
        <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-4 sm:p-6 w-full" data-course-offerings>
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <div>
              <h2 className="text-lg font-bold">{view === "curriculum" ? "Curriculum" : "Course Offerings"}</h2>
              <p className="text-sm text-gray-500">{loading ? "Loading…" : data?.term_label || curr?.term_label || ""}</p>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
          </div>

          {/* planning banner */}
          {view === "offerings" && data?.planning && (
            <>
              {data.planning.needs_import && (
                <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">Import Pre-Enlistment first</div>
                    <a href="/apo/preenlistment" className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm">
                      Go to Pre-Enlistment
                    </a>
                  </div>
                </div>
              )}
              {!data.planning.needs_import && data.planning.approval_required && (
                <div className="mb-4 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-blue-900">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">Planning updates are ready</div>
                    <button
                      className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm"
                      onClick={() => setShowPlanModal(true)}
                    >
                      Review &amp; Approve
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ------------------------------ Offerings ------------------------------ */}
          {view === "offerings" && (
            <>
              {blockedByImport ? (
                <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-8 text-center text-amber-900">
                  <p className="text-sm">Pre-Enlistment count and statistics are required before planning course offerings.</p>
                  <a href="/apo/preenlistment" className="mt-3 inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm">
                    Go to Pre-Enlistment
                  </a>
                </div>
              ) : (
                Object.entries(groups).map(([idLabel, byProgram]) => (
                  <div key={idLabel} className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-hidden mb-6">
                    <div className="bg-[#21804A] text-white px-4 py-3 text-center font-semibold">{idLabel}</div>
                    {Object.entries(byProgram).map(([progLabel, list]) => {
                      const key = `${idLabel}::${progLabel}`;
                      const isCollapsed = !!collapsedGroups[key];
                      return (
                        <div key={key} className="border-t border-gray-200">
                          <button
                            onClick={() =>
                              setCollapsedGroups((prev) => ({
                                ...prev,
                                [key]: !prev[key],
                              }))
                            }
                            className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left"
                          >
                            <span className="font-semibold text-emerald-800">{progLabel}</span>
                            <ChevronDown className={cls("h-4 w-4 transition-transform", isCollapsed && "rotate-180")} />
                          </button>

                          {!isCollapsed && (
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
                                    <col className="w-32" />
                                    <col className="w-24" />
                                    <col className="w-24" />
                                    <col className="w-24" />
                                    <col className="w-32" />
                                    <col className="w-24" />
                                    <col className="min-w-[160px] w-[200px]" />
                                    <col className="w-36" />
                                  </colgroup>
                                  <thead className="bg-gray-50 text-emerald-800 sticky top-0 z-10">
                                    <tr className="text-[13px] font-semibold">
                                      {[
                                        "Program No.",
                                        "Course Code & Title",
                                        "Section",
                                        "Faculty",
                                        "Day 1",
                                        "Begin 1",
                                        "End 1",
                                        "Room 1",
                                        "Day 2",
                                        "Begin 2",
                                        "End 2",
                                        "Room 2",
                                        "Capacity",
                                        "Remarks",
                                        "Actions",
                                      ].map((h, i) => (
                                        <th key={i} className="px-3 py-2 text-left border border-gray-300">
                                          {h}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {list.map((r) => {
                                      const isEditing = editing?.row.section.section_id === r.section.section_id;
                                      const canEditDelete = !!r.section.section_id && !blockedByApproval;
                                      const rowKey = rowKeyOf(r);

                                      const suggestion =
                                        r.sizing?.deficit > 0 || (r.sizing?.suggest_additional || 0) > 0 ? (
                                          <div className="mt-1 text-xs text-gray-600">
                                            <span className="mr-3">
                                              Demand: <strong>{r.sizing.planning_demand}</strong>
                                            </span>
                                            <span className="mr-3">
                                              Pre-enlisted: <strong>{r.sizing.preenlistment_total}</strong>
                                            </span>
                                            <span className="mr-3">
                                              Planned cap: <strong>{r.sizing.planned_capacity}</strong>
                                            </span>
                                            {r.sizing.deficit > 0 && <span className="text-red-600 mr-3">Deficit: {r.sizing.deficit}</span>}
                                            {r.sizing.suggest_additional > 0 && <span className="text-emerald-700">Suggest +{r.sizing.suggest_additional} section(s)</span>}
                                          </div>
                                        ) : null;

                                      const RoomSelect: React.FC<{ value?: string; onChange: (v: string) => void }> = ({
                                        value,
                                        onChange,
                                      }) => {
                                        const rooms = filterRoomsByCap(data?.room_options || []);
                                        return (
                                          <div className="relative w-full min-w-0">
                                            <select
                                              value={value ?? ""}
                                              onChange={(e) => onChange(e.target.value)}
                                              className="block w-full min-w-0 max-w-full appearance-none rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm leading-tight outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
                                            >
                                              {rooms.map((o) => (
                                                <option key={(o.room_id || "TBA") + o.room_number} value={o.room_id}>
                                                  {o.room_number}
                                                </option>
                                              ))}
                                            </select>
                                            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                                          </div>
                                        );
                                      };

                                      const viewRow = (
                                        <tr key={(r.section.section_id || r.course.course_id) + "-v"} className="hover:bg-neutral-50">
                                          <td className="px-3 py-2 border border-gray-300">{r.program_no}</td>
                                          <td className="px-3 py-2 border border-gray-300 align-top">
                                            <div className="font-semibold text-emerald-700 break-words">{r.course.course_code}</div>
                                            <div className="text-xs text-gray-500 leading-snug break-words whitespace-normal">
                                              {r.course.course_title}
                                            </div>
                                            {suggestion}
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
                                          <td className="px-3 py-2 border border-gray-300">
                                            {r.slot1?.room_number || r.slot1?.room_id || "—"}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot2?.day || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.start_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.end_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            {r.slot2?.room_number || r.slot2?.room_id || "—"}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">{r.section.enrollment_cap ?? "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.section.remarks || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            <div className="flex flex-wrap gap-2">
                                              {blockedByApproval ? (
                                                <button
                                                  onClick={() => setShowPlanModal(true)}
                                                  className={cls(
                                                    "rounded-md border px-2 py-1 text-xs font-medium",
                                                    "border-emerald-700 text-emerald-700 hover:bg-emerald-50"
                                                  )}
                                                >
                                                  Review plan
                                                </button>
                                              ) : (
                                                <>
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
                                                  {!blockedByApproval && (
                                                    <button
                                                      className="text-emerald-700 hover:text-emerald-900"
                                                      title="Add row (create section)"
                                                      onClick={() => {
                                                        setAddAnchorKey(rowKey);
                                                        setAddCourseCode("— Select a course —");
                                                        setAddDraft({
                                                          batch_id: r.batch.batch_id,
                                                          program_id: r.program.program_id,
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
                                                  )}
                                                </>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      );

                                      const editRow = (
                                        <tr key={r.section.section_id + "-e"} className="bg-emerald-50/40">
                                          <td className="px-3 py-2 border border-gray-300">{r.program_no}</td>
                                          <td className="px-3 py-2 border border-gray-300 align-top">
                                            <div className="font-semibold text-emerald-700 break-words">{r.course.course_code}</div>
                                            <div className="text-xs text-gray-500 leading-snug break-words whitespace-normal">
                                              {r.course.course_title}
                                            </div>
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            <input
                                              value={editing?.draft.section_code || ""}
                                              onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, section_code: e.target.value } })}
                                              className="w-full min-w-0 rounded-md border px-2 py-1 text-sm"
                                            />
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">{r.faculty.faculty_name || "UNASSIGNED"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot1?.day || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.start_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.end_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300 relative overflow-visible">
                                            <RoomSelect value={editing?.draft.slot1?.room_id || ""} onChange={(v) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot1: { room_id: v } } })} />
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot2?.day || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.start_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.end_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300 relative overflow-visible">
                                            <RoomSelect value={editing?.draft.slot2?.room_id || ""} onChange={(v) => setEditing((p) => p && { ...p, draft: { ...p.draft, slot2: { room_id: v } } })} />
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            <input
                                              value={editing?.draft.enrollment_cap ?? ""}
                                              onChange={(e) => {
                                                const v = e.target.value;
                                                setEditing((p) =>
                                                  p ? { ...p, draft: { ...p.draft, enrollment_cap: v === "" ? "" : Number(v) } } : p
                                                );
                                              }}
                                              placeholder="(blank to clear)"
                                              className="w-full min-w-0 rounded-md border px-2 py-1 text-sm"
                                            />
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            <input
                                              value={editing?.draft.remarks || ""}
                                              onChange={(e) => setEditing((p) => p && { ...p, draft: { ...p.draft, remarks: e.target.value } })}
                                              className="w-full min-w-0 rounded-md border px-2 py-1 text-sm"
                                            />
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            <div className="flex items-center gap-2">
                                              <button
                                                onClick={saveEdit}
                                                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                                                title="Save"
                                              >
                                                <Check className="h-4 w-4" strokeWidth={2.5} />
                                              </button>
                                              <button
                                                onClick={() => setEditing(null)}
                                                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                                                title="Cancel"
                                              >
                                                <X className="h-4 w-4" strokeWidth={2.5} />
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      );

                                      const addInline =
                                        addAnchorKey === rowKey && !blockedByApproval && (
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
                                                          setAddDraft((p: AddDraft) => ({
                                                            ...p,
                                                            batch_id: r.batch.batch_id,
                                                            program_id: r.program.program_id,
                                                            course_id: codeToId[v] || "",
                                                          }));
                                                        }}
                                                        options={codes}
                                                      />
                                                    </div>
                                                    <div className="text-xs text-neutral-600">{codeToTitle[addCourseCode] || "—"}</div>
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
                                              <select
                                                value={addDraft.slot1?.room_id || ""}
                                                onChange={(e) => setAddDraft((p) => ({ ...p, slot1: { room_id: e.target.value } }))}
                                                className="block w-full rounded-md border px-2 py-1 text-sm"
                                              >
                                                {filterRoomsByCap(data?.room_options || [], addDraft.enrollment_cap).map((o) => (
                                                  <option key={(o.room_id || "TBA") + o.room_number} value={o.room_id}>
                                                    {o.room_number}
                                                  </option>
                                                ))}
                                              </select>
                                            </td>
                                            <td className="px-3 py-2 border border-gray-300">—</td>
                                            <td className="px-3 py-2 border border-gray-300">—</td>
                                            <td className="px-3 py-2 border border-gray-300">—</td>
                                            <td className="px-3 py-2 border border-gray-300">
                                              <select
                                                value={addDraft.slot2?.room_id || ""}
                                                onChange={(e) => setAddDraft((p) => ({ ...p, slot2: { room_id: e.target.value } }))}
                                                className="block w-full rounded-md border px-2 py-1 text-sm"
                                              >
                                                {filterRoomsByCap(data?.room_options || [], addDraft.enrollment_cap).map((o) => (
                                                  <option key={(o.room_id || "TBA") + o.room_number} value={o.room_id}>
                                                    {o.room_number}
                                                  </option>
                                                ))}
                                              </select>
                                            </td>
                                            <td className="px-3 py-2 border border-gray-300">
                                              <input
                                                value={addDraft.enrollment_cap ?? 20}
                                                onChange={(e) => setAddDraft((p) => ({ ...p, enrollment_cap: Number(e.target.value || 0) }))}
                                                className="w-full min-w-0 rounded-md border px-2 py-1 text-sm"
                                              />
                                            </td>
                                            <td className="px-3 py-2 border border-gray-300">
                                              <input
                                                value={addDraft.remarks || ""}
                                                onChange={(e) => setAddDraft((p) => ({ ...p, remarks: e.target.value }))}
                                                className="w-full min-w-0 rounded-md border px-2 py-1 text-sm"
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
                                          {isEditing ? editRow : viewRow}
                                          {!blockedByApproval && addInline}
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
                ))
              )}
            </>
          )}

          {/* ------------------------------ Curriculum ----------------------------- */}
          {view === "curriculum" && (
            <div className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-hidden">
              <div className="bg-[#21C85A] text-white px-4 py-3 text-center font-semibold">
                {selectedBatchId
                  ? `ID ${(curr?.items || [])
                      .find((i) => i.batch_id === selectedBatchId)
                      ?.batch_code?.replace(/^ID\s*/i, "") || "—"}`
                  : "Curriculum"}
              </div>

              {/* column grid */}
              <div className="p-3 overflow-x-auto">
                <div
                  className="grid gap-4"
                  style={{
                    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                  }}
                >
                  {programOrder.map((pid) => {
                    const itm = columns[pid];
                    const programCode = itm?.program_code || "—";
                    const deptId = itm?.department_id || "";
                    const canAdd = !!selectedBatchId;
                    const opts = optionsByProgram[pid] || [];
                    const selectedId = currAddSel[pid] || "";

                    // Filter the available options to the program’s overall curriculum (codes only)
                    const allowedIds = eligibleCourseIdsByProgram[pid] || new Set<string>();
                    const filteredOpts = (opts || []).filter((o) => allowedIds.has(o.course_id));

                    // Build code <-> id maps
                    const codeOptions = filteredOpts.map((o) => o.course_code);
                    const codeToId: Record<string, string> = {};
                    const idToCode: Record<string, string> = {};
                    filteredOpts.forEach((o) => {
                      codeToId[o.course_code] = o.course_id;
                      idToCode[o.course_id] = o.course_code;
                    });

                    // SelectBox shows a label; we keep label as code
                    const selectedLabel = selectedId ? idToCode[selectedId] || "— Add course —" : "— Add course —";

                    const filteredCourses = (itm?.courses || []).filter((c) => {
                      if (!currSearch.trim()) return true;
                      const q = currSearch.toLowerCase();
                      return c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q);
                    });

                    return (
                      <div key={pid} className="rounded-lg border border-gray-200">
                        {/* header with add controls */}
                        <div className="flex items-center justify-between gap-2 border-b bg-gray-50 px-3 py-2">
                          <div className="font-semibold text-emerald-800 truncate" title={programCode}>
                            {programCode}
                          </div>

                          <div className="flex items-center gap-2 w-full max-w-full">
                            <div className="w-full min-w-0">
                              <SelectBox
                                value={selectedLabel}
                                onChange={(label: string) => {
                                  const cid = codeToId[label] || "";
                                  setCurrAddSel((p) => ({ ...p, [pid]: cid }));
                                }}
                                options={["— Add course —", ...codeOptions]}
                              />
                            </div>

                            <button
                              className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm"
                              disabled={!canAdd || !selectedId}
                              onClick={() => {
                                if (!selectedBatchId || !selectedId) return;
                                handleCurrAdd(pid, selectedBatchId, selectedId);
                              }}
                            >
                              <Plus className="h-4 w-4" />
                              Add
                            </button>

                            <button
                              className="inline-flex items-center gap-2 rounded-md border border-emerald-700 px-3 py-1.5 text-sm font-medium text-emerald-700"
                              onClick={() => {
                                if (!selectedBatchId) return;
                                const code = prompt("New course code:")?.trim();
                                const title = code ? prompt("Course title:")?.trim() : "";
                                const level = title ? prompt("Program level (Undergraduate or Graduate Studies):")?.trim() : "";
                                const unitsStr = level ? prompt("Units (number):")?.trim() : "";
                                const unitsNum = unitsStr ? Number(unitsStr) : undefined;
                                if (!code || !title || !level) return;
                                handleCurrAddCustom(pid, selectedBatchId, {
                                  course_code: normCode(code),
                                  course_title: title!,
                                  department_id: deptId,
                                  program_level: level!,
                                  units: isNaN(unitsNum as number) ? undefined : (unitsNum as number),
                                });
                              }}
                            >
                              <Plus className="h-4 w-4" />
                              Custom
                            </button>
                          </div>
                        </div>

                        {/* body: course cards */}
                        <div className="divide-y">
                          {filteredCourses.length === 0 && (
                            <div className="px-3 py-6 text-sm text-neutral-500 text-center">No courses.</div>
                          )}

                          {filteredCourses.map((c) => {
                            const units = typeof c.units === "number" ? c.units : null;

                            // replacement menu: codes only, filtered to allowedIds
                            const allowedForReplace = (opts || []).filter((o) => allowedIds.has(o.course_id));
                            const replaceCodes = allowedForReplace.map((o) => o.course_code);
                            const replaceCodeToId: Record<string, string> = {};
                            allowedForReplace.forEach((o) => (replaceCodeToId[o.course_code] = o.course_id));
                            const replacePlaceholder = "Edit…";

                            return (
                              <div key={c.course_id} className="px-3 py-2 bg-white">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="font-semibold text-emerald-700 break-words">{c.code}</div>
                                    <div className="text-[11px] text-neutral-600 truncate" title={c.title}>
                                      {c.title}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    <input
                                      type="number"
                                      step="0.5"
                                      defaultValue={units ?? ""}
                                      placeholder="units"
                                      className="h-9 w-16 rounded border px-2 text-sm text-center"
                                      onBlur={(e) => {
                                        if (!selectedBatchId) return;
                                        const v = e.currentTarget.value.trim();
                                        const num = v === "" ? null : Number(v);
                                        if (v === "" || !isNaN(num!)) {
                                          handleCurrEditUnits(pid, selectedBatchId, c.course_id, num);
                                        }
                                      }}
                                    />
                                    <button
                                      className="text-red-500 hover:text-red-700"
                                      title="Remove"
                                      onClick={() => selectedBatchId && handleCurrRemove(pid, selectedBatchId, c.course_id)}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  </div>
                                </div>

                                {/* replace via SelectBox (codes only, fits column) */}
                                <div className="mt-2 w-full min-w-0">
                                  <SelectBox
                                    value={replacePlaceholder}
                                    onChange={(label: string) => {
                                      if (label === replacePlaceholder) return;
                                      const newId = replaceCodeToId[label];
                                      if (!newId || !selectedBatchId) return;
                                      handleCurrReplace(pid, selectedBatchId, c.course_id, newId);
                                      // keep placeholder as value so it doesn't stretch layout
                                    }}
                                    options={[replacePlaceholder, ...replaceCodes]}
                                  />
                                </div>
                              </div>
                            );
                          })}

                          {/* footer: total units */}
                          <div className="px-3 py-2 bg-emerald-50">
                            <div className="flex items-center justify-between font-semibold text-emerald-800">
                              <span>Total</span>
                              <span>
                                {filteredCourses.reduce(
                                  (s, c) => s + (typeof c.units === "number" ? c.units : 0),
                                  0
                                )}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {/* ---------------------------- /Curriculum ---------------------------- */}
        </div>

        {/* Planning modal (offerings) */}
        {view === "offerings" && (
          <>
            {showPlanModal && (
              <div className="fixed inset-0 z-[95] grid place-items-center bg-black/40 p-4">
                <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-lg font-semibold text-emerald-700">Planning updates</h3>
                    <button onClick={() => setShowPlanModal(false)} className="rounded-full p-1 hover:bg-gray-100">
                      <X className="h-5 w-5 text-gray-600" />
                    </button>
                  </div>
                  <div className="max-h-[60vh] overflow-auto rounded border">
                    <table className="w-full text-sm table-fixed border-separate" style={{ borderSpacing: 0 }}>
                      <thead className="bg-gray-50 text-emerald-800 sticky top-0 z-10">
                        <tr className="text-[13px] font-semibold">
                          <th className="px-3 py-2 text-left border border-gray-300">Type</th>
                          <th className="px-3 py-2 text-left border border-gray-300">Course</th>
                          <th className="px-3 py-2 text-left border border-gray-300">Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data?.planning?.pending_changes || []).map((c, i) => (
                          <tr key={i} className="odd:bg-white even:bg-slate-50">
                            <td className="px-3 py-2 border border-gray-300">{c.type}</td>
                            <td className="px-3 py-2 border border-gray-300">{(c as any).course_id || "—"}</td>
                            <td className="px-3 py-2 border border-gray-300">
                              {"by_sections" in c && typeof (c as any).by_sections === "number"
                                ? `± ${(c as any).by_sections} section(s)`
                                : "by_capacity" in c && typeof (c as any).by_capacity === "number"
                                ? `± ${(c as any).by_capacity}`
                                : c.type === "add_course_to_curriculum"
                                ? (c as any).target
                                  ? `Add to ${(c as any).target.program_id} • ${(c as any).target.batch_id}`
                                  : "Not in curriculum"
                                : ""}
                            </td>
                          </tr>
                        ))}
                        {(data?.planning?.pending_changes || []).length === 0 && (
                          <tr>
                            <td className="px-3 py-2 border border-gray-300" colSpan={3}>
                              <div className="py-6 text-center text-sm opacity-70">No pending changes.</div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end gap-2 mt-5">
                    <button
                      onClick={() => setShowPlanModal(false)}
                      className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50"
                    >
                      Close
                    </button>
                    <button
                      onClick={async () => {
                        if (!user?.userId) return;
                        try {
                          await approveApoOfferingsPlan(user.userId);
                          setShowPlanModal(false);
                          await loadOfferings();
                        } catch (e: any) {
                          alert(e?.message || "Failed to apply plan.");
                        }
                      }}
                      className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
                    >
                      Approve &amp; Apply
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Forward modal */}
            <ForwardModal
              open={showForward}
              onClose={() => setShowForward(false)}
              termLabel={data?.term_label || curr?.term_label || ""}
              onSend={async (to, subject, msg) => {
                if (!user?.userId) return;
                const container = document.querySelector("[data-course-offerings]") as HTMLElement | null;
                if (!container) return;
                const clone = container.cloneNode(true) as HTMLElement;
                clone.querySelectorAll("button, svg, select, input, textarea").forEach((el) => el.remove());
                clone.querySelectorAll("th:last-child, td:last-child").forEach((el) => el.remove());
                await forwardApoCourseOfferings(user.userId, {
                  to,
                  subject,
                  message: msg,
                  attachment_html: clone.innerHTML,
                });
                alert("Sent to outbox.");
              }}
            />
          </>
        )}

        {/* Conflict modal (works for add/edit/delete) */}
        {!!conflict && (
          <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
            <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
                <h3 className="text-lg font-semibold text-emerald-800">This change conflicts with planning rules</h3>
              </div>
              <p className="text-sm text-neutral-600 mb-2">
                You can proceed anyway. Your confirmation and reason will be recorded.
              </p>
              <div className="border rounded-lg divide-y">
                <div className="p-3 bg-amber-50">
                  <div className="text-sm font-medium text-amber-800 mb-1">Conflicts</div>
                  <ul className="list-disc pl-5 text-sm text-amber-900 space-y-1">
                    {conflict.violations.map((v, i) => (
                      <li key={i}>
                        <span className="font-semibold">{v.code}</span>: {v.message}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="p-3">
                  <div className="text-xs text-neutral-500 mb-1">Preview</div>
                  <pre className="text-xs bg-neutral-50 p-2 rounded border overflow-auto max-h-40">
                    {JSON.stringify(conflict.preview, null, 2)}
                  </pre>
                </div>
                <div className="p-3">
                  <label className="block text-sm font-medium mb-1">Override reason</label>
                  <input
                    value={conflict.reason}
                    onChange={(e) => setConflict((c) => (c ? { ...c, reason: e.target.value } : c))}
                    placeholder="Why proceed despite conflicts?"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5">
                <button
                  onClick={() => setConflict(null)}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (!conflict || !user?.userId) return;
                    const base = conflict.original as any;
                    const overridePayload = {
                      ...base,
                      override: true,
                      override_token: conflict.token,
                      override_reason: conflict.reason || "",
                    };
                    let res: any;
                    if (conflict.action === "add") {
                      res = await addApoOfferingRow(user.userId, overridePayload);
                    } else if (conflict.action === "edit") {
                      if (!overridePayload.course_id && editing?.row?.course?.course_id) {
                        overridePayload.course_id = editing.row.course.course_id;
                      }
                      res = await editApoOfferingRow(user.userId, overridePayload);
                    } else {
                      res = await deleteApoOfferingRow(user.userId, overridePayload);
                    }
                    if ("conflict" in res) {
                      setConflict({
                        ...conflict,
                        token: res.conflict.override_token,
                        violations: res.conflict.violations,
                        preview: res.conflict.preview_changes,
                        reason: conflict.reason,
                      });
                      return;
                    }
                    setConflict(null);
                    await loadOfferings();
                  }}
                  disabled={!conflict.reason.trim()}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-60"
                >
                  Proceed anyway
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ------------ Small Forward Modal (Offerings only) ------------ */
const ForwardModal: React.FC<{
  open: boolean;
  onClose: () => void;
  termLabel: string;
  onSend: (to: string, subject: string, message: string) => Promise<void>;
}> = ({ open, onClose, termLabel, onSend }) => {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("Forwarding Course Offerings for Approval");
  const [msg, setMsg] = useState("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-emerald-700">Forward Course Offerings</h3>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-gray-100">
            <X className="h-5 w-5 text-gray-600" />
          </button>
        </div>
        <div className="border border-gray-200 bg-gray-50 p-3 rounded-lg text-sm flex items-center justify-between mb-4">
          <span>
            📎 Attached: <strong>Course_Offerings_{termLabel}.html</strong>
          </span>
          <span className="text-xs text-neutral-600">Preview is generated from the table</span>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium">To:</label>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              type="email"
              placeholder="Recipient email"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Subject:</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Message:</label>
            <textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              className="h-40 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={async () => {
              await onSend(to, subject, msg);
              onClose();
            }}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};
