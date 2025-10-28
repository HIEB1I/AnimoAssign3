import React, { useState } from "react";
import { Link } from "react-router-dom";
import { fetchDeloadingUtilization } from "../../api";

export default function OM_DescPage3() {
  const [term, setTerm] = useState("");
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSearch() {
    try {
      setLoading(true);
      setError("");
      const res = await fetchDeloadingUtilization(term);
      setData(res.rows || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <h1>Deloading Utilization Report</h1>
        <Link to="/om/home">← Back</Link>
      </div>

      <div style={{ marginBottom: 12 }}>
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Enter term (optional)"
          style={{ marginRight: 8 }}
        />
        <button onClick={handleSearch} disabled={loading}>
          {loading ? "Loading..." : "Search"}
        </button>
      </div>

      {error && <div style={{ color: "red" }}>{error}</div>}

      {data.length === 0 && !loading && <p>No results yet.</p>}

      {data.length > 0 && (
        <table border={1} cellPadding={6}>
          <thead>
            <tr>
              <th>Faculty Name</th>
              <th>Deloading Type</th>
              <th>Units</th>
              <th>Status</th>
              <th>Start Term</th>
              <th>End Term</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => (
              <tr key={i}>
                <td>{r.faculty_name}</td>
                <td>{r.deloading_type}</td>
                <td>{r.units_deloaded}</td>
                <td>{r.approval_status}</td>
                <td>{r.start_term}</td>
                <td>{r.end_term}</td>
                <td>{r.updated_at ? new Date(r.updated_at).toLocaleString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
