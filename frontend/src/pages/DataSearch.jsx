import { useState } from "react";
import { Link } from "react-router-dom";
import { searchAssignments } from "../api";

export default function DataSearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);

  async function handleSearch(event) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const response = await searchAssignments(query);
      setResults(response.items ?? []);
    } catch (err) {
      console.error(err);
      setResults([]);
      setError(
        err instanceof Error
          ? err.message
          : "Search failed. Please try again or check backend logs.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page data-search-page">
      <header className="page-header">
        <div>
          <h1>Data Search</h1>
          <p>Look up assignments stored in MongoDB via the backend service.</p>
        </div>
        <Link className="button secondary" to="/">
          Back to dashboard
        </Link>
      </header>

      <form className="search-form" onSubmit={handleSearch}>
        <label htmlFor="search-query" className="sr-only">
          Search assignments
        </label>
        <input
          id="search-query"
          type="search"
          placeholder="Search by title or leave blank to list all assignments"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {!loading && hasSearched && results.length === 0 && !error && (
        <p className="empty-state">No assignments found for your search.</p>
      )}

      {results.length > 0 && (
        <section className="table-list">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {results.map((item) => (
                <tr key={item._id}>
                  <td>{item.title}</td>
                  <td>{item.status}</td>
                  <td>{item.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}