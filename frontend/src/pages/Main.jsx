import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchAssignments,
  fetchAssignmentTotals,
  runConnectivityTest,
} from "../api";

const statusLabels = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

const serviceLabels = {
  backend: "Backend API",
  mongodb: "MongoDB",
  analytics: "Analytics Service",
};

function StatusPill({ status }) {
  return <span className={`status ${status}`}>{statusLabels[status] ?? status}</span>;
}

export default function MainPage() {
  const [assignments, setAssignments] = useState([]);
  const [totals, setTotals] = useState({ results: [] });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [testPayload, setTestPayload] = useState({
    title: "Connectivity test assignment",
    status: "todo",
    notes: "",
  });
  const [testResults, setTestResults] = useState();
  const [testSummary, setTestSummary] = useState();
  const [testError, setTestError] = useState(null);
  const [testRunning, setTestRunning] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [assignmentData, totalsData] = await Promise.all([
          fetchAssignments(),
          fetchAssignmentTotals(),
        ]);
        setAssignments(assignmentData.items ?? []);
        setTotals(totalsData);
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load analytics and assignment data",
        );
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  const sanitizedPayload = useMemo(() => {
    const payload = {
      title: testPayload.title.trim(),
      status: testPayload.status,
    };

    if (testPayload.notes && testPayload.notes.trim().length > 0) {
      payload.notes = testPayload.notes.trim();
    }

    return payload;
  }, [testPayload]);

  async function handleRunDiagnostics(event) {
    event.preventDefault();
    setTestRunning(true);
    setTestError(null);

    try {
      const response = await runConnectivityTest(sanitizedPayload);
      setTestResults(response.services);
      setTestSummary({
        latencyMs: response.latencyMs,
        timestamp: response.timestamp,
        echo: response.echo,
      });
    } catch (err) {
      console.error(err);
      setTestResults(undefined);
      setTestSummary(undefined);
      setTestError(
        err instanceof Error
          ? err.message
          : "Connectivity test failed. Please check service logs.",
      );
    } finally {
      setTestRunning(false);
    }
  }

  const serviceStatuses = testResults ?? [];
  const isPayloadValid = sanitizedPayload.title.length > 0;

  return (
    <div className="page main-page">
      <header className="page-header">
        <div>
          <h1>AnimoAssign</h1>
          <p>Track deliverables and monitor completion trends in one place.</p>
        </div>
        <div className="page-actions">
          <Link className="button secondary" to="/search">
            Go to Data Search
          </Link>
          <Link className="button secondary" to="/analytics">
            View Analytics
          </Link>
        </div>
      </header>

      <section className="diagnostics">
        <article className="card diagnostic-card">
          <h2>Service connectivity</h2>
          <p>
            Send sample assignment data through the backend to confirm each service can
            communicate with one another.
          </p>

          <form className="diagnostic-form" onSubmit={handleRunDiagnostics}>
            <div className="form-row">
              <label htmlFor="test-title">Sample title</label>
              <input
                id="test-title"
                type="text"
                required
                value={testPayload.title ?? ""}
                onChange={(event) =>
                  setTestPayload((previous) => ({
                    ...previous,
                    title: event.target.value,
                  }))
                }
                placeholder="Connectivity test assignment"
              />
            </div>

            <div className="form-row">
              <label htmlFor="test-status">Status</label>
              <select
                id="test-status"
                value={testPayload.status}
                onChange={(event) =>
                  setTestPayload((previous) => ({
                    ...previous,
                    status: event.target.value,
                  }))
                }
              >
                {Object.entries(statusLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <label htmlFor="test-notes">Notes (optional)</label>
              <textarea
                id="test-notes"
                value={testPayload.notes ?? ""}
                onChange={(event) =>
                  setTestPayload((previous) => ({
                    ...previous,
                    notes: event.target.value,
                  }))
                }
                placeholder="Describe what you're testing or why."
                rows={3}
              />
            </div>

            <button type="submit" disabled={testRunning || !isPayloadValid}>
              {testRunning ? "Running diagnostics…" : "Run connectivity test"}
            </button>
          </form>

          {testError && <p className="diagnostic-error">{testError}</p>}

          {serviceStatuses.length > 0 && (
            <div className="diagnostic-results">
              <div className="service-status-grid">
                {serviceStatuses.map((service) => (
                  <article
                    key={service.service}
                    className={`service-status ${service.ok ? "ok" : "fail"}`}
                    aria-live="polite"
                  >
                    <header>
                      <span className="status-indicator" aria-hidden>
                        {service.ok ? "●" : "▲"}
                      </span>
                      <span className="service-name">
                        {serviceLabels[service.service] ?? service.service}
                      </span>
                    </header>
                    <p>{service.detail}</p>
                    {typeof service.latencyMs === "number" && (
                      <small>Response time: {service.latencyMs.toFixed(2)} ms</small>
                    )}
                  </article>
                ))}
              </div>

              {testSummary && (
                <footer className="diagnostic-meta">
                  <div>
                    <strong>Last run:</strong>{" "}
                    {new Date(testSummary.timestamp).toLocaleString()}
                  </div>
                  <div>
                    <strong>Total round trip:</strong> {testSummary.latencyMs.toFixed(2)} ms
                  </div>
                  <div className="echo">
                    <strong>Echoed data:</strong> {testSummary.echo.title} •{" "}
                    {statusLabels[testSummary.echo.status] ?? testSummary.echo.status}
                    {testSummary.echo.notes ? ` — ${testSummary.echo.notes}` : ""}
                  </div>
                </footer>
              )}
            </div>
          )}
        </article>
      </section>

      <section className="cards">
        <article className="card">
          <h2>Assignments by status</h2>
          {totals.results.length === 0 ? (
            <p>No analytics available yet.</p>
          ) : (
            <table>
              <tbody>
                {totals.results.map((row) => (
                  <tr key={row._id}>
                    <th scope="row">{statusLabels[row._id] ?? row._id}</th>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </section>

      <section className="table-list">
        <table>
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((assignment) => (
              <tr key={assignment._id}>
                <td>{assignment.title}</td>
                <td>
                  <StatusPill status={assignment.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {loading && <p>Loading dashboard…</p>}
      {error && (
        <div className="error">
          <strong>Heads up:</strong> {error}. Make sure all containers are healthy in
          `docker compose -f docker/docker-compose.local.yml ps`.
        </div>
      )}
    </div>
  );
}
