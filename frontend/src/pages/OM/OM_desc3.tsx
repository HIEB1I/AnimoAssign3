import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchDeloadingsByTerm } from "../../api";

type Row = {
  faculty_name?: string;
  deloading_type?: string;
  units_deloaded?: number;
  approval_status?: string;
  term_id?: string;
  updated_at?: string | Date;
};

type TermLite = {
  term_id: string;
  acad_year_start: number;
  term_number: number;
  is_current?: boolean;
};

type Payload = {
  term: TermLite | null;
  rows: Row[];
  has_prev: boolean;
  has_next: boolean;
  terms?: TermLite[];
  current_index?: number;
};

export default function OM_DescPage3() {
  const [data, setData] = useState<Payload | null>(null);
  const [terms, setTerms] = useState<TermLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(direction: "current" | "next" | "prev" = "current", anchor?: string) {
    try {
      setLoading(true);
      setError("");
      const res = await fetchDeloadingsByTerm(anchor ?? data?.term?.term_id, direction);
      setData(res);
      if (Array.isArray(res.terms)) setTerms(res.terms);
    } catch (err: any) {
      setError(err?.message || "Failed to load.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load("current");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const termLabel = data?.term
    ? `AY ${data.term.acad_year_start} • Term ${data.term.term_number}${data.term.is_current ? " (Current)" : ""
    }`
    : "—";

  return (
    <div
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        justifyContent: "space-between",
      }}
    >
      {/* Header */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <h1>Deloading Utilization Report</h1>
          <Link to="/om/home">← Back</Link>
        </div>

        {error && <div style={{ color: "red", marginBottom: 8 }}>{error}</div>}
        {loading && <div>Loading…</div>}

        {!loading && (!data || data.rows.length === 0) && (
          <p
            style={{
              textAlign: "center",
              color: "red",
              fontWeight: 600,
              marginTop: 40,
            }}
          >
            No deloadings recorded for this term.
          </p>
        )}

        {!loading && !!data?.rows?.length && (
          <table
            border={1}
            cellPadding={6}
            style={{
              width: "100%",
              borderCollapse: "collapse",
              marginBottom: 24,
            }}
          >
            <thead>
              <tr>
                <th>Faculty Name</th>
                <th>Deloading Type</th>
                <th>Units</th>
                <th>Status</th>
                <th>Term</th>
                <th>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows?.map((r, i) => (
                <tr key={i}>
                  <td>{r.faculty_name || "—"}</td>
                  <td>{r.deloading_type || "—"}</td>
                  <td>{r.units_deloaded ?? "—"}</td>
                  <td>{r.approval_status || "—"}</td>
                  <td>
                    {(() => {
                      const match = terms.find((t) => t.term_id === (r.term_id || data?.term?.term_id));
                      return match ? `Term ${match.term_number}` : "—";
                    })()}
                  </td>
                  <td>{r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer Navigation */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 8,
          alignItems: "center",
          marginTop: 20,
          padding: "10px 0",
          borderTop: "1px solid #d1d5db",
        }}
      >
        <button
          onClick={() => load("prev")}
          disabled={!data?.has_prev || loading}
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid #9ca3af",
          }}
        >
          ← Prev
        </button>

        <select
          value={data?.term?.term_id || ""}
          onChange={(e) => load("current", e.target.value)}
          disabled={loading}
          style={{
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid #9ca3af",
          }}
        >
          {terms.map((t) => (
            <option key={t.term_id} value={t.term_id}>
              {`AY ${t.acad_year_start} • Term ${t.term_number}${t.is_current ? " (Current)" : ""
                }`}
            </option>
          ))}
        </select>

        <button
          onClick={() => load("next")}
          disabled={!data?.has_next || loading}
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid #9ca3af",
          }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
