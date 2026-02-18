// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_LoadRisk.tsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, Search as SearchIcon, X } from "lucide-react";
import SelectBox from "../../../component/SelectBox";

type DepartmentItem = { department_id: string; department_name: string };

type Candidate = {
  faculty_id: string;
  name: string;
  standard_units?: number;
  deload_units?: number;
  effective_units?: number;
  sections_can_cover?: number | null;
};

type Row = {
  course_id: string;
  course: string;
  course_title?: string;
  baseline_demand_sections: number;
  ft_can_cover_sections_est: number;
  risk: "RISK" | "WARNING" | "SAFE";
  uncovered_sections: number;
  flags: string[];
  reasons: string[];
  ft_candidates: Candidate[];
  pt_suggestions: Candidate[];
  history: {
    baseline_term_id: string;
    baseline_relay_on_pt: boolean;
    baseline_needed_overload: boolean;
  };
  confidence: number;
  ft_breakdown?: SectionBreakdown[];
  suggested_action?: SuggestedAction | null;
};

type CoverageResponse = {
  department_id: string;
  dept_name: string;
  target: { term_id: string; acad_year_start: number; term_number: number };
  baseline: { term_id: string; acad_year_start: number; term_number: number };
  summary: {
    risk: number;
    warning: number;
    safe: number;
    avg_confidence: number;
  };
  rows: Row[];
  generated_at: string;
};

type SectionBreakdown = {
  section_id: string;
  section_code: string;

  faculty_id?: string | null;
  faculty_name?: string | null;
  baseline_employment_type?: "FT" | "PT" | null;

  status: "AVAILABLE" | "UNAVAILABLE";
  reasons: string[];

  on_leave?: boolean;
  is_active?: boolean;
  active_check_terms?: string[];
  active_hit_term_id?: string | null;

  capacity_units?: number | null;
  deload_units?: number | null;
  effective_units?: number | null;
  now_sections_capacity?: number | null;

  sections_can_cover?: number | null; // 0/1 per section
};

type SuggestedAction = {
  pt_needed: number;
  pt_taught_last_year: { faculty_id: string; name: string; sections: number }[];
  overload_candidates: {
    faculty_id: string;
    name: string;
    baseline_sections: number;
    now_sections_capacity: number;
  }[];
};

const cls = (...s: Array<string | false | undefined>) =>
  s.filter(Boolean).join(" ");

function StatusBadge({ v }: { v: Row["risk"] }) {
  const base =
    "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold";
  if (v === "RISK")
    return (
      <span className={cls(base, "border-rose-200 bg-rose-50 text-rose-800")}>
        RISK
      </span>
    );
  if (v === "WARNING")
    return (
      <span
        className={cls(base, "border-amber-200 bg-amber-50 text-amber-800")}
      >
        WARNING
      </span>
    );
  return (
    <span
      className={cls(base, "border-emerald-200 bg-emerald-50 text-emerald-800")}
    >
      SAFE
    </span>
  );
}

type Tab = "RISK" | "WARNING" | "SAFE";

export default function OM_RP_LoadRisk() {
  const PAGE_SIZE = 15;
  const [page, setPage] = useState(1);

  const [departmentId, setDepartmentId] = useState("DEPT0001");
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [tab, setTab] = useState<Tab>("RISK");
  const [q, setQ] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"DETAILS" | "HISTORY" | "ACTIONS">(
    "DETAILS"
  );

  const deptOptions = useMemo(
    () => departments.map((d) => d.department_name),
    [departments]
  );
  const deptValue = useMemo(() => {
    const m = departments.find((d) => d.department_id === departmentId);
    return m?.department_name || departmentId;
  }, [departments, departmentId]);

  const loadDepartments = async () => {
    try {
      const res = await fetch("/analytics/departments");
      if (!res.ok) return;
      const json = await res.json();
      setDepartments(json?.departments || []);
    } catch {
      // ignore
    }
  };

  type SortKey = "course" | "baseline";
  type SortDir = "asc" | "desc";

  const [sortKey, setSortKey] = useState<SortKey>("course");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (k: SortKey) => {
    setPage(1);

    const defaultDir: SortDir = k === "baseline" ? "desc" : "asc";
    if (sortKey !== k) {
      setSortKey(k);
      setSortDir(defaultDir);
      return;
    }

    setSortDir((d) => (d === "asc" ? "desc" : "asc"));
  };

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/analytics/ft-coverage-review?department_id=${encodeURIComponent(
        departmentId
      )}&suggest_top_n=3`;
      const res = await fetch(url);
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || "Failed to load");
      }
      const json = (await res.json()) as CoverageResponse;
      setData(json);

      // auto-select first row of current tab
      const firstInTab = (json.rows || []).find((r) => r.risk === tab) || null;
      setSelectedCourseId(firstInTab?.course_id || null);
      setPanelMode("DETAILS");
    } catch (e: any) {
      setError(e?.message || "Failed to load");
      setData(null);
      setSelectedCourseId(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDepartments();
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const termLine = useMemo(() => {
    if (!data) return "";
    return `Target: AY ${data.target.acad_year_start}-${
      data.target.acad_year_start + 1
    } Term ${data.target.term_number}  |  Baseline: AY ${
      data.baseline.acad_year_start
    }-${data.baseline.acad_year_start + 1} Term ${data.baseline.term_number}`;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const rows = data.rows.filter((r) => r.risk === tab);
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => (r.course || "").toLowerCase().includes(s));
  }, [data, tab, q]);

  const sorted = useMemo(() => {
    const arr = [...filtered];

    const dir = sortDir === "asc" ? 1 : -1;

    arr.sort((a, b) => {
      if (sortKey === "course") {
        return dir * (a.course || "").localeCompare(b.course || "");
      }
      // sortKey === "baseline"
      return (
        dir *
        (Number(a.baseline_demand_sections) -
          Number(b.baseline_demand_sections))
      );
    });

    return arr;
  }, [filtered, sortKey, sortDir]);

  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const pageStart = (page - 1) * PAGE_SIZE;
  const pageEnd = Math.min(totalRows, pageStart + PAGE_SIZE);

  const pagedRows = useMemo(() => {
    return sorted.slice(pageStart, pageStart + PAGE_SIZE);
  }, [sorted, pageStart]);

  const selected = useMemo(() => {
    if (!data || !selectedCourseId) return null;
    return data.rows.find((r) => r.course_id === selectedCourseId) || null;
  }, [data, selectedCourseId]);

  const counts = useMemo(() => {
    return {
      risk: data?.summary?.risk ?? 0,
      warning: data?.summary?.warning ?? 0,
      safe: data?.summary?.safe ?? 0,
    };
  }, [data]);

  const suggestedAction = useMemo(() => {
    return selected?.suggested_action ?? null;
  }, [selected]);  

  const onTab = (t: Tab) => {
    setTab(t);
    setQ("");
    setPage(1);
    setPanelMode("DETAILS");
    const first = (data?.rows || []).find((r) => r.risk === t) || null;
    setSelectedCourseId(first?.course_id || null);
  };

  return (
    <div className="w-full h-full min-h-0 px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Course Coverage Risk Indicators</h1>
        <p className="text-sm text-gray-600">
        Flags courses that may be hard to staff with FT by comparing last year’s same-term demand vs current FT availability/capacity (including deloading/leave/activity checks), and shows a breakdown per baseline section + suggested actions.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* Top controls */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Link
                to="/om/home/reports-analytics"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
              >
                <ChevronLeft className="h-4 w-4" />
                <span>Back</span>
              </Link>

              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={run}
                  disabled={loading}
                  className={cls(
                    "rounded-lg border px-4 py-2 text-sm font-semibold",
                    loading
                      ? "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400"
                      : "border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
                  )}
                >
                  {loading ? "Loading…" : "Run"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div className="sm:col-span-2">
                <label className="block text-s text-gray-600 mb-1">
                  Department
                </label>

                {/* NEW: constrain width */}
                <div className="w-full max-w-sm">
                  <SelectBox
                    value={deptValue}
                    onChange={(v) => {
                      const nextName = (v || "").trim();
                      const next = departments.find(
                        (d) => d.department_name === nextName
                      );
                      setDepartmentId(next?.department_id || departmentId);
                    }}
                    options={deptOptions.length ? deptOptions : [departmentId]}
                  />
                </div>
              </div>

              <div className="sm:col-span-1 flex justify-end">
                <div className="text-s text-gray-500 mt-1 text-right">
                  {data ? termLine : ""}
                </div>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
            {error}
          </div>
        )}

        {/* Tabs (OUTSIDE but CONNECTED to main container) */}
        <div className="px-4 pt-4">
          <div className="inline-flex overflow-hidden border border-gray-200 bg-gray-50">
            <button
              onClick={() => onTab("RISK")}
              className={cls(
                "px-5 py-3 text-left",
                tab === "RISK"
                  ? "bg-white border-b-2 border-rose-500"
                  : "hover:bg-gray-100"
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cls(
                    "inline-flex h-7 min-w-7 items-center justify-center px-2 text-xs font-bold",
                    tab === "RISK"
                      ? "bg-rose-100 text-rose-700"
                      : "bg-rose-50 text-rose-600"
                  )}
                >
                  1
                </span>
                <span className="text-base font-semibold text-gray-900">
                  Risk
                </span>
                <span
                  className={cls(
                    "ml-1 inline-flex items-center justify-center px-2.5 py-0.5 text-xs font-bold",
                    tab === "RISK"
                      ? "bg-rose-100 text-rose-700"
                      : "bg-gray-200 text-gray-700"
                  )}
                >
                  {counts.risk}
                </span>
              </div>
            </button>

            <button
              onClick={() => onTab("WARNING")}
              className={cls(
                "px-5 py-3 text-left border-l border-gray-200",
                tab === "WARNING"
                  ? "bg-white shadow-[inset_0_-2px_0_0_rgb(245,158,11)]"
                  : "hover:bg-gray-100"
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cls(
                    "inline-flex h-7 min-w-7 items-center justify-center px-2 text-xs font-bold",
                    tab === "WARNING"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-amber-50 text-amber-700"
                  )}
                >
                  1
                </span>
                <span className="text-base font-semibold text-gray-900">
                  Warning
                </span>
                <span
                  className={cls(
                    "ml-1 inline-flex items-center justify-center px-2.5 py-0.5 text-xs font-bold",
                    tab === "WARNING"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-gray-200 text-gray-700"
                  )}
                >
                  {counts.warning}
                </span>
              </div>
            </button>

            <button
              onClick={() => onTab("SAFE")}
              className={cls(
                "px-5 py-3 text-left border-l border-gray-200",
                tab === "SAFE"
                  ? "bg-white shadow-[inset_0_-2px_0_0_rgb(16,185,129)]"
                  : "hover:bg-gray-100"
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cls(
                    "inline-flex h-7 min-w-7 items-center justify-center px-2 text-xs font-bold",
                    tab === "SAFE"
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-emerald-50 text-emerald-700"
                  )}
                >
                  2
                </span>
                <span className="text-base font-semibold text-gray-900">
                  Safe
                </span>
                <span
                  className={cls(
                    "ml-1 inline-flex items-center justify-center px-2.5 py-0.5 text-xs font-bold",
                    tab === "SAFE"
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-gray-200 text-gray-700"
                  )}
                >
                  {counts.safe}
                </span>
              </div>
            </button>
          </div>
          <div className="border-t border-gray-200 w-full" />
        </div>

        {/* Main container (CONNECTED: no top border, no rounding) */}
        <div className="px-4 pb-4">
          <div className="border border-gray-200 border-t-0 bg-white overflow-hidden">
            {/* Search row */}
            <div className="p-3">
              <div className="relative w-full max-w-xl">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search courses..."
                  className="w-full border border-gray-300 pl-9 pr-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                />
                {q.trim() && (
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100"
                    onClick={() => setQ("")}
                    aria-label="Clear"
                  >
                    <X className="h-4 w-4 text-gray-500" />
                  </button>
                )}
              </div>
            </div>

            {/* Content row: left table + right panel */}
            <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Left table (no extra outer border; container already has it) */}
              <div className="lg:col-span-2 rounded-xl border border-gray-200 overflow-hidden">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-700 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-semibold border-b">
                        <button
                          type="button"
                          onClick={() => toggleSort("course")}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          Course
                          <span
                            className={cls(
                              "text-[10px]",
                              sortKey === "course"
                                ? "text-gray-700"
                                : "text-gray-300"
                            )}
                          >
                            {sortKey === "course"
                              ? sortDir === "asc"
                                ? "▲"
                                : "▼"
                              : "▲"}
                          </span>
                        </button>
                      </th>

                      <th className="px-4 py-2.5 text-center font-semibold border-b">
                        <button
                          type="button"
                          onClick={() => toggleSort("baseline")}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          Last A.Y. Sections
                          <span
                            className={cls(
                              "text-[10px]",
                              sortKey === "baseline"
                                ? "text-gray-700"
                                : "text-gray-300"
                            )}
                          >
                            {sortKey === "baseline"
                              ? sortDir === "asc"
                                ? "▲"
                                : "▼"
                              : "▼"}
                          </span>
                        </button>
                      </th>
                      <th className="px-4 py-2.5 text-center font-semibold border-b">
                        FT Can Cover
                      </th>
                      <th className="px-4 py-2.5 text-center font-semibold border-b">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((r, idx: number) => {
                      const selectedRow = r.course_id === selectedCourseId;
                      return (
                        <tr
                          key={r.course_id}
                          onClick={() => {
                            setSelectedCourseId(r.course_id);
                            setPanelMode("DETAILS");
                          }}
                          className={cls(
                            "cursor-pointer border-b border-gray-100",
                            idx % 2 === 0 ? "bg-white" : "bg-gray-50",
                            selectedRow
                              ? "bg-emerald-50 shadow-[inset_4px_0_0_0_rgb(16,185,129)]"
                              : "hover:bg-gray-100"
                          )}
                        >
                          <td className="px-4 py-2.5 text-left font-medium text-gray-900">
                            {r.course}
                          </td>
                          <td className="px-4 py-2.5 text-center tabular-nums">
                            {r.baseline_demand_sections}
                          </td>
                          <td className="px-4 py-2.5 text-center tabular-nums">
                            {r.ft_can_cover_sections_est}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <StatusBadge v={r.risk} />
                          </td>
                        </tr>
                      );
                    })}

                    {!loading && data && filtered.length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-4 py-8 text-center text-gray-500"
                        >
                          No courses found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 text-sm">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className={cls(
                      "px-3 py-2 border border-gray-300 bg-white",
                      page <= 1
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:bg-gray-50"
                    )}
                  >
                    Prev
                  </button>

                  <div className="text-gray-600 tabular-nums">
                    {totalRows === 0 ? "0" : `${pageStart + 1}-${pageEnd}`} of{" "}
                    {totalRows}
                  </div>

                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className={cls(
                      "px-3 py-2 border border-gray-300 bg-white",
                      page >= totalPages
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:bg-gray-50"
                    )}
                  >
                    Next
                  </button>
                </div>
              </div>

              {/* Right side panel */}
              <div className="lg:col-span-1 rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="p-4 border-b border-gray-200 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">
                      {selected ? `${selected.course} Overview` : "Overview"}
                    </div>
                    {selected && (
                      <div className="text-xs text-gray-500 mt-0.5">
                        {selected.course_title || ""}
                      </div>
                    )}
                  </div>
                </div>

                <div className="px-4 pt-3">
                  <div className="flex gap-3 text-sm font-semibold">
                    <button
                      className={cls(
                        "pb-2",
                        panelMode === "DETAILS"
                          ? "text-gray-900 border-b-2 border-emerald-400"
                          : "text-gray-500"
                      )}
                      onClick={() => setPanelMode("DETAILS")}
                    >
                      Details
                    </button>

                    {/* <button
                      className={cls(
                        "pb-2",
                        panelMode === "HISTORY"
                          ? "text-gray-900 border-b-2 border-emerald-400"
                          : "text-gray-500"
                      )}
                      onClick={() => setPanelMode("HISTORY")}
                    >
                      History
                    </button> */}

                    <button
                      className={cls(
                        "pb-2",
                        panelMode === "ACTIONS"
                          ? "text-gray-900 border-b-2 border-emerald-400"
                          : "text-gray-500"
                      )}
                      onClick={() => setPanelMode("ACTIONS")}
                    >
                      Suggested Action
                    </button>
                  </div>
                </div>

                <div className="p-4 space-y-4">
                  {!selected ? (
                    <div className="text-sm text-gray-500">
                      Select a course to see details.
                    </div>
                  ) : panelMode === "DETAILS" ? (
                    <>
                      {/* DETAILS */}
                      <div className="flex items-center justify-between">
                        <StatusBadge v={selected.risk} />
                        {/* <div className="text-xs text-gray-500">
                          Confidence: {selected.confidence}%
                        </div> */}
                      </div>

                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                        <div className="flex justify-between">
                          <span className="text-gray-600">
                            Demand (Last AY)
                          </span>
                          <span className="font-semibold tabular-nums">
                            {selected.baseline_demand_sections}
                          </span>
                        </div>
                        <div className="flex justify-between mt-1">
                          <span className="text-gray-600">
                            FT can cover (est.)
                          </span>
                          <span className="font-semibold tabular-nums">
                            {selected.ft_can_cover_sections_est}
                          </span>
                        </div>
                        {selected.risk === "RISK" && (
                          <div className="flex justify-between mt-1">
                            <span className="text-gray-600">Uncovered</span>
                            <span className="font-semibold tabular-nums">
                              {selected.uncovered_sections}
                            </span>
                          </div>
                        )}
                      </div>

                      {selected?.ft_breakdown?.length ? (
                        <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3">
                          <div className="text-sm font-semibold text-gray-900">
                            FT Availability Breakdown
                          </div>
                          <div className="mt-2 space-y-2 max-h-110 overflow-y-auto pr-2">
                            {[...selected.ft_breakdown]
                              .sort((a, b) => {
                                const aRank = a.status === "UNAVAILABLE" ? 0 : 1;
                                const bRank = b.status === "UNAVAILABLE" ? 0 : 1;
                                if (aRank !== bRank) return aRank - bRank;

                                // tie-breaker: by section code
                                return (a.section_code || "").localeCompare(b.section_code || "");
                              })
                              .map((b) => {
                              const reasons = (b.reasons || []).filter(Boolean);

                              const displayFaculty =
                                (b.faculty_name && b.faculty_name.trim()) ||
                                (b.faculty_id ? b.faculty_id : "—");

                              return (
                                <div
                                  key={b.section_id}
                                  className="rounded-md border border-gray-100 p-2"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="font-medium text-gray-900">
                                      {b.section_code || b.section_id}{" "}
                                      <span className="text-xs text-gray-500">
                                        {b.baseline_employment_type
                                          ? `(${b.baseline_employment_type})`
                                          : ""}
                                      </span>
                                    </div>

                                    <span
                                      className={
                                        "rounded-full px-2 py-0.5 text-xs " +
                                        (b.status === "AVAILABLE"
                                          ? "bg-green-50 text-green-700"
                                          : "bg-red-50 text-red-700")
                                      }
                                    >
                                      {b.status}
                                    </span>
                                  </div>

                                  <div className="mt-1 text-xs text-gray-600">
                                    Faculty:{" "}
                                    <span className="font-medium text-gray-800">
                                      {displayFaculty}
                                    </span>
                                    {b.faculty_id ? (
                                      <span className="text-gray-400">
                                        {" "}
                                        • {b.faculty_id}
                                      </span>
                                    ) : null}
                                  </div>

                                  <div className="mt-1 text-xs text-gray-600">
                                    {reasons.length ? (
                                      <>Reasons: {reasons.join(", ")}</>
                                    ) : (
                                      <>Reasons: —</>
                                    )}
                                  </div>

                                  <div className="mt-1 text-xs text-gray-600">
                                    Unit Capacity: {b.capacity_units ?? "—"} |
                                    {/* Deload: {b.deload_units ?? "—"} | Effective:{" "}
                                    {b.effective_units ?? "—"} | */}
                                    No. of units can cover: {b.sections_can_cover ?? "—"}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : panelMode === "ACTIONS" ? (
                    <div className="space-y-4">
                      <div className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="text-sm font-semibold text-gray-900">
                          Suggested Action
                        </div>
                        <div className="mt-1 text-xs text-gray-500">
                          Based on last A.Y. sections and current
                          availability signals.
                        </div>
                      </div>

                      {/* 1) Hire PT */}
                      <div className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold text-gray-900">
                            1) Hire Part-Time Instructors
                          </div>
                          <div className="text-xs text-gray-600">
                            Need:{" "}
                            <span className="font-semibold tabular-nums">
                              {suggestedAction?.pt_needed ?? 0}
                            </span>
                          </div>
                        </div>

                        <div className="mt-2 text-xs text-gray-600">
                          Suggested list (taught this course last year):
                        </div>

                        <div className="mt-2 space-y-2">
                          {(suggestedAction?.pt_taught_last_year || []).length ? (
                            (suggestedAction?.pt_taught_last_year || [])
                              .slice(0, 10)
                              .map((p) => (
                                <div
                                  key={p.faculty_id}
                                  className="rounded-md border border-gray-100 p-2"
                                >
                                  <div className="text-sm font-medium text-gray-900">
                                    {p.name}
                                  </div>
                                  <div className="text-xs text-gray-600">
                                    {p.faculty_id} • sections taught last A.Y. :{" "}
                                    <span className="tabular-nums">
                                      {p.sections}
                                    </span>
                                  </div>
                                </div>
                              ))
                          ) : (
                            <div className="text-sm text-gray-500">
                              No PT instructors found for this course based on last A.Y. data.
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 2) Ask to overload */}
                      <div className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="text-sm font-semibold text-gray-900">
                          2) Ask Professors to Overload
                        </div>
                        <div className="mt-2 text-xs text-gray-600">
                          Top candidates (most teaching history for this course;
                          active & not on leave):
                        </div>

                        <div className="mt-2 space-y-2">
                          {(suggestedAction?.overload_candidates || [])
                            .length ? (
                            (suggestedAction?.overload_candidates || []).map(
                              (c) => (
                                <div
                                  key={c.faculty_id}
                                  className="rounded-md border border-gray-100 p-2"
                                >
                                  <div className="text-sm font-medium text-gray-900">
                                    {c.name}
                                  </div>
                                  <div className="text-xs text-gray-600">
                                    {c.faculty_id} • sections taught last A.Y.:{" "}
                                    <span className="tabular-nums">
                                      {c.baseline_sections}
                                    </span>
                                    {" • "}
                                    current section capacity :{" "}
                                    <span className="tabular-nums">
                                      {c.now_sections_capacity}
                                    </span>
                                  </div>
                                </div>
                              )
                            )
                          ) : (
                            <div className="text-sm text-gray-500">
                              No eligible overload candidates found.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* HISTORY (your existing HISTORY UI) */
                    <div className="text-sm text-gray-700">
                      <div className="font-semibold mb-2">Baseline Term</div>
                      <div className="text-xs text-gray-500">
                        Term ID: {selected.history.baseline_term_id}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer inside same main container */}
            <div className="border-t-0 px-4 py-2 text-xs text-gray-500">
              Generated:{" "}
              {data ? new Date(data.generated_at).toLocaleString() : "—"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
