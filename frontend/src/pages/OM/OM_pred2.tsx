// frontend/src/pages/OM/OM_pred2.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPTRisk } from "../../api";

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

export default function OM_PredPage2() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PTResponse | null>(null);

  // knobs
  const [departmentId, setDepartmentId] = useState("DEPT0001");
  const [overload, setOverload] = useState(0);
  const [histK, setHistK] = useState(3);
  const [onlyWithPrefs, setOnlyWithPrefs] = useState(false);
  const [allowFallback, setAllowFallback] = useState(false);

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
    <div style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Predictive Report — PT Risk (v3)</h1>
        <Link to="/om/home">← Back to OM Home</Link>
      </div>

      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          alignItems: "end",
          border: "1px solid #eee",
          padding: 12,
          borderRadius: 12,
          background: "#fafafa",
        }}
      >
        <div>
          <label>Department</label>
          <input
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            placeholder="DEPT0001"
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <label>Overload allowance (units)</label>
          <select value={overload} onChange={(e) => setOverload(Number(e.target.value))} style={{ width: "100%" }}>
            <option value={0}>0</option>
            <option value={3}>3</option>
          </select>
        </div>
        <div>
          <label>History window (terms)</label>
          <input
            type="number"
            min={1}
            max={6}
            value={histK}
            onChange={(e) => setHistK(Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <label>
            <input type="checkbox" checked={onlyWithPrefs} onChange={(e) => setOnlyWithPrefs(e.target.checked)} /> Only
            FT with previous-term preferences
          </label>
        </div>
        <div>
          <label>
            <input type="checkbox" checked={allowFallback} onChange={(e) => setAllowFallback(e.target.checked)} /> Allow
            demand fallback if no sections
          </label>
        </div>
        <div>
          <button disabled={loading} onClick={load} style={{ width: "100%" }}>
            {loading ? "Loading…" : "Run"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: "#b00020", background: "#ffecec", border: "1px solid #ffd0d0", padding: 12, borderRadius: 8 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          <div
            style={{
              display: "flex",
              gap: 16,
              alignItems: "center",
              border: "1px solid #eee",
              padding: 12,
              borderRadius: 12,
            }}
          >
            <div><strong>Term:</strong> {data.term_id}</div>
            <div><strong>Dept:</strong> {data.department_id}</div>
            <div><strong>Generated:</strong> {new Date(data.generated_at).toLocaleString()}</div>
            <div style={{ marginLeft: "auto" }}>
              <strong>Summary:</strong> PT Sections = {data.summary.total_pt_sections} | Est. PT Hires = {data.summary.estimated_pt_hires}
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Course</th>
                  <th style={th}>Demand (secs)</th>
                  <th style={th}>FT Filled (secs)</th>
                  <th style={th}>FT Assignees</th>
                  <th style={th}>PT Needed</th>
                  <th style={th}>Risk</th>
                  <th style={th}>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.course_id}>
                    <td style={td}>{r.course_code}</td>
                    <td style={tdCenter}>{r.demand_sections}</td>
                    <td style={tdCenter}>{r.ft_filled_sections}</td>
                    <td style={td}>
                      {r.ft_assignees && r.ft_assignees.length
                        ? r.ft_assignees.map((n, i) => <div key={i}>{n}</div>)
                        : "—"}
                    </td>
                    <td style={tdCenter}><b>{r.pt_needed_sections}</b></td>
                    <td style={td}>{r.risk}</td>
                    <td style={td}>{r.confidence}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={tf}>TOTAL</td>
                  <td style={tfCenter}>{totals.demand}</td>
                  <td style={tfCenter}>{totals.ft}</td>
                  <td style={tfCenter}><b>{totals.pt}</b></td>
                  <td style={tf}></td>
                  <td style={tf}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px", background: "#f7f7f7" };
const td: React.CSSProperties = { borderBottom: "1px solid #eee", padding: "8px 6px" };
const tdCenter: React.CSSProperties = { ...td, textAlign: "center" };
const tf: React.CSSProperties = { padding: "10px 6px", borderTop: "2px solid #ccc", fontWeight: 700 };
const tfCenter: React.CSSProperties = { ...tf, textAlign: "center" };
