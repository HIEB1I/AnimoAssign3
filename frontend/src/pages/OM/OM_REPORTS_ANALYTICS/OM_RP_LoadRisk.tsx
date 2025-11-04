// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_LoadRisk.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { fetchPTRisk } from "../../../api";

/** ---------------- Types (from OM_pred2) ---------------- */
type PTRow = {
  course_id: string;
  course_code: string;
  demand_sections: number;
  ft_filled_sections: number;
  pt_needed_sections: number;
  risk: string;
  confidence: string;
  ft_assignees?: string[];
};

type PTResponse = {
  department_id: string;
  term_id: string;
  rows: PTRow[];
  summary: { total_pt_sections: number; estimated_pt_hires: number };
  generated_at: string;
  params: any;
};

/** ---------------- Tiny util ---------------- */
const cls = (...s: Array<string | false | undefined>) => s.filter(Boolean).join(" ");

function badgeClasses(kind: "risk" | "confidence", value?: string) {
  const v = (value || "").toLowerCase();
  if (kind === "risk") {
    if (v.includes("high")) return "bg-rose-100 text-rose-800 border border-rose-200";
    if (v.includes("medium")) return "bg-amber-100 text-amber-800 border border-amber-200";
    if (v.includes("low")) return "bg-emerald-100 text-emerald-800 border border-emerald-200";
    return "bg-gray-100 text-gray-700 border border-gray-200";
  }
  // confidence
  const n = parseInt(v, 10);
  if (!isNaN(n)) {
    if (n >= 80) return "bg-emerald-100 text-emerald-800 border border-emerald-200";
    if (n >= 50) return "bg-amber-100 text-amber-800 border border-amber-200";
    return "bg-gray-100 text-gray-700 border border-gray-200";
  }
  return "bg-gray-100 text-gray-700 border border-gray-200";
}

/** ---------------- Page ---------------- */
export default function OM_RP_LoadRisk() {
  // knobs (ported from OM_pred2)
  const [departmentId, setDepartmentId] = useState("DEPT0001");
  const [overload, setOverload] = useState(0);
  const [histK, setHistK] = useState(3);
  const [onlyWithPrefs, setOnlyWithPrefs] = useState(false); // kept for future; UI stays hidden
  const [allowFallback, setAllowFallback] = useState(false); // kept for future; UI stays hidden

  // data state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PTResponse | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchPTRisk({
        department_id: departmentId,
        overload_allowance_units: overload,
        history_terms_for_experience: histK,
        include_only_with_preferences: onlyWithPrefs,
        allow_fallback_without_sections: allowFallback,
      });
      setData(resp);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // auto-load on mount
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(() => {
    if (!data) return { demand: 0, ft: 0, pt: 0 };
    const demand = data.rows.reduce((a, r) => a + r.demand_sections, 0);
    const ft = data.rows.reduce((a, r) => a + r.ft_filled_sections, 0);
    const pt = data.rows.reduce((a, r) => a + r.pt_needed_sections, 0);
    return { demand, ft, pt };
  }, [data]);

  return (
    <div className="w-full max-w-[1400px] mx-auto px-8 py-8">
      {/* Header and subtitle retained (DO NOT MODIFY) */}
      <h1 className="text-2xl font-bold mb-2">Faculty Load Risk Forecast</h1>
      <p className="text-sm text-gray-600 mb-6">
        Risk indicators for over/under-loading by course and estimated section coverage needs.
      </p>

      {/* -- Main content (in OM_RP aesthetic) -- */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* Top Bar: Back + Filters (aligned & evenly spaced) */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Link
                to="/om/home/reports-analytics"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
                aria-label="Back"
                title="Back"
              >
                <ChevronLeft className="h-4 w-4" />
                <span>Back</span>
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 items-end">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Department</label>
                <input
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  placeholder="DEPT0001"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">Overload allowance (units)</label>
                <select
                  value={overload}
                  onChange={(e) => setOverload(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm shadow-sm bg-white focus:ring-2 focus:ring-emerald-500/30"
                >
                  <option value={0}>0</option>
                  <option value={3}>3</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">History window (terms)</label>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={histK}
                  onChange={(e) => setHistK(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                />
              </div>

              <div className="flex gap-2 sm:justify-end">
                <button
                  disabled={loading}
                  onClick={load}
                  className={cls(
                    "w-full sm:w-auto rounded-lg border px-4 py-2 text-sm font-semibold",
                    loading
                      ? "cursor-default border-emerald-200 bg-emerald-200 text-emerald-900"
                      : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
                  )}
                >
                  {loading ? "Loading…" : "Run"}
                </button>
              </div>

              {/* Keep for later if you re-enable:
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={onlyWithPrefs}
                  onChange={(e) => setOnlyWithPrefs(e.target.checked)}
                  className="rounded border-gray-300"
                />
                Only FT with previous-term preferences
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowFallback}
                  onChange={(e) => setAllowFallback(e.target.checked)}
                  className="rounded border-gray-300"
                />
                Allow demand fallback if no sections
              </label>
              */}
            </div>
          </div>
        </div>

        {/* Status / error rows */}
        {error && (
          <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
        )}
        {loading && <div className="px-4 py-4 text-sm text-gray-500">Loading…</div>}

        {/* Summary band */}
        {data && !loading && (
          <div className="flex flex-wrap gap-4 items-center p-4 border-b border-gray-200 text-sm">
            <div>
              <span className="text-gray-600">Term:</span>{" "}
              <span className="font-semibold text-gray-900">{data.term_id}</span>
            </div>
            <div>
              <span className="text-gray-600">Dept:</span>{" "}
              <span className="font-semibold text-gray-900">{data.department_id}</span>
            </div>
            <div>
              <span className="text-gray-600">Generated:</span>{" "}
              <span className="font-semibold text-gray-900">
                {new Date(data.generated_at).toLocaleString()}
              </span>
            </div>
            <div className="ml-auto">
              <span className="text-gray-600">Summary:</span>{" "}
              <span className="font-semibold text-gray-900">
                PT Sections = {data.summary.total_pt_sections} • Est. PT Hires ={" "}
                {data.summary.estimated_pt_hires}
              </span>
            </div>
          </div>
        )}

        {/* Results table */}
        {data && !loading && (
            <div className="p-4">
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="min-w-full table-fixed text-sm border-collapse">
                  <colgroup>
                    <col style={{ width: "22%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "28%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "6%" }} />
                    <col style={{ width: "6%" }} />
                  </colgroup>

                  <thead className="bg-gray-50 text-gray-700 text-xs uppercase tracking-wide sticky top-0 z-[1]">
                    <tr>
                      {[
                        "Course",
                        "Demand (secs)",
                        "FT Filled (secs)",
                        "FT Assignees",
                        "PT Needed",
                        "Risk",
                        "Conf.",
                      ].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr
                        key={r.course_id}
                        className={cls(
                          i % 2 === 0 ? "bg-white" : "bg-gray-50",
                          "text-gray-800 hover:bg-gray-100 transition"
                        )}
                      >
                        <td className="px-4 py-2.5 text-left font-medium text-gray-900">{r.course_code}</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">{r.demand_sections}</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">{r.ft_filled_sections}</td>
                        <td className="px-4 py-2.5">
                          {r.ft_assignees && r.ft_assignees.length ? (
                            <div className="flex flex-wrap gap-1 justify-center">
                              {r.ft_assignees.map((n, idx) => (
                                <span
                                  key={idx}
                                  className="inline-flex items-center rounded-full border border-gray-200 px-2.5 py-0.5 text-xs bg-white text-gray-700"
                                  title={n}
                                >
                                  {n}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="text-center text-gray-500">—</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center font-semibold tabular-nums">
                          {r.pt_needed_sections}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cls("px-2 py-0.5 rounded-full text-xs inline-block text-center", badgeClasses("risk", r.risk))}>
                            {r.risk || "—"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cls("px-2 py-0.5 rounded-full text-xs inline-block text-center", badgeClasses("confidence", r.confidence))}>
                            {r.confidence || "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>

                  <tfoot>
                    <tr>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300 font-bold text-left">TOTAL</td>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300 font-bold text-center tabular-nums">
                        {totals.demand}
                      </td>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300 font-bold text-center tabular-nums">
                        {totals.ft}
                      </td>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300" />
                      <td className="px-4 py-2.5 border-t-2 border-gray-300 font-bold text-center tabular-nums">
                        {totals.pt}
                      </td>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300" />
                      <td className="px-4 py-2.5 border-t-2 border-gray-300" />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="text-xs text-gray-500 mt-3">
                Tip: sort by clicking column headers (use your table lib) or filter by course ID in the search above
                (if you add a course filter).
              </div>
            </div>
        )}

        {/* Empty state */}
        {!loading && !error && (!data || data.rows.length === 0) && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">No results.</div>
        )}
      </div>
    </div>
  );
}
