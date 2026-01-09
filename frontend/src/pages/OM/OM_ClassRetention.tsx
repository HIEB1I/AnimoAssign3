import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Search, Plus, Check, X, Trash2, Edit } from "lucide-react";
import { cls } from "../../utilities/cls";
import SelectBox from "../../component/SelectBox";
import {
  getOMCR_Options,
  listOMCR,
  saveOMCR,
  deleteOMCR,
  getOMCR_CourseOptions,
  getOMCR_SectionOptions,
  type OMCRRow,
  type OMCROptions,
  type OMCRCourseOpt,
  type OMCRSectionOpt,
} from "../../api";

type ExtraActionsRender = (ctx: { rows: OMCRRow[]; loading: boolean }) => ReactNode;


const SOFT_INPUT =
  "w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm shadow-sm " +
  "focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300";

function Pill({ text }: { text?: string }) {
  const map: Record<string, string> = {
    Approved: "bg-green-100 text-green-700",
    "Under Review": "bg-yellow-100 text-yellow-700",
    Dissolved: "bg-red-100 text-red-700",
    "Special Class": "bg-blue-100 text-blue-700",
  };
  return (
    <span className={cls("inline-block rounded-full px-3 py-1 text-xs font-semibold", map[text || ""] || "bg-gray-100 text-gray-600")}>
      {text || "—"}
    </span>
  );
}

const toNumOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

export default function OM_ClassRetention(
  { renderExtraActions }: { renderExtraActions?: ExtraActionsRender } = {}
) {

  const [activeTermId, setActiveTermId] = useState<string>("");
  const [activeTermLabel, setActiveTermLabel] = useState<string>("");

  // filters
  const [statuses, setStatuses] = useState<string[]>(["All Status"]);
  const [status, setStatus] = useState("All Status");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // table
  const [rows, setRows] = useState<OMCRRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // add/edit state
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<OMCRRow>>({});

  // course/section dropdown options + label->id maps
  const [courseOpts, setCourseOpts] = useState<OMCRCourseOpt[]>([]);
  const [courseLabels, setCourseLabels] = useState<string[]>([]);
  const [courseLabelToId, setCourseLabelToId] = useState<Record<string,string>>({});
  const [sectionOpts, setSectionOpts] = useState<OMCRSectionOpt[]>([]);
  const [sectionLabels, setSectionLabels] = useState<string[]>([]);
  const [sectionLabelToId, setSectionLabelToId] = useState<Record<string,string>>({});

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // initial page options
  useEffect(() => {
    (async () => {
      try {
        const opt: OMCROptions = await getOMCR_Options();
        if (!opt.ok) throw new Error("Failed to load options");
        setStatuses(["All Status", ...(opt.statuses || [])]);
        setActiveTermLabel(opt.activeTermLabel || "");
        setActiveTermId(opt.activeTerm?.term_id || "");

        // preload course options for active term
        const c = await getOMCR_CourseOptions(opt.activeTerm?.term_id);
        const labels = (c.options || []).map(o => `${o.course_code}`);
        const map: Record<string,string> = {};
        (c.options || []).forEach(o => (map[`${o.course_code}`] = o.course_id));
        setCourseOpts(c.options || []);
        setCourseLabels(labels);
        setCourseLabelToId(map);
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);

  // fetch rows
  const load = async () => {
    try {
      setLoading(true);
      setErr("");
      const { ok, rows } = await listOMCR({ status, q: debouncedSearch });
      if (!ok) throw new Error("Failed to load");
      setRows(rows);
    } catch (e: any) {
      setRows([]);
      setErr(e?.response?.data?.detail || e?.message || "Failed to load class retention.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [status, debouncedSearch]);

  const headerLabel = useMemo(
    () => (activeTermLabel ? `Manage low-enrollment sections for ${activeTermLabel}` : "Manage low-enrollment sections"),
    [activeTermLabel]
  );

  // helpers to (re)load section options given the chosen course (includes faculty info)
  const refreshSections = async (course_id: string) => {
    if (!course_id) {
      setSectionOpts([]); setSectionLabels([]); setSectionLabelToId({});
      return;
    }
    const s = await getOMCR_SectionOptions(course_id, activeTermId);
    const labels = (s.options || []).map(o => o.section_code);
    const map: Record<string,string> = {};
    (s.options || []).forEach(o => (map[o.section_code] = o.section_id));
    setSectionOpts(s.options || []);
    setSectionLabels(labels);
    setSectionLabelToId(map);
  };

  // Add / Edit
  const startAdd = () => {
    setAdding(true);
    setEditingId(null);
    setDraft({ term_id: activeTermId, status: "Under Review", student_units: 0, faculty_units: 0 });
    // clear section opts initially
    setSectionOpts([]); setSectionLabels([]); setSectionLabelToId({});
  };
  const cancelAdd = () => { setAdding(false); setDraft({}); };

  const startEdit = async (row: OMCRRow) => {
    setEditingId(row.retention_id);
    setAdding(false);
    setDraft({ ...row, term_id: row.term_id || activeTermId });
    await refreshSections(row.course_id);
  };
  const cancelEdit = () => { setEditingId(null); setDraft({}); };

  const saveDraft = async () => {
    try {
      setLoading(true);
      setErr("");
      const payload: Partial<OMCRRow> = {
        retention_id: draft.retention_id,
        term_id: draft.term_id || activeTermId,
        course_id: draft.course_id!,
        section_id: draft.section_id!,
        student_units: draft.student_units ?? null,
        faculty_units: draft.faculty_units ?? null,
        status: draft.status,
        enrolled: draft.enrolled ?? null,
        // faculty_id is auto-derived on backend
      };
      await saveOMCR(payload);
      setAdding(false);
      setEditingId(null);
      setDraft({});
      await load();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Save failed.");
    } finally {
      setLoading(false);
    }
  };

  const del = async (retention_id: string) => {
    if (!confirm("Delete this retention row?")) return;
    try {
      setLoading(true);
      setErr("");
      await deleteOMCR(retention_id);
      await load();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Delete failed.");
    } finally {
      setLoading(false);
    }
  };

  const facultyNameForDraftSection = () => {
    if (!draft.section_id) return "UNASSIGNED";
    const sec = sectionOpts.find(s => s.section_id === draft.section_id);
    return sec?.faculty_name || "UNASSIGNED";
    // value is calculated from faculty_assignments on the server
  };

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-4">
        <h1 className="text-2xl font-bold">Class Retention</h1>
        <p className="text-sm text-gray-600">{headerLabel}</p>
      </header>

      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

      {/* Filter row: single line (Search + Status) */}
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="relative flex-1 min-w-[300px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by course code or title…"
            className={cls(SOFT_INPUT, "pl-9")}
          />
        </div>

              <SelectBox value={status} onChange={setStatus} options={statuses} />

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={startAdd}
            className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110"
          >
            <Plus className="h-4 w-4" />
            Add Class
          </button>

          {renderExtraActions?.({ rows, loading })}
        </div>

      </div>

      {/* Table */}
      <div className="overflow-visible rounded-xl border border-gray-200 bg-gray-50 shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-gray-50 text-gray-700">
            <tr>
              <th className="px-4 py-2 text-left">Course Code & Title</th>
              <th className="px-4 py-2 text-center">Section</th>
              <th className="px-4 py-2 text-center">Student Units</th>
              <th className="px-4 py-2 text-center">Faculty Units</th>
              <th className="px-4 py-2 text-center">Enrolled</th>
              <th className="px-4 py-2 text-left">Faculty</th>
              <th className="px-4 py-2 text-center">Status</th>
              <th className="px-4 py-2 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {/* Add row — dropdowns */}
            {adding && (
              <tr className="bg-white">
                <td className="px-4 py-3">
                  <SelectBox
                    value={
                      draft.course_id
                        ? (courseOpts.find(o => o.course_id === draft.course_id)?.course_code || "")
                        : ""
                    }
                    onChange={async (label) => {
                      const cid = courseLabelToId[label] || "";
                      setDraft(d => ({ ...d, course_id: cid, section_id: undefined }));
                      await refreshSections(cid);
                    }}
                    options={courseLabels}
                  />
                  <div className="mt-1 text-xs text-gray-500">
                    {draft.course_id ? (courseOpts.find(o => o.course_id === draft.course_id)?.course_title || " ") : " "}
                  </div>
                </td>

                <td className="px-4 py-3 text-center">
                  <SelectBox
                    value={
                      draft.section_id
                        ? (sectionOpts.find(s => s.section_id === draft.section_id)?.section_code || "")
                        : ""
                    }
                    onChange={(label) => {
                      const sid = sectionLabelToId[label] || "";
                      setDraft(d => ({ ...d, section_id: sid }));
                    }}
                    options={sectionLabels}
                  />
                </td>

                <td className="px-4 py-3 text-center">
                  <input
                    type="number"
                    value={draft.student_units ?? 0}
                    onChange={(e) => setDraft((d) => ({ ...d, student_units: toNumOrNull(e.target.value) }))}
                    className={cls(SOFT_INPUT, "w-24 text-center")}
                  />
                </td>

                <td className="px-4 py-3 text-center">
                  <input
                    type="number"
                    value={draft.faculty_units ?? 0}
                    onChange={(e) => setDraft((d) => ({ ...d, faculty_units: toNumOrNull(e.target.value) }))}
                    className={cls(SOFT_INPUT, "w-24 text-center")}
                  />
                </td>

                <td className="px-4 py-3 text-center">
                  <input
                    type="number"
                    value={draft.enrolled ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, enrolled: toNumOrNull(e.target.value) }))}
                    className={cls(SOFT_INPUT, "w-24 text-center")}
                  />
                </td>

                {/* Faculty is auto-derived; show read-only */}
                <td className="px-4 py-3 text-left">
                  <div className="font-medium">{facultyNameForDraftSection()}</div>
                  <div className="text-xs text-gray-500">
                    {draft.section_id ? "Derived from faculty assignments" : "Select a section to resolve faculty"}
                  </div>
                </td>

                <td className="px-4 py-3 text-center">
                  <SelectBox
                    value={draft.status || "Under Review"}
                    onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                    options={statuses.filter((s) => s !== "All Status")}
                  />
                </td>

                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={saveDraft}
                      className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                      title="Save"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={cancelAdd}
                      className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-400 text-red-600 hover:bg-red-50"
                      title="Cancel"
                    >
                      <X className="h-4 w-4" strokeWidth={2.5} />
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {/* Data rows */}
            {loading ? (
              <tr><td className="px-4 py-6 text-center text-gray-500" colSpan={9}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td className="px-4 py-6 text-center text-gray-500" colSpan={9}>No results</td></tr>
            ) : (
              rows.map((r) => {
                const editing = editingId === r.retention_id;
                const currentCourse = courseOpts.find(o => o.course_id === (draft.course_id || r.course_id));
                const currentCourseLabel = currentCourse ? `${currentCourse.course_code}` : "";

                const currentDraftFacultyName = (() => {
                  if (!editing) return r.faculty_name || "UNASSIGNED";
                  if (draft.section_id) {
                    const sec = sectionOpts.find(s => s.section_id === draft.section_id);
                    return sec?.faculty_name || "UNASSIGNED";
                  }
                  return r.faculty_name || "UNASSIGNED";
                })();

                return (
                  <tr key={r.retention_id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                      {editing ? (
                        <SelectBox
                          value={currentCourseLabel}
                          onChange={async (label) => {
                            const cid = courseLabelToId[label] || "";
                            setDraft(d => ({ ...d, course_id: cid, section_id: undefined }));
                            await refreshSections(cid);
                          }}
                          options={courseLabels}
                        />
                      ) : (
                        <>
                          {r.course_code || "—"}
                          <div className="text-xs text-gray-500">{r.course_title || " "}</div>
                        </>
                      )}
                    </td>

                    <td className="px-4 py-3 text-center">
                      {editing ? (
                        <SelectBox
                          value={
                            draft.section_id
                              ? (sectionOpts.find(s => s.section_id === draft.section_id)?.section_code || "")
                              : (r.section_code || "")
                          }
                          onChange={(label) => {
                            const sid = sectionLabelToId[label] || "";
                            setDraft(d => ({ ...d, section_id: sid }));
                          }}
                          options={sectionLabels}
                        />
                      ) : (
                        r.section_code || "—"
                      )}
                    </td>

                    <td className="px-4 py-3 text-center">
                      {editing ? (
                        <input
                          type="number"
                          value={draft.student_units ?? r.student_units ?? 0}
                          onChange={(e) => setDraft((d) => ({ ...d, student_units: toNumOrNull(e.target.value) }))}
                          className={cls(SOFT_INPUT, "w-24 text-center")}
                        />
                      ) : (
                        r.student_units ?? "—"
                      )}
                    </td>

                    <td className="px-4 py-3 text-center">
                      {editing ? (
                        <input
                          type="number"
                          value={draft.faculty_units ?? r.faculty_units ?? 0}
                          onChange={(e) => setDraft((d) => ({ ...d, faculty_units: toNumOrNull(e.target.value) }))}
                          className={cls(SOFT_INPUT, "w-24 text-center")}
                        />
                      ) : (
                        r.faculty_units ?? "—"
                      )}
                    </td>

                    <td className="px-4 py-3 text-center">
                      {editing ? (
                        <input
                          type="number"
                          value={draft.enrolled ?? r.enrolled ?? 0}
                          onChange={(e) => setDraft((d) => ({ ...d, enrolled: toNumOrNull(e.target.value) }))}
                          className={cls(SOFT_INPUT, "w-24 text-center")}
                        />
                      ) : (
                        (r.enrolled ?? "—")
                      )}
                    </td>

                    {/* Faculty: read-only, derived */}
                    <td className="px-4 py-3 text-left">
                      <span className="font-medium">{currentDraftFacultyName}</span>
                      <div className="text-xs text-gray-500"> </div>
                    </td>

                    <td className="px-4 py-3 text-center">
                      {editing ? (
                        <SelectBox
                          value={draft.status || r.status || "Under Review"}
                          onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                          options={statuses.filter((s) => s !== "All Status")}
                        />
                      ) : (
                        <Pill text={r.status} />
                      )}
                    </td>

                    <td className="px-4 py-3">
                      {editing ? (
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={saveDraft}
                            className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                            title="Save"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-400 text-red-600 hover:bg-red-50"
                            title="Cancel"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => startEdit(r)}
                            className="text-emerald-700 hover:brightness-110"
                            title="Edit"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => del(r.retention_id)}
                            className="text-red-600 hover:brightness-110"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
