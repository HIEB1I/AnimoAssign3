import { useEffect, useMemo, useState } from "react";
import SelectBox from "../../component/SelectBox";
import { Search as SearchIcon, MoreVertical, FileText, Edit3, Plus, X } from "lucide-react";
import {
  type CMOptions,
  type CMCourseRow,
  getChairCMOptions,
  listChairCMCourses,
  updateChairCoursePeople,
} from "../../api";

/* ---------- small helpers ---------- */
const isDrive = (u?: string) => !!u && /(?:drive|docs)\.google\.com/i.test(u || "");
const toPreview = (u: string) =>
  u.includes("/view") ? u.replace("/view", "/preview")
  : u.includes("?usp=sharing") ? u.replace("?usp=sharing", "/preview")
  : u;

function splitName(full: string): { first_name: string; last_name: string } {
  const s = String(full || "").trim().replace(/\s+/g, " ");
  if (!s) return { first_name: "", last_name: "" };
  const parts = s.split(" ");
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  const first = parts[0];
  const last = parts.slice(1).join(" ");
  return { first_name: first, last_name: last };
}

/* ---------- Row actions ---------- */
function RowActions({ onView, onEdit }: { onView: () => void; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-full p-2 hover:bg-gray-100 text-gray-700"
        aria-label="Row actions"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div
          className="absolute right-0 mt-2 w-48 rounded-xl border border-gray-200 bg-white shadow-xl py-1 z-50"
          onMouseLeave={() => setOpen(false)}
        >
          <button
            onClick={() => { setOpen(false); onView(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <FileText className="h-4 w-4" /> <span>View Syllabus</span>
          </button>
          <button
            onClick={() => { setOpen(false); onEdit(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Edit3 className="h-4 w-4" /> <span>Edit People</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Edit modal ---------- */
type NamePair = { first_name: string; last_name: string };

function EditPeopleModal({
  open, onClose, course, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  course: CMCourseRow | null;
  onSaved: (patch: Partial<CMCourseRow>) => void;
}) {
  const session = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("animo.user") || "null"); } catch { return null; }
  }, []);
  const userEmail: string | undefined = session?.email || session?.userEmail;
  const userId: string | undefined = session?.userId;

  const [coordinators, setCoordinators] = useState<NamePair[]>([]);
  const [team, setTeam] = useState<NamePair[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    if (!open || !course) return;
    // Prefill coordinators from row.coordinators (preferred) or coordinator_name fallback
    const initCoords: NamePair[] =
      (Array.isArray(course.coordinators) && course.coordinators.length
        ? course.coordinators.map((c: { name?: string }) => splitName(c?.name || ""))
        : (course.coordinator_name ? course.coordinator_name.split(/\s*;\s*/).map((n: string) => splitName(n)) : [])
      ).filter((x: NamePair) => x.first_name || x.last_name);

    // Prefill team from composition (best-effort; user can edit)
    const initTeam: NamePair[] =
      (Array.isArray(course.composition) ? course.composition : [])
        .map((n: string) => splitName(String(n || "")))
        .filter((x: NamePair) => x.first_name || x.last_name);

    setCoordinators(initCoords.length ? initCoords : [{ first_name: "", last_name: "" }]);
    setTeam(initTeam);
    setErr("");
  }, [open, course]);

  function updateItem(list: NamePair[], i: number, key: keyof NamePair, val: string) {
    const next = list.slice();
    next[i] = { ...next[i], [key]: val };
    return next;
  }

  async function save() {
    if (!course) return;
    setSaving(true); setErr("");
    try {
      const payload = {
        coordinators: coordinators
          .map((n) => ({ first_name: (n.first_name || "").trim(), last_name: (n.last_name || "").trim() }))
          .filter((n) => n.first_name || n.last_name),
        teaching_team: team
          .map((n) => ({ first_name: (n.first_name || "").trim(), last_name: (n.last_name || "").trim() }))
          .filter((n) => n.first_name || n.last_name),
        userId, userEmail,
      };
      const res = await updateChairCoursePeople(course.course_id, payload);
      if (!res?.ok) throw new Error(res?.message || "Update failed.");

      // Patch UI: coordinators + composition
      onSaved({
        coordinators: (res.coordinators || []).map((c: { name: string; email?: string }) => ({ name: c.name, email: c.email })),
        coordinator_name: (res.coordinators || []).map((c: { name: string }) => c.name).join("; "),
        coordinator_email: (res.coordinators?.[0]?.email || ""),
        composition: (res.teaching_team || []).map((t: { name: string }) => t.name),
      });
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  if (!open || !course) return null;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-emerald-700">Edit People</h2>
            <p className="text-xs text-gray-500 mt-1">
              {course.code || "—"} <span className="text-gray-400">•</span> {course.title || "—"}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {err && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        {/* Coordinators */}
        <div className="mt-5">
          <h3 className="font-medium text-gray-800">Course Coordinator(s)</h3>
          <p className="text-xs text-gray-500 mb-2">Edit first/last names. Email will auto-match the user profile.</p>
          <div className="space-y-2">
            {coordinators.map((c: NamePair, i: number) => (
              <div key={`coord-${i}`} className="grid grid-cols-2 gap-2">
                <input
                  value={c.first_name}
                  onChange={(e) => setCoordinators(updateItem(coordinators, i, "first_name", e.target.value))}
                  placeholder="First name"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <input
                    value={c.last_name}
                    onChange={(e) => setCoordinators(updateItem(coordinators, i, "last_name", e.target.value))}
                    placeholder="Last name"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  {coordinators.length > 1 && (
                    <button
                      className="shrink-0 px-3 rounded-lg border text-sm hover:bg-gray-50"
                      onClick={() => setCoordinators(coordinators.filter((_, k) => k !== i))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button
            className="mt-2 inline-flex items-center gap-1 text-sm text-emerald-700 hover:underline"
            onClick={() => setCoordinators([...coordinators, { first_name: "", last_name: "" }])}
          >
            <Plus className="h-4 w-4" /> Add coordinator
          </button>
        </div>

        {/* Teaching Team */}
        <div className="mt-6">
          <h3 className="font-medium text-gray-800">Teaching Composition</h3>
          <p className="text-xs text-gray-500 mb-2">Edit/add multiple by first/last names.</p>
          <div className="space-y-2">
            {team.map((m: NamePair, i: number) => (
              <div key={`team-${i}`} className="grid grid-cols-2 gap-2">
                <input
                  value={m.first_name}
                  onChange={(e) => setTeam(updateItem(team, i, "first_name", e.target.value))}
                  placeholder="First name"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <input
                    value={m.last_name}
                    onChange={(e) => setTeam(updateItem(team, i, "last_name", e.target.value))}
                    placeholder="Last name"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button
                    className="shrink-0 px-3 rounded-lg border text-sm hover:bg-gray-50"
                    onClick={() => setTeam(team.filter((_, k) => k !== i))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            className="mt-2 inline-flex items-center gap-1 text-sm text-emerald-700 hover:underline"
            onClick={() => setTeam([...team, { first_name: "", last_name: "" }])}
          >
            <Plus className="h-4 w-4" /> Add member
          </button>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 text-sm disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Page ---------- */
export default function CHAIR_CourseManagement() {
  const session = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("animo.user") || "null"); } catch { return null; }
  }, []);
  const userEmail: string | undefined = session?.email || session?.userEmail;
  const userId: string | undefined = session?.userId;

  const [clusters, setClusters] = useState<string[]>(["All Clusters"]);
  const [cluster, setCluster] = useState("All Clusters");
  const [termLabel, setTermLabel] = useState("");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [rows, setRows] = useState<CMCourseRow[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const [syllabusUrl, setSyllabusUrl] = useState<string>("");
  const [showSyllabus, setShowSyllabus] = useState(false);

  // edit modal state
  const [editOpen, setEditOpen] = useState(false);
  const [editCourse, setEditCourse] = useState<CMCourseRow | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const opt: CMOptions = await getChairCMOptions(userEmail, userId);
        setClusters(["All Clusters", ...(opt.clusters || [])]);
        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setTermLabel(ay ? `AY ${ay}-${ay + 1} · Term ${tn ?? "—"}` : "");
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, [userEmail, userId]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  async function refresh() {
    try {
      setLoading(true); setErr("");
      const { ok, rows } = await listChairCMCourses({ userEmail, userId, cluster, search });
      if (!ok) throw new Error("Failed to load courses.");
      setRows(rows);
    } catch (e: any) {
      setRows([]);
      setErr(e?.response?.data?.detail || e?.message || "Failed to load courses.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, [userEmail, userId, cluster, search]);

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Course Management</h1>
        <p className="text-sm text-gray-600">
          Department offerings, coordinators, and syllabi {termLabel && `(${termLabel})`}
        </p>
      </header>

      {err && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
        {/* Search with clear (×) button */}
        <div className="relative flex-1 min-w-[240px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by course code, title, or coordinator…"
            className="w-full rounded-lg border border-gray-300 pl-9 pr-8 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {searchInput && (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-gray-100 text-gray-500"
              onClick={() => { setSearchInput(""); setSearch(""); }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <SelectBox value={cluster} onChange={setCluster} options={clusters} />
      </div>

      <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible rounded-xl">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Knowledge Area Cluster</th>
              <th className="text-left px-4 py-2">Course Code & Title</th>
              <th className="text-center px-4 py-2">Units</th>
              <th className="text-left px-4 py-2">Course Coordinator(s)</th>
              <th className="text-left px-4 py-2">Teaching Composition</th>
              <th className="text-center px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No results</td></tr>
            ) : (
              rows.map((r: CMCourseRow) => (
                <tr key={r.course_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">{r.kac || "—"}</td>

                  <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                    {r.code || "—"}
                    <div className="text-xs text-gray-500">{r.title || "—"}</div>
                  </td>

                  <td className="px-4 py-3 text-center">{r.units ?? "—"}</td>

                  <td className="px-4 py-3">
                    {(r.coordinators && r.coordinators.length > 0) ? (
                      r.coordinators.map((c: { name?: string; email?: string }, i: number) => (
                        <div key={i} className="text-sm">
                          <div className="text-gray-900">{c.name || "—"}</div>
                          {c.email && <div className="text-xs text-gray-500">{c.email}</div>}
                        </div>
                      ))
                    ) : (
                      <>
                        {r.coordinator_name || "—"}
                        {r.coordinator_email && (
                          <div className="text-xs text-gray-500">{r.coordinator_email}</div>
                        )}
                      </>
                    )}
                  </td>

                  <td className="px-4 py-3">
                    {Array.isArray(r.composition) && r.composition.length
                      ? r.composition.map((n: string, i: number) => <div key={i}>{n}</div>)
                      : <span className="text-gray-500">—</span>}
                  </td>

                  <td className="px-4 py-3 text-center">
                    <RowActions
                      onView={() => {
                        setSyllabusUrl(r.syllabus || "");
                        setShowSyllabus(true);
                      }}
                      onEdit={() => {
                        setEditCourse(r);
                        setEditOpen(true);
                      }}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Syllabus modal */}
      {showSyllabus && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
            <h2 className="text-lg font-semibold text-emerald-700 mb-4">Syllabus</h2>
            {!syllabusUrl ? (
              <p className="text-gray-500 italic">No syllabus link provided.</p>
            ) : (
              <>
                <p className="mb-3">
                  Syllabus Link:
                  <a href={syllabusUrl} target="_blank" rel="noopener noreferrer" className="text-emerald-700 underline ml-2">
                    Open in New Tab
                  </a>
                </p>
                {isDrive(syllabusUrl) && (
                  <iframe className="w-full h-[500px] border rounded-xl" title="Syllabus" src={toPreview(syllabusUrl)} />
                )}
              </>
            )}
            <div className="flex justify-end mt-6">
              <button onClick={() => setShowSyllabus(false)} className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      <EditPeopleModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        course={editCourse}
        onSaved={(patch) => {
          if (!editCourse) return;
          setRows(prev => prev.map((r) => r.course_id === editCourse.course_id ? { ...r, ...patch } : r));
        }}
      />
    </main>
  );
}
