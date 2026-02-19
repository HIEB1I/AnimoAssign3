import { useEffect, useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import SelectBox from "../../component/SelectBox";
import { API_BASE } from "../../api";

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

type Row = {
  deloading_type?: string;
  units_deloaded?: number;
  notes?: string;
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
  current_index?: number | null;
};

function getUserId(): string | null {
  try {
    const u = JSON.parse(localStorage.getItem("animo.user") || "null");
    return u?.userId || null;
  } catch {
    return null;
  }
}

export default function FACULTY_Deloadings({ embedded = false }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<Payload | null>(null);
  const [terms, setTerms] = useState<TermLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function labelOf(t: TermLite) {
    const ayEnd = t.acad_year_start + 1;
    return `AY ${t.acad_year_start}–${ayEnd} • Term ${t.term_number}${t.is_current ? " (Current)" : ""}`;
  }

  const currentLabel = useMemo(
    () => (data?.term ? labelOf(data.term) : ""),
    [data?.term]
  );
  const termLabels = useMemo(() => terms.map(labelOf), [terms]);

  async function load(direction: "current" | "next" | "prev" = "current", anchor?: string) {
    const userId = getUserId();
    if (!userId) {
      setError("You are not logged in.");
      return;
    }
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      params.set("userId", userId);
      if (anchor) params.set("anchor_term_id", anchor);
      if (direction) params.set("direction", direction);
      const url = `${API_BASE.replace(/\/+$/, "")}/faculty/deloadings?${params.toString()}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
      const res: Payload = await r.json();
      setData(res);
      if (Array.isArray(res.terms)) setTerms(res.terms);
    } catch (e: any) {
      setError(e?.message || "Failed to load.");
    } finally {
      setLoading(false);
    }
  }

  const onSelectTerm = (label: string) => {
    const idx = termLabels.indexOf(label);
    if (idx >= 0 && terms[idx]) {
      load("current", terms[idx].term_id);
    }
  };

  useEffect(() => {
    // initial load
    load("current");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={cls("w-full", embedded ? "" : "px-8 py-8")}>
      {!embedded && (
        <>
          <h1 className="text-2xl font-bold mb-1">My Deloadings</h1>
          <p className="text-sm text-gray-600 mb-6">
            View your deloading records by term.
          </p>
        </>
      )}

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* Top controls */}
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-gray-200">
          {!embedded && (
            <Link
              to="/faculty/overview"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
              aria-label="Back"
              title="Back"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>Back</span>
            </Link>
          )}

          <div className="flex items-center gap-2 flex-1 min-w-[320px] justify-end">
            <button
              onClick={() => load("prev")}
              disabled={!data?.has_prev || loading}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                !data?.has_prev || loading
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
              }`}
              title="Previous term"
            >
              ← Prev
            </button>

            <div className="min-w-[260px]">
              <SelectBox
                value={currentLabel}
                onChange={onSelectTerm}
                options={termLabels}
              />
            </div>

            <button
              onClick={() => load("next")}
              disabled={!data?.has_next || loading}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                !data?.has_next || loading
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
              }`}
              title="Next term"
            >
              Next →
            </button>
          </div>
        </div>

        {/* Messages */}
        {error && (
          <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
            {error}
          </div>
        )}
        {loading && <div className="px-4 py-4 text-sm text-gray-500">Loading…</div>}

        {/* Empty state */}
        {!loading && (!data || data.rows.length === 0) && !error && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No deloadings recorded for this term.
          </div>
        )}

        {/* Results */}
        {!loading && !!data?.rows?.length && (
          <div className="p-4">
            <div className="text-sm text-gray-600 mb-3">
              Viewing{" "}
              <span className="font-semibold text-gray-900">
                {data?.term
                  ? `AY ${data.term.acad_year_start}–${data.term.acad_year_start + 1} • Term ${data.term.term_number}`
                  : "—"}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full table-fixed text-sm border-t border-gray-200">
                <colgroup>
                  <col style={{ width: "28%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "40%" }} />
                  <col style={{ width: "20%" }} />
                </colgroup>
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                  <tr>
                    {["Deloading Type", "Units", "Notes", "Last Updated"].map((h) => (
                      <th key={h} className="px-3 py-2 text-center font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr
                      key={`${r.deloading_type}-${i}`}
                      className={i % 2 === 0 ? "bg-white text-gray-800" : "bg-gray-50 text-gray-800"}
                    >
                      <td className="px-3 py-2 text-center">{r.deloading_type || "—"}</td>
                      <td className="px-3 py-2 text-center">{r.units_deloaded ?? "—"}</td>
                      <td className="px-3 py-2 text-center">{r.notes || "—"}</td>
                      <td className="px-3 py-2 text-center">
                        {r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
