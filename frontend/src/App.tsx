import { useEffect, useState } from "react";
import { fetchAssignments, fetchAssignmentTotals } from "./api";
import "./App.css";

type Assignment = {
  _id: string;
  title: string;
  status: string;
};

type Totals = {
  results: { _id: string; count: number }[];
};

function App() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [totals, setTotals] = useState<Totals>({ results: [] });
  const [error, setError] = useState<string | null>(null);

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
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    }

    load();
  }, []);

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  return (
    <main>
      <h1>AnimoAssign Dashboard</h1>
      <section>
        <h2>Assignments</h2>
        <ul>
          {assignments.map((assignment) => (
            <li key={assignment._id}>
              <strong>{assignment.title}</strong> – {assignment.status}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Assignment Totals</h2>
        <ul>
          {totals.results.map((item) => (
            <li key={item._id}>
              {item._id}: {item.count}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

export default App;