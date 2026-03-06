// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_LoadRisk.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, Info, Search as SearchIcon, X } from "lucide-react";
import { getSessionUserId } from "../../../lib/session";

type OmProfile = {
  ok?: boolean;
  dept_name?: string;
  full_name?: string;
  position_title?: string;
};

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
    // backward compatibility (older UI versions)
    avg_confidence?: number;

    // decision-friendly summary
    total_baseline_sections?: number;
    total_coverable_sections?: number;
    total_uncovered_sections?: number;
    overall_coverage_pct?: number;
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

  covered_by_faculty_id?: string | null;
  covered_by_name?: string | null;
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

const REASON_LABELS: Record<string, string> = {
  NO_BASELINE_FACULTY_ASSIGNMENT: "No faculty assigned last AY (baseline)",
  BASELINE_TAUGHT_BY_PT: "Baseline section was taught by PT",
  ON_APPROVED_LEAVE: "On approved leave",
  INACTIVE_RECENT_TERMS: "No teaching activity in the checked terms",
  INSUFFICIENT_UNITS_FOR_1_SECTION: "Not enough remaining units for 1 section",
  DELOAD_APPLIED: "Has deloading this term",
  COVERED_BY_FT_POOL: "Covered by FT capacity now",
  COVERED_BY_OTHER_FT: "Covered by another FT",
};

function fmtReasons(xs: string[] | undefined | null) {
  const list = (xs || []).filter(Boolean);
  if (!list.length) return "—";
  return list.map((r) => REASON_LABELS[r] || r).join(", ");
}

function clampPct(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

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

function HoverInfo({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center">
      <span className="group inline-flex items-center" aria-label="Info">
        <Info className="h-4 w-4 text-gray-400 group-hover:text-gray-600" />
        <span className="pointer-events-none absolute left-1/2 top-full z-50 hidden w-80 -translate-x-1/2 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-xs text-gray-700 shadow-md group-hover:block">
          {text}
        </span>
      </span>
    </span>
  );
}


type Tab = "RISK" | "WARNING" | "SAFE";

export default function OM_RP_LoadRisk() {
  const PAGE_SIZE = 15;
  const [page, setPage] = useState(1);

  const [departmentId, setDepartmentId] = useState("DEPT0001");
  const [departmentName, setDepartmentName] = useState<string>("");
  const [tab, setTab] = useState<Tab>("RISK");
  const [q, setQ] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"DETAILS" | "HISTORY" | "ACTIONS">(
    "DETAILS"
  );

  const loadMyDepartment = async (): Promise<{ deptId: string; deptName: string }> => {
    const fallback = { deptId: "DEPT0001", deptName: "" };
    try {
      const userId = getSessionUserId();
      if (!userId) return fallback;

      const res = await fetch(
        `/api/om/loadassignment?action=profile&userId=${encodeURIComponent(userId)}`
      );
      if (!res.ok) return fallback;

      const json = (await res.json()) as OmProfile;
      const deptName = String(json?.dept_name || "").trim();

      // Prefer dept_id if your backend already returns it; otherwise map dept_name -> id using analytics list.
      const maybeDeptId = String((json as any)?.dept_id || "").trim();
      if (maybeDeptId) return { deptId: maybeDeptId, deptName };

      if (!deptName) return fallback;

      const depRes = await fetch("/analytics/departments");
      if (!depRes.ok) return fallback;
      const depJson = await depRes.json();
      const items: DepartmentItem[] = depJson?.departments || [];

      const norm = (s: string) => String(s || "").trim().toLowerCase();
      const found = items.find((d) => norm(d.department_name) === norm(deptName));
      return { deptId: found?.department_id || fallback.deptId, deptName };
    } catch {
      return fallback;
    }
  };

  type SortKey = "course" | "baseline" | "coverage" | "uncovered";
  type SortDir = "asc" | "desc";

  const [sortKey, setSortKey] = useState<SortKey>("course");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (k: SortKey) => {
    setPage(1);

    const defaultDir: SortDir =
      k === "baseline" || k === "uncovered" ? "desc" : "asc";
    if (sortKey !== k) {
      setSortKey(k);
      setSortDir(defaultDir);
      return;
    }

    setSortDir((d) => (d === "asc" ? "desc" : "asc"));
  };

  const didInitRef = useRef(false);

  const run = async (deptOverride?: string) => {
    setLoading(true);
    setError(null);
    try {
      const dept = deptOverride ?? departmentId;
      const url = `/analytics/ft-coverage-review?department_id=${encodeURIComponent(
        dept
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
    (async () => {
      const mine = await loadMyDepartment();
      setDepartmentId(mine.deptId);
      setDepartmentName(mine.deptName);
      await run(mine.deptId);
      didInitRef.current = true;
    })();
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

      if (sortKey === "baseline") {
        return (
          dir *
          (Number(a.baseline_demand_sections) -
            Number(b.baseline_demand_sections))
        );
      }

      if (sortKey === "uncovered") {
        return dir * (Number(a.uncovered_sections) - Number(b.uncovered_sections));
      }

      // sortKey === "coverage"
      const aPct =
        a.baseline_demand_sections > 0
          ? (100 * Number(a.ft_can_cover_sections_est)) /
            Number(a.baseline_demand_sections)
          : 0;
      const bPct =
        b.baseline_demand_sections > 0
          ? (100 * Number(b.ft_can_cover_sections_est)) /
            Number(b.baseline_demand_sections)
          : 0;
      return dir * (aPct - bPct);
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

  const coverageSummary = useMemo(() => {
    if (!data) return null;

    const s = data.summary || ({} as any);
    const totalBaseline =
      typeof s.total_baseline_sections === "number"
        ? s.total_baseline_sections
        : data.rows.reduce((acc, r) => acc + Number(r.baseline_demand_sections || 0), 0);
    const totalCoverable =
      typeof s.total_coverable_sections === "number"
        ? s.total_coverable_sections
        : data.rows.reduce((acc, r) => acc + Number(r.ft_can_cover_sections_est || 0), 0);
    const totalUncovered =
      typeof s.total_uncovered_sections === "number"
        ? s.total_uncovered_sections
        : Math.max(0, totalBaseline - totalCoverable);

    const pct =
      typeof s.overall_coverage_pct === "number"
        ? s.overall_coverage_pct
        : totalBaseline > 0
        ? Math.round((100 * totalCoverable) / totalBaseline)
        : 0;

    return {
      pct: clampPct(pct),
      totalBaseline,
      totalCoverable,
      totalUncovered,
    };
  }, [data]);

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
          Flags courses that may be hard to staff with FT by comparing last year’s same-term demand vs current FT availability/capacity (including deloading/leave/activity checks). Use this to prioritize staffing decisions.
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

              <div className="ml-auto text-sm text-gray-500 text-right">
                {data ? termLine : ""}
              </div>
            </div>

            {departmentName ? (
              <div className="text-xs text-gray-500">{departmentName}</div>
            ) : null}

            {data && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {coverageSummary ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-semibold">Overall coverage vs last AY</span>:
                      <span>
                        {coverageSummary.pct}% ({coverageSummary.totalCoverable}/
                        {coverageSummary.totalBaseline} sections)
                      </span>
                      <HoverInfo text="Percent of last-AY sections that baseline FT can cover now." />
                      <span className="text-gray-500">•</span>
                      <span>
                        <span className="font-semibold">Uncovered</span>: {coverageSummary.totalUncovered}
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
            {error}
          </div>
        )}

        {/* Tabs (OUTSIDE but CONNECTED to main container) */}
        <div className="px-4 pt-4">
          <div className="inline-flex border border-gray-200 bg-gray-50">
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
                  !
                </span>
                <span className="text-base font-semibold text-gray-900">
                  Risk
                </span>
                <HoverInfo text="Risk: at least 1 last-AY section cannot be covered by baseline FT now, or there is no baseline FT history last AY." />
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
                  !
                </span>
                <span className="text-base font-semibold text-gray-900">
                  Warning
                </span>
                <HoverInfo text="Warning: covered now, but fragile (depends on few FT), or the course relied on PT last AY." />
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
                  ✓
                </span>
                <span className="text-base font-semibold text-gray-900">
                  Safe
                </span>
                <HoverInfo text="Safe: last-AY sections are covered by baseline FT with no major fragility signs." />
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
              <div className="flex items-center gap-2">
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

                <button
                  onClick={() => {
                    void run();
                  }}
                  disabled={loading}
                  className={cls(
                    "inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110",
                    loading && "opacity-50 cursor-not-allowed hover:brightness-100"
                  )}
                >
                  {loading ? "Loading…" : "Run"}
                </button>
              </div>
            </div>

            {/* Content row: left table + right panel */}
            <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Left table (no extra outer border; container already has it) */}
              <div className="lg:col-span-2 rounded-xl border border-gray-200 overflow-hidden">
                <table className="min-w-full text-sm">
	                  {/* Title case column headers (no forced uppercase) */}
	                  <thead className="bg-gray-50 text-gray-700 text-xs tracking-wide">
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
	                          Last AY Sections
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
                        Coverable
                      </th>
                      <th className="px-4 py-2.5 text-center font-semibold border-b">
                        <button
                          type="button"
                          onClick={() => toggleSort("coverage")}
                          className="inline-flex items-center gap-1 hover:underline"
                                                  >
                          Coverage
                          <span
                            className={cls(
                              "text-[10px]",
                              sortKey === "coverage"
                                ? "text-gray-700"
                                : "text-gray-300"
                            )}
                          >
                            {sortKey === "coverage"
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
                          onClick={() => toggleSort("uncovered")}
                          className="inline-flex items-center gap-1 hover:underline"
                                                  >
                          Uncovered
                          <span
                            className={cls(
                              "text-[10px]",
                              sortKey === "uncovered"
                                ? "text-gray-700"
                                : "text-gray-300"
                            )}
                          >
                            {sortKey === "uncovered"
                              ? sortDir === "asc"
                                ? "▲"
                                : "▼"
                              : "▼"}
                          </span>
                        </button>
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
                          <td className="px-4 py-2.5 text-left font-semibold text-emerald-700">
                            {r.course}
                          </td>
                          <td className="px-4 py-2.5 text-center tabular-nums">
                            {r.baseline_demand_sections}
                          </td>
                          <td className="px-4 py-2.5 text-center tabular-nums">
                            {r.ft_can_cover_sections_est}
                          </td>
                          <td className="px-4 py-2.5 text-center tabular-nums">
                            {r.baseline_demand_sections > 0
                              ? `${clampPct(
                                  (100 * r.ft_can_cover_sections_est) /
                                    r.baseline_demand_sections
                                )}%`
                              : "—"}
                          </td>
                          <td className="px-4 py-2.5 text-center tabular-nums">
                            {r.uncovered_sections}
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
                          colSpan={6}
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
                    <div className="text-sm font-semibold">
                      {selected ? (
                        <>
                          <span className="text-emerald-700">{selected.course}</span>{" "}
                          <span className="text-gray-900">Overview</span>
                        </>
                      ) : (
                        <span className="text-gray-900">Overview</span>
                      )}
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
                      <div className="flex items-center justify-between">
                        <StatusBadge v={selected.risk} />
                        <div className="text-xs text-gray-500">
                          {selected.risk === "RISK"
                            ? `Uncovered: ${selected.uncovered_sections}`
                            : selected.risk === "WARNING"
                            ? "Covered, but fragile"
                            : "Covered"}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-500">Demand (last AY)</div>
                          <div className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
                            {selected.baseline_demand_sections}
                          </div>
                        </div>

                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-500">Coverable now (baseline FT)</div>
                          <div className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
                            {selected.ft_can_cover_sections_est}
                          </div>
                        </div>

                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-500">Coverage</div>
                          <div className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
                            {selected.baseline_demand_sections > 0
                              ? `${clampPct(
                                  (100 * selected.ft_can_cover_sections_est) /
                                    selected.baseline_demand_sections
                                )}%`
                              : "—"}
                          </div>
                        </div>

                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-500">Uncovered</div>
                          <div className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
                            {selected.uncovered_sections}
                          </div>
                        </div>
                      </div>

                      {(selected.reasons || []).length ? (
                        <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
                          <div className="text-sm font-semibold text-gray-900">
                            Why this is flagged
                          </div>
                          <ul className="mt-2 list-disc pl-5 text-sm text-gray-700 space-y-1">
                            {(selected.reasons || []).slice(0, 3).map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <div className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-semibold text-gray-900">
                            Availability breakdown
                          </div>
                          <HoverInfo text="Shows last-AY instructor and whether baseline FT capacity can cover the section now." />
                        </div>

{selected?.ft_breakdown?.length ? (
                          <div className="mt-3 space-y-2 max-h-[22rem] overflow-y-auto pr-2">
                            {[...selected.ft_breakdown]
                              .sort((a, b) =>
                                (a.section_code || "").localeCompare(b.section_code || "")
                              )
                              .map((b) => {
                                const reasons = (b.reasons || [])
                                  .filter((x) => x && !String(x).startsWith("COVERED_BY"))
                                  .slice(0, 2);
                                const baselineFaculty =
                                  (b.faculty_name && b.faculty_name.trim()) || "—";
                                const canCover =
                                  b.status === "AVAILABLE" ||
                                  Number(b.sections_can_cover || 0) === 1;

                                const coveredBy =
                                  (b.covered_by_name && b.covered_by_name.trim()) || null;
                                const showCoveredBy =
                                  !!coveredBy && canCover && coveredBy !== baselineFaculty;

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
                                        className={cls(
                                          "rounded-full px-2 py-0.5 text-xs font-semibold",
                                          canCover
                                            ? "bg-emerald-50 text-emerald-700"
                                            : "bg-rose-50 text-rose-700"
                                        )}
                                      >
                                        {canCover ? "CAN COVER" : "CANNOT COVER"}
                                      </span>
                                    </div>

                                    <div className="mt-1 text-xs text-gray-600">
                                      Last AY faculty:{" "}
                                      <span className="font-medium text-gray-800">
                                        {baselineFaculty}
                                      </span>
                                    </div>

                                    {showCoveredBy ? (
                                      <div className="mt-1 text-xs text-gray-600">
                                        Covered now by:{" "}
                                        <span className="font-medium text-gray-800">{coveredBy}</span>
                                      </div>
                                    ) : null}

                                    {reasons.length ? (
                                      <div className="mt-1 text-xs text-gray-600">
                                        {fmtReasons(reasons)}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                          </div>
                        ) : (
                          <div className="mt-2 text-xs text-gray-500">
                            No breakdown available.
                          </div>
                        )}
                      </div>
                    </>
                  ) : panelMode === "ACTIONS" ? (
                    <div className="space-y-3">
                      {selected.risk === "SAFE" ? (
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                          <div className="font-semibold">Covered.</div>
                          <div className="mt-1 text-xs text-emerald-900/80">
                            No action needed based on baseline demand and current availability signals.
                          </div>
                        </div>
                      ) : selected.risk === "WARNING" ? (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                          <div className="font-semibold">Covered, but fragile.</div>
                          <div className="mt-1 text-xs text-amber-900/80">
                            Consider preparing backups (PT or overload) in case availability changes.
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
                          <div className="font-semibold">
                            Uncovered sections:{" "}
                            <span className="tabular-nums">{selected.uncovered_sections}</span>
                          </div>
                          <div className="mt-1 text-xs text-rose-900/80">
                            Choose an option below to cover the remaining sections.
                          </div>
                        </div>
                      )}

                      <div className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-gray-900">
                            Option A: Assign Part-Time (PT)
                          </div>
                          {selected.risk === "RISK" ? (
                            <div className="text-xs text-gray-600">
                              Need:{" "}
                              <span className="font-semibold tabular-nums">
                                {selected.uncovered_sections}
                              </span>
                            </div>
                          ) : null}
                        </div>

                        <div className="mt-2 space-y-2">
                          {(suggestedAction?.pt_taught_last_year || []).length ? (
                            (suggestedAction?.pt_taught_last_year || [])
                              .slice(0, 5)
                              .map((p) => (
                                <div
                                  key={p.faculty_id}
                                  className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2"
                                >
                                  <div className="text-sm font-medium text-gray-900">
                                    {p.name}
                                  </div>
                                  <div className="text-xs text-gray-600 tabular-nums">
                                    taught {p.sections} last AY
                                  </div>
                                </div>
                              ))
                          ) : (selected.pt_suggestions || []).length ? (
                            <div className="space-y-2">
                              <div className="text-xs text-gray-500">
                                No PT history found for this course. Backup PT (dept, not on leave):
                              </div>
                              {(selected.pt_suggestions || []).slice(0, 5).map((p) => (
                                <div
                                  key={p.faculty_id}
                                  className="rounded-md border border-gray-100 px-3 py-2 text-sm font-medium text-gray-900"
                                >
                                  {p.name}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-gray-500">
                              No PT suggestions available.
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="rounded-lg border border-gray-200 bg-white p-3">
                        <div className="text-sm font-semibold text-gray-900">
                          Option B: Ask FT to Overload
                        </div>

                        <div className="mt-2 space-y-2">
                          {(suggestedAction?.overload_candidates || []).length ? (
                            (suggestedAction?.overload_candidates || [])
                              .slice(0, 5)
                              .map((c) => (
                                <div
                                  key={c.faculty_id}
                                  className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2"
                                >
                                  <div className="text-sm font-medium text-gray-900">
                                    {c.name}
                                  </div>
                                  <div className="text-xs text-gray-600 tabular-nums">
                                    history {c.baseline_sections} • capacity {c.now_sections_capacity}
                                  </div>
                                </div>
                              ))
                          ) : (
                            <div className="text-sm text-gray-500">
                              No overload candidates found.
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
