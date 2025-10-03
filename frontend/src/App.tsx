import { useEffect, useState } from "react";
import { fetchAssignments, fetchAssignmentTotals } from "./api";
import "./App.css";

type Assignment = {
  _id: string;
  title: string;
  status: string;
};

type TotalsRow = { _id: string; count: number };

type Totals = {
  results: TotalsRow[];
};

const statusLabels: Record<string, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

function StatusPill({ status }: { status: string }) {
  return <span className={`status ${status}`}>{statusLabels[status] ?? status}</span>;
}

export default function App() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [totals, setTotals] = useState<Totals>({ results: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
            : "Failed to load analytics and assignment data"
        );
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  return (
    <div className="app">
      <header>
        <h1>AnimoAssign</h1>
        <p>Track deliverables and monitor completion trends in one place.</p>
      </header>

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
          <strong>Heads up:</strong> {error}. Make sure all containers are healthy
          in `docker compose -f docker/docker-compose.local.yml ps`.
        </div>
      )}
    </div>
  );
}