import { Link } from "react-router-dom";

export default function LandingPage() {
  return (
    <div className="page">
      <header className="page__header">
        <h1>Service Mesh Demo</h1>
        <p className="page__subtitle">
          Minimal interface proving connectivity between the backend and analytics
          services running in prod S1 and prod S2.
        </p>
      </header>

      <section className="card-grid">
        <article className="card">
          <h2>Submit Records CICD TEST 1.4</h2>
          <p>Send a new record through the backend service and persist it in MongoDB.</p>
          <Link className="button" to="/submit">
            Create a record
          </Link>
        </article>

        <article className="card">
          <h2>Search Records</h2>
          <p>Query the backend for records that match a search phrase.</p>
          <Link className="button" to="/search">
            Find records
          </Link>
        </article>

        <article className="card">
          <h2>Analytics Overview</h2>
          <p>Review counts, top terms, and daily ingests computed by the analytics service.</p>
          <Link className="button" to="/analytics">
            View analytics
          </Link>
        </article>
      </section>
    </div>
  );
}
