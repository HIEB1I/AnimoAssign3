import type { FormEvent } from "react";
import { useState } from "react";
import type { RecordItem } from "../api";
import { searchRecords } from "../api";

export default function SearchRecordsPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecordItem[]>([]);
  const [count, setCount] = useState(0);
  const [isSearching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearching(true);
    setError(null);

    try {
      const response = await searchRecords(query);
      setResults(response.items);
      setCount(response.count);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <h1>Search Records</h1>
        <p>Query the backend service for matching records.</p>
      </header>

      <form className="card form" onSubmit={handleSearch}>
        <label className="form__field">
          <span>Search phrase</span>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. prod, analytics, rollout"
          />
        </label>
        <button className="button" type="submit" disabled={isSearching}>
          {isSearching ? "Searching..." : "Search"}
        </button>
        {error && <p className="form__status form__status--error">{error}</p>}
        <p className="form__hint">Showing {count} result{count === 1 ? "" : "s"}.</p>
      </form>

      <section className="results">
        {results.length === 0 && <p className="results__empty">No records yet.</p>}
        {results.map((item) => (
          <article className="card results__item" key={item.id}>
            <h3>{item.title}</h3>
            <time>{new Date(item.createdAt).toLocaleString()}</time>
            <p>{item.content}</p>
          </article>
        ))}
      </section>
    </div>
  );
}