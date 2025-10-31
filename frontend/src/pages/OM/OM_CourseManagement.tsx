import { useEffect, useMemo, useState } from "react";
import SelectBox from "../../component/SelectBox";
import { Search as SearchIcon, MoreVertical, FileText } from "lucide-react";
import {
  getCMOptions,
  listCMCourses,
  type CMOptions,
  type CMCourseRow,
} from "../../api";

function RowActions({ onView }: { onView: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-full p-2 hover:bg-gray-100 text-gray-700">
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-48 rounded-xl border border-gray-200 bg-white shadow-xl py-1 z-50">
          <button
            onClick={() => { setOpen(false); onView(); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <FileText className="h-4 w-4" /> <span>View Syllabus</span>
          </button>
        </div>
      )}
    </div>
  );
}

const isDrive = (u?: string) => !!u && /(?:drive|docs)\.google\.com/i.test(u);
const toPreview = (u: string) =>
  u.includes("/view") ? u.replace("/view", "/preview")
  : u.includes("?usp=sharing") ? u.replace("?usp=sharing", "/preview")
  : u;

export default function OM_CourseManagement() {
  const session = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("animo.user") || "null"); } catch { return null; }
  }, []);
  const userEmail = session?.email || session?.userEmail;
  const userId = session?.userId;

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

  useEffect(() => {
    (async () => {
      try {
        const opt: CMOptions = await getCMOptions(userEmail, userId);
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

  useEffect(() => {
    (async () => {
      try {
        setLoading(true); setErr("");
        const { ok, rows } = await listCMCourses({ userEmail, userId, cluster, search });
        if (!ok) throw new Error("Failed to load courses.");
        setRows(rows);
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load courses.");
      } finally {
        setLoading(false);
      }
    })();
  }, [userEmail, userId, cluster, search]);

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
        <div className="relative flex-1 min-w-[240px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by course code, title, or coordinator…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
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
              rows.map((r) => (
                <tr key={r.course_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">{r.kac || "—"}</td>

                  <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                    {r.code || "—"}
                    <div className="text-xs text-gray-500">{r.title || "—"}</div>
                  </td>

                  <td className="px-4 py-3 text-center">{r.units ?? "—"}</td>

                  <td className="px-4 py-3">
                    {(r.coordinators && r.coordinators.length > 0) ? (
                      r.coordinators.map((c, i) => (
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
                      ? r.composition.map((n, i) => <div key={i}>{n}</div>)
                      : <span className="text-gray-500">—</span>}
                  </td>

                  <td className="px-4 py-3 text-center">
                    <RowActions
                      onView={() => {
                        setSyllabusUrl(r.syllabus || "");
                        setShowSyllabus(true);
                      }}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
    </main>
  );
}
