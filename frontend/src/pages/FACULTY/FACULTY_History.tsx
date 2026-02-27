// frontend/src/pages/FACULTY/FAC_History.tsx
// Refactored to follow the Student Petition "parallel loads + single POST action" pattern.
// UI kept intact; data now comes from /api/faculty/history (POST) with action switch.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

// Standardized column headers (match FACULTY_Overview List view; minus Syllabus)
// NOTE: History payload only provides a single `time` string; we map it to Begin/End for Day 1 and (if present) Day 2.
const HEADERS = ["Course Code & Title"] as const;

// ---------- tiny utils ----------
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

// Normalize "AY" strings for robust comparisons & query params
const normAy = (s?: string | null) =>
  (s ?? "")
    .replace(/^AY\s+/i, "")
    .replace(/\s*[\u2013\u2014-]\s*/g, "-")
    .trim();

// ---------- types (match backend payload) ----------
type Row = {
  ay: string; // "AY 2024-2025"
  term: "Term 1" | "Term 2" | "Term 3" | string | null;
  code: string;
  title: string;
  section: string;
  units: number | null;
  campus: string | null;
  mode: string | null;
  day1: string | null;
  room1: string | null;
  day2: string | null;
  room2: string | null;
  time: string;
};

const courseKey = (code?: string | null, title?: string | null) =>
  `${(code || "").trim()}||${(title || "").trim()}`.toUpperCase();

// ---------- shared Dropdown (unchanged) ----------
function Dropdown({
  value,
  onChange,
  options,
  className = "w-full",
  placeholder = "— Select an option —",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [hover, setHover] = React.useState(() =>
    Math.max(0, options.findIndex((o) => o === value))
  );
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(
    () => setHover(Math.max(0, options.findIndex((o) => o === value))),
    [value, options]
  );

  React.useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHover((i) => (i + 1) % options.length);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((i) => (i - 1 + options.length) % options.length);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onChange(options[hover] ?? options[0]);
      setOpen(false);
      btnRef.current?.focus();
    }
  };

  return (
    <div className={cls("relative", className)} onKeyDown={onKey}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cls(
          "w-full min-w-0 rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm shadow-sm outline-none",
          "hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30"
        )}
      >
        <span className="block min-w-0 truncate">
          {value || <span className="text-gray-400">{placeholder}</span>}
        </span>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          ▾
        </span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-2 max-h-80 w-full overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg"
        >
          {options.map((opt, i) => (
            <button
              key={opt}
              role="option"
              aria-selected={value === opt}
              onMouseEnter={() => setHover(i)}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls(
                "block w-full px-4 py-3 text-left text-sm",
                i === hover && "bg-emerald-50"
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- component ----------
function HistoryMain({ embedded = false }: { embedded?: boolean } = {}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [ay, setAy] = useState<string>("");
  const [allAys, setAllAys] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // AY options are from loaded data
  const AY_OPTIONS = useMemo(() => {
    if (allAys.length) return allAys;
    const uniq = Array.from(new Set(rows.map((d) => d.ay))).sort().reverse(); // most recent first
    return uniq;
  }, [allAys, rows]);

  // Current AY index + edge checks (for Prev/Next buttons)
  const ayIndex = useMemo(() => AY_OPTIONS.findIndex((o) => o === ay), [AY_OPTIONS, ay]);
  const atFirst = ayIndex <= 0 || AY_OPTIONS.length === 0; // first = most recent
  const atLast = ayIndex === AY_OPTIONS.length - 1 || AY_OPTIONS.length === 0;

  // Jump helpers
  const goPrev = () => {
    // Prev = newer (toward index 0)
    setAy((curr) => {
      const i = AY_OPTIONS.indexOf(curr);
      if (i > 0) return AY_OPTIONS[i - 1];
      return curr || AY_OPTIONS[0] || "";
    });
  };
  const goNext = () => {
    // Next = older (toward end)
    setAy((curr) => {
      const i = AY_OPTIONS.indexOf(curr);
      if (i >= 0 && i < AY_OPTIONS.length - 1) return AY_OPTIONS[i + 1];
      if (i === -1 && AY_OPTIONS.length) return AY_OPTIONS[0]; // safety
      return curr;
    });
  };

  // Resolve userId once (pattern parity with Petition page)
  const userId = React.useMemo(() => {
    try {
      const u = JSON.parse(localStorage.getItem("animo.user") || "null");
      return u?.userId || u?.user_id || null;
    } catch {
      return null;
    }
  }, []);

  // Parallel initial loads: options (AY list) + first page (most recent AY)
  useEffect(() => {
    if (!userId) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        // 1) options (fetch AYs)
        const optRes = await fetch(
          `/api/faculty/history?action=options&userId=${encodeURIComponent(userId)}`,
          {
            method: "POST",
            signal: ctrl.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }
        );
        if (!optRes.ok) throw new Error(`HTTP ${optRes.status}`);
        const optJson = await optRes.json();
        const ays = (optJson?.ays || []) as string[];
        setAllAys(ays);
        if (!ay && ays.length) setAy(ays[0]);
      } catch (e) {
        if ((e as any).name !== "AbortError") {
          console.error("history options load error:", e);
        }
      }
    })();
    return () => ctrl.abort();
  }, [userId]); // Note: 'ay' is intentionally omitted, it's set here.

  // This effect now runs ONCE on load (or when userId is found)
  // It fetches ALL teaching history.
  // The 'filtered' memo below will handle filtering by AY and query.
  useEffect(() => {
    const run = async () => {
      setLoading(true);
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const params = new URLSearchParams();

        // MODIFICATION:
        // We no longer send 'ay' or 'q' to the backend here.
        // We fetch ALL rows, and let the 'filtered' memo handle
        // client-side filtering for 'ay' and 'q'.

        params.set("action", "fetch");
        params.set("userId", String(userId || ""));

        const res = await fetch(`/api/faculty/history?${params.toString()}`, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}), // single-call submit pattern parity
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const data: Row[] = (json?.rows || []) as Row[];

        const norm = data.map((r) => ({
          ay: r.ay ?? "AY —",
          term: (r.term as any) ?? "Term 1",
          code: r.code ?? "",
          title: r.title ?? "",
          section: r.section ?? "",
          units:
            typeof r.units === "number"
              ? r.units
              : r.units
                ? Number(r.units)
                : null,
          campus: r.campus ?? null,
          mode: r.mode ?? null,
          day1: r.day1 ?? null,
          room1: r.room1 ?? null,
          day2: r.day2 ?? null,
          room2: r.room2 ?? null,
          time: r.time ?? "",
        }));
        setRows(norm);
      } catch (e) {
        if ((e as any).name !== "AbortError") {
          console.error("teaching-history fetch error:", e);
          setRows([]);
        }
      } finally {
        setLoading(false);
      }
    };

    if (userId) run();
  }, [userId]); // MODIFICATION: Only depends on userId now.

  // Client-side filter (fast)
  // This memo now filters the complete 'rows' array based on
  // the currently selected 'ay' and 'query' state.
  const filtered = useMemo(() => {
    let r = rows;

    // 1. Filter by Academic Year
    if (ay) {
      const wanted = normAy(ay);
      r = r.filter((x) => normAy(x.ay) === wanted);
    }

    // 2. Filter by Search Query
    const q = query.trim().toLowerCase();
    if (!q) return r; // Return AY-filtered list if no query

    // Return AY-filtered list that also matches query
    return r.filter((x) =>
      [
        x.code,
        x.title,
        x.section,
        x.campus ?? "",
        x.mode ?? "",
        x.day1 ?? "",
        x.room1 ?? "",
        x.day2 ?? "",
        x.room2 ?? "",
        x.time,
        x.term ?? "",
        x.ay,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [rows, ay, query]); // This logic is correct and unchanged

  // This logic is also correct and unchanged
  const allTimeCounts = useMemo(() => {
    const map: Record<string, { code: string; title: string; totalCount: number }> =
      {};
    rows.forEach((r) => {
      const code = (r.code || "").trim();
      const title = (r.title || "").trim();
      const key = courseKey(code, title);
      if (!map[key]) map[key] = { code, title, totalCount: 0 };
      map[key].totalCount += 1;
    });
    return map;
  }, [rows]);

  const mostTaught = useMemo(() => {
    return Object.values(allTimeCounts)
      .filter((x) => (x.code || "").trim() || (x.title || "").trim())
      .sort((a, b) => {
        if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
        return (a.code || "").localeCompare(b.code || "");
      })
      // Show only the top 1 most taught course
      .slice(0, 1);
  }, [allTimeCounts]);

  // Aggregate to "what you've taught" (per term) + analytics (counts)
  const termCourses = useMemo(() => {
    const byTerm: Record<
      string,
      { key: string; code: string; title: string; termCount: number; totalCount: number }[]
    > = { "Term 1": [], "Term 2": [], "Term 3": [] };

    const acc: Record<
      string,
      Record<
        string,
        { key: string; code: string; title: string; termCount: number; totalCount: number }
      >
    > = { "Term 1": {}, "Term 2": {}, "Term 3": {} };

    filtered.forEach((r) => {
      const termKey = (r.term as string) || "Term 1";
      const code = (r.code || "").trim();
      const title = (r.title || "").trim();
      const key = courseKey(code, title);
      const totalCount = allTimeCounts[key]?.totalCount ?? 0;

      if (!acc[termKey]) acc[termKey] = {};
      if (!acc[termKey][key]) {
        acc[termKey][key] = { key, code, title, termCount: 0, totalCount };
      }
      acc[termKey][key].termCount += 1;
    });

    (Object.keys(acc) as (keyof typeof acc)[]).forEach((t) => {
      byTerm[t] = Object.values(acc[t]).sort((a, b) => {
        // higher-termCount first, then code
        if (b.termCount !== a.termCount) return b.termCount - a.termCount;
        return (a.code || "").localeCompare(b.code || "");
      });
    });

    return byTerm;
  }, [filtered, allTimeCounts]);

  return (
    <section className={cls("mx-auto w-full", embedded ? "" : "max-w-screen-2xl px-4")}>
      <div
        className={cls(
          embedded ? "" : "rounded-xl border border-gray-200 bg-white p-5",
          embedded ? "" : ""
        )}
      >
        {/* Header (hide in embedded mode; parent card already provides context) */}
        {!embedded && (
          <div className="mb-4">
            <h3 className="text-lg font-bold text-gray-900">Teaching History</h3>
            <p className="text-sm text-gray-500">
              Complete record of your teaching assignments
            </p>
          </div>
        )}

        {/* Filters */}
        <div
          className={cls(
            "flex w-full flex-col gap-3 sm:flex-row sm:items-center",
            embedded ? "" : "mb-2"
          )}
        >
          <div className="w-full sm:flex-1">
            <div className="relative flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm">
              <Search className="h-4 w-4 text-gray-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by course name…"
                className="w-full bg-transparent outline-none placeholder:text-gray-400 pr-6"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="absolute right-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-400 hover:text-gray-600"
                  title="Clear"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* AY dropdown with Prev (left) / Next (right) controls */}
          <div className="w-full sm:w-[360px] md:w-[420px]">
            <div className="grid w-full grid-cols-1 items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
            <button
              type="button"
              onClick={goPrev}
              disabled={atFirst}
              className={`shrink-0 w-full sm:w-auto whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold ${
                atFirst
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a4a]"
              }`}
            >
              ‹ Prev AY
            </button>

            <div className="min-w-0 w-full">
              <Dropdown
                value={ay}
                onChange={setAy}
                options={AY_OPTIONS}
                placeholder="Select academic year"
                className="w-full"
              />
            </div>

            <button
              type="button"
              onClick={goNext}
              disabled={atLast}
              className={`shrink-0 w-full sm:w-auto whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold ${
                atLast
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a4a]"
              }`}
            >
              Next AY ›
            </button>
            </div>
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className={cls("mt-2 text-xs text-gray-500", embedded ? "" : "mb-4")}>
            Loading teaching history…
          </div>
        )}

        {/* Insights (kept intentionally minimal + high-signal) */}
        {rows.length > 0 && (
          <div className={cls("grid grid-cols-1 gap-4", embedded ? "mt-4" : "mb-6")}>
            <div
            className={cls(
              "rounded-xl border p-4 shadow-sm ring-1",
              embedded
                ? "border-emerald-200 bg-emerald-50 ring-emerald-200"
                : "border-emerald-300 bg-emerald-50 ring-emerald-300"
            )}
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Most taught course
              </div>
              <div className="mt-3 space-y-2">
                {mostTaught.length === 0 ? (
                  <div className="text-sm text-gray-500">No records.</div>
                ) : (
                  mostTaught.map((c) => (
                    <div
                      key={courseKey(c.code, c.title)}
                      className="flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-900">{c.code || "—"}</div>
                        <div className="mt-0.5 line-clamp-1 text-[12px] text-gray-600">
                          {c.title || "—"}
                        </div>
                      </div>
                      <div className="shrink-0">
                        <div className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-semibold text-gray-700">
                          {c.totalCount} sections
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Term sections */}
        <div className={cls("space-y-6", embedded ? "mt-4" : "")}>
          {(["Term 1", "Term 2", "Term 3"] as const).map((t) => (
            <div key={t} className="rounded-xl border border-gray-200">
              {/* Term title */}
              <div className="px-4 py-3 text-sm font-semibold text-slate-700">{t}</div>

              {/* Table */}
              <div className="overflow-x-auto">
                <div className="overflow-hidden rounded-xl bg-white">
                  <table className="min-w-full table-fixed border-t border-gray-200 text-[13px]">
                    <colgroup>
                      <col className="w-full" />
                    </colgroup>

                    <thead className="bg-gray-50 text-gray-700">
                      <tr className="[&>th]:border-b [&>th]:border-gray-200">
                        {HEADERS.map((h) => (
                          <th key={h} className="px-4 py-3 text-left font-semibold">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>

                    <tbody className="text-gray-900">
                      {(termCourses[t] ?? []).length === 0 ? (
                        <tr>
                          <td className="px-4 py-6 text-center text-sm text-gray-500">
                            {loading ? "Loading…" : "No records."}
                          </td>
                        </tr>
                      ) : (
                        termCourses[t].map((c, i) => (
                          <tr
                            key={`${t}-${c.key}`}
                            className={cls(
                              i % 2 === 0 ? "bg-white" : "bg-gray-50",
                              "[&>td]:border-t [&>td]:border-gray-100"
                            )}
                          >
                            <td className="px-4 py-3 align-middle">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="font-semibold text-gray-900">{c.code || "—"}</div>
                                  <div className="mt-0.5 line-clamp-2 text-[12px] text-gray-600">
                                    {c.title || "—"}
                                  </div>
                                </div>

                                <div className="shrink-0 text-right">
                                  <div className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                                    This term: {c.termCount}
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- export content-only for Overview tab ----------
export function HistoryContent() {
  return <HistoryMain />;
}
export default HistoryMain;
