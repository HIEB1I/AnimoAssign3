import { useEffect, useState } from "react";
import type { AnalyticsSummary } from "../api";
import { fetchAnalyticsSummary } from "../api";


export default function AnalyticsPage() {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetchAnalyticsSummary();
        setSummary(response);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load analytics");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  return (
    <div className="page">
      <header className="page__header">
        <h1>Analytics Overview</h1>
        <p>Insights computed by the analytics service.</p>
      </header>

      {isLoading && <p>Loading analytics...</p>}
      {error && <p className="form__status form__status--error">{error}</p>}

      {summary && (
        <div className="analytics-grid">
          <section className="card">
            <h2>Total Records</h2>
            <p className="metric">{summary.totalRecords}</p>
            <p className="metric__detail">Generated at {new Date(summary.generatedAt).toLocaleString()}</p>
          </section>

          <section className="card">
            <h2>Top Terms</h2>
            {summary.topTerms.length === 0 ? (
              <p className="metric__detail">No terms recorded yet.</p>
            ) : (
              <ol className="list">
                {summary.topTerms.map((item) => (
                  <li key={item.term}>
                    <span>{item.term}</span>
                    <span className="badge">{item.count}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card">
            <h2>Daily Ingest</h2>
            {summary.dailyIngest.length === 0 ? (
              <p className="metric__detail">No daily activity recorded yet.</p>
            ) : (
              <ul className="list list--stacked">
                {summary.dailyIngest.map((item) => (
                  <li key={item.date}>
                    <span>{item.date}</span>
                    <span className="badge">{item.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );

  {error && (
  <div className="form__status form__status--error">
    <p>{error}</p>
    <button onClick={() => { setError(null); setLoading(true); fetchAnalyticsSummary().then(setSummary).catch(e => setError(e.message)).finally(() => setLoading(false)); }}>
      Retry
    </button>
  </div>
)}

}