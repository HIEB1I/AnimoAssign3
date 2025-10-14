import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchAnalyticsSummary } from "../api";

export default function AnalyticsPage() {
  const [summary, setSummary] = useState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await fetchAnalyticsSummary();
        setSummary(data);
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load analytics summary. Check analytics service logs.",
        );
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  const statusBreakdown = summary?.statusBreakdown ?? [];

  return (
    <div className="page analytics-page">
      <header className="page-header">
        <div>
          <h1>Analytics</h1>
          <p>Review aggregate metrics calculated by the analytics service.</p>
        </div>
        <Link className="button secondary" to="/">
          Back to dashboard
        </Link>
      </header>

      {loading && <p>Loading analytics…</p>}
      {error && <p className="error">{error}</p>}

      {!loading && !error && summary && (
        <>
          <section className="cards analytics-cards">
            <article className="card highlight">
              <h2>Total assignments</h2>
              <p className="metric">{summary.totalAssignments}</p>
              <small>Calculated at {new Date(summary.generatedAt).toLocaleString()}</small>
            </article>
            <article className="card">
              <h2>Stored diagnostic events</h2>
              <p className="metric">{summary.diagnosticEventsStored}</p>
              <small>Events recorded via the connectivity tester</small>
            </article>
          </section>

          <section className="card analytics-breakdown">
            <h2>Status breakdown</h2>
            {statusBreakdown.length === 0 ? (
              <p>No assignment analytics available yet.</p>
            ) : (
              <ul>
                {statusBreakdown.map((row) => (
                  <li key={row.status}>
                    <div className="breakdown-labels">
                      <span>{row.label}</span>
                      <span>{row.count}</span>
                    </div>
                    <div className="breakdown-bar" aria-hidden>
                      <span style={{ width: `${row.percentage}%` }} />
                    </div>
                    <small>{row.percentage.toFixed(1)}% of assignments</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}