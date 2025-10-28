// frontend/src/pages/FACULTY/FAC_History.tsx
// Refactored to follow the Student Petition "parallel loads + single POST action" pattern.
// UI kept intact; data now comes from /api/faculty/history (POST) with action switch.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

// Standardized column headers (reused across all term tables)
const HEADERS = [
  "Course Code","Course Title","Section",
  "Mode","Day 1","Room 1","Day 2","Room 2","Time",
] as const;

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
  ay: string;                 // "AY 2024-2025"
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
          "w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm shadow-sm outline-none",
          "hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30"
        )}
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">▾</span>
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
function HistoryMain() {
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
  const ayIndex = useMemo(
    () => AY_OPTIONS.findIndex((o) => o === ay),
    [AY_OPTIONS, ay]
  );
  const atFirst = ayIndex <= 0 || AY_OPTIONS.length === 0;               // first = most recent
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
    } catch { return null; }
  }, []);

  // Parallel initial loads: options (AY list) + first page (most recent AY)
  useEffect(() => {
    if (!userId) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        // 1) options (fetch AYs)
        const optRes = await fetch(`/api/faculty/history?action=options&userId=${encodeURIComponent(userId)}`, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
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
  }, [userId]);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const params = new URLSearchParams();
        // Backend accepts AY as "2024-2025" or "2024" (we send normalized) + q
        if (ay) params.set("ay", normAy(ay));
        if (query.trim()) params.set("q", query.trim());
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
          units: typeof r.units === "number" ? r.units : (r.units ? Number(r.units) : null),
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
  }, [ay, query, userId]);

  // Client-side filter (fast)
  const filtered = useMemo(() => {
    let r = rows;
    if (ay) {
      const wanted = normAy(ay);
      r = r.filter((x) => normAy(x.ay) === wanted);
    }
    const q = query.trim().toLowerCase();
    if (!q) return r;
    return r.filter((x) =>
      [
        x.code, x.title, x.section,
        x.campus ?? "", x.mode ?? "",
        x.day1 ?? "", x.room1 ?? "",
        x.day2 ?? "", x.room2 ?? "",
        x.time, x.term ?? "", x.ay
      ].join(" ").toLowerCase().includes(q)
    );
  }, [rows, ay, query]);

  const groups = useMemo(() => {
    const byTerm: Record<string, Row[]> = { "Term 1": [], "Term 2": [], "Term 3": [] };
    filtered.forEach((r) => {
      const key = (r.term as string) || "Term 1";
      if (!byTerm[key]) byTerm[key] = [];
      byTerm[key].push(r);
    });
    return byTerm;
  }, [filtered]);

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        {/* Header */}
        <div className="mb-4">
          <h3 className="text-lg font-bold text-gray-900">Teaching History</h3>
          <p className="text-sm text-gray-500">Complete record of your teaching assignments</p>
        </div>

        {/* Filters */}
        <div className="mb-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="col-span-2">
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

          {/* AY dropdown + Prev/Next controls stacked */}
          <div className="flex flex-col gap-2">
            <Dropdown
              value={ay}
              onChange={setAy}
              options={AY_OPTIONS}
              placeholder="Select academic year"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={goPrev}
                disabled={atFirst}
                className={cls(
                  "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs",
                  "border-gray-200 text-gray-700 hover:bg-gray-50",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
                aria-label="View newer academic year"
                title="Previous (newer) AY"
              >
                ‹ Prev AY
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={atLast}
                className={cls(
                  "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs",
                  "border-gray-200 text-gray-700 hover:bg-gray-50",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
                aria-label="View older academic year"
                title="Next (older) AY"
              >
                Next AY ›
              </button>
            </div>
          </div>
        </div>

        {/* AY label (first row's AY or default) */}
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-700">
            <span>{ay || "AY —"}</span>
            {loading && <span className="ml-2 text-gray-400">(loading…)</span>}
        </div>

        {/* Term sections */}
        <div className="space-y-8">
          {(["Term 1", "Term 2", "Term 3"] as const).map((t) => (
            <div key={t} className="rounded-xl border border-gray-200">
              {/* Term title */}
              <div className="px-4 py-3 text-sm font-semibold text-emerald-700">{t}</div>

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="min-w-full table-fixed border-t border-gray-200">
                  <colgroup>
                  <col className="w-[12ch]" /> {/* Course Code */}
                  <col className="w-[32ch]" /> {/* Course Title */}
                  <col className="w-[8ch]"  /> {/* Section */}
                  <col className="w-[8ch]"  /> {/* Mode */}
                  <col className="w-[6ch]"  /> {/* Day 1 */}
                  <col className="w-[12ch]" /> {/* Room 1 */}
                  <col className="w-[6ch]"  /> {/* Day 2 */}
                  <col className="w-[12ch]" /> {/* Room 2 */}
                  <col className="w-[14ch]" /> {/* Time */}
                </colgroup>


                  <thead>
                    <tr className="text-xs text-gray-500">
                      {HEADERS.map((h) => (
                        <th key={h} className="px-4 py-2 font-medium text-center whitespace-normal wrap-break-word align-middle">{h}</th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {(groups[t] ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-6 text-center text-sm text-gray-500">
                          No records.
                        </td>

                      </tr>
                    ) : (
                      groups[t].map((r, i) => (
                        <tr
                          key={`${t}-${i}`}
                          className={cls("text-sm text-gray-700", i % 2 === 0 ? "bg-white" : "bg-gray-50")}
                        >
                          <td className="px-4 py-2 text-center">{r.code}</td>
                          <td className="px-4 py-2 text-center whitespace-normal wrap-break-word align-middle">{r.title}</td>
                          <td className="px-4 py-2 text-center">{r.section}</td>
                          <td className="px-4 py-2 text-center">{r.mode ?? ""}</td>
                          <td className="px-4 py-2 text-center">{r.day1 ?? ""}</td>
                          <td className="px-4 py-2 text-center">{r.room1 ?? ""}</td>
                          <td className="px-4 py-2 text-center">{r.day2 ?? ""}</td>
                          <td className="px-4 py-2 text-center">{r.room2 ?? ""}</td>
                          <td className="px-4 py-2 text-center">{r.time}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
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
