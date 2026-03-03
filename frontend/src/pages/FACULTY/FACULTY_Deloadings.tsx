import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Edit, Check, X, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { API_BASE } from "../../api";

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

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
  const [hover, setHover] = React.useState(() => Math.max(0, options.findIndex((o) => o === value)));
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => setHover(Math.max(0, options.findIndex((o) => o === value))), [value, options]);

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
          "w-full min-w-0 rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm outline-none",
          "hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30"
        )}
      >
        <span className="block min-w-0 truncate">{value || <span className="text-gray-400">{placeholder}</span>}</span>
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
              className={cls("block w-full px-4 py-3 text-left text-sm", i === hover && "bg-emerald-50")}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectBox({
  value,
  onChange,
  options,
  className = "w-full",
}: {
  value: string;
  onChange: (label: string) => void;
  options: string[];
  className?: string;
}) {
  return <Dropdown value={value} onChange={onChange} options={options} className={className} placeholder="Select…" />;
}

const lightRedBtn =
  "inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 hover:bg-red-100";

type Row = {
  deloading_id?: string;
  type_id?: string;
  deloading_type?: string;
  units_deloaded?: number;
  notes?: string;
  term_id?: string;
  updated_at?: string | Date;
};

type DeloadingType = { type_id: string; type: string };

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

  const [query, setQuery] = useState("");

  const [editMode, setEditMode] = useState(false);
  const [types, setTypes] = useState<DeloadingType[]>([]);
  const [form, setForm] = useState<{ deloading_id?: string; type_id: string; units_deloaded: string; notes: string }>(
    { type_id: "", units_deloaded: "", notes: "" }
  );

  function labelOf(t: TermLite) {
    const ayEnd = t.acad_year_start + 1;
    return `AY ${t.acad_year_start}–${ayEnd} • Term ${t.term_number}`;
  }

  const currentLabel = useMemo(() => (data?.term ? labelOf(data.term) : ""), [data?.term]);

  const termOptions = useMemo(() => {
    const sorted = [...terms].sort((a, b) => {
      if (a.acad_year_start !== b.acad_year_start) return b.acad_year_start - a.acad_year_start;
      return b.term_number - a.term_number;
    });
    return sorted.map(labelOf);
  }, [terms]);

  const labelToTermId = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of terms) m.set(labelOf(t), t.term_id);
    return m;
  }, [terms]);

  const termIndex = useMemo(() => termOptions.findIndex((o) => o === currentLabel), [termOptions, currentLabel]);
  const atFirst = termIndex <= 0 || termOptions.length === 0;
  const atLast = termIndex === termOptions.length - 1 || termOptions.length === 0;

  const displayRows = useMemo(() => {
    const base = Array.isArray(data?.rows) ? (data?.rows ?? []) : [];
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((r) => {
      const blob = [
        r.deloading_type,
        String(r.units_deloaded ?? ""),
        r.notes,
        r.updated_at ? String(r.updated_at) : "",
      ]
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    });
  }, [data, query]);

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

  async function loadTypes() {
    const userId = getUserId();
    if (!userId) return;
    try {
      const params = new URLSearchParams();
      params.set("userId", userId);
      params.set("action", "types");
      const url = `${API_BASE.replace(/\/+$/, "")}/faculty/deloadings?${params.toString()}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
      const res = await r.json();
      setTypes(Array.isArray(res?.types) ? res.types : []);
    } catch {
      // best-effort
    }
  }

  function startEdit() {
    const first = data?.rows?.[0];
    setForm({
      deloading_id: first?.deloading_id,
      type_id: first?.type_id || "",
      units_deloaded: first?.units_deloaded != null ? String(first.units_deloaded) : "",
      notes: first?.notes || "",
    });
    setEditMode(true);
    loadTypes();
  }

  function cancelEdit() {
    setEditMode(false);
    setError("");
  }

  async function saveEdit() {
    const userId = getUserId();
    if (!userId) {
      setError("You are not logged in.");
      return;
    }
    if (!data?.term?.term_id) {
      setError("No target term selected.");
      return;
    }
    if (!form.type_id) {
      setError("Please select a deloading type.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      params.set("userId", userId);
      params.set("action", "upsert");
      const url = `${API_BASE.replace(/\/+$/, "")}/faculty/deloadings?${params.toString()}`;
      const payload = {
        deloading_id: form.deloading_id,
        term_id: data.term.term_id,
        type_id: form.type_id,
        units_deloaded: form.units_deloaded ? Number(form.units_deloaded) : null,
        notes: form.notes,
      };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await r.text().catch(() => r.statusText));
      const res = await r.json();
      if (!res?.ok) throw new Error(res?.detail || "Failed to save.");

      setEditMode(false);
      await load("current", data.term.term_id);
    } catch (e: any) {
      setError(e?.message || "Failed to save.");
    } finally {
      setLoading(false);
    }
  }

  const onSelectTerm = (label: string) => {
    const termId = labelToTermId.get(label);
    if (termId) load("current", termId);
  };

  const goPrev = () => {
    const i = termOptions.indexOf(currentLabel);
    if (i > 0) onSelectTerm(termOptions[i - 1]);
    else if (!currentLabel && termOptions.length) onSelectTerm(termOptions[0]);
  };

  const goNext = () => {
    const i = termOptions.indexOf(currentLabel);
    if (i >= 0 && i < termOptions.length - 1) onSelectTerm(termOptions[i + 1]);
    else if (i === -1 && termOptions.length) onSelectTerm(termOptions[0]);
  };

  useEffect(() => {
    load("current");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={cls("w-full", embedded ? "" : "px-8 py-8")}>
      {!embedded && (
        <>
          <h1 className="text-2xl font-bold mb-1">My Deloadings</h1>
          <p className="text-sm text-gray-600 mb-6">View your deloading records by term.</p>
        </>
      )}

      <div className="rounded-xl border border-gray-200 bg-white">
        {/* Top controls (smooth, single line like Teaching History) */}
        <div className={cls("flex flex-wrap items-center gap-2 border-b border-gray-200", embedded ? "p-3" : "p-4")}>
          {!embedded && (
            <Link
              to="/faculty/overview"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm hover:bg-gray-50 active:bg-gray-100"
              aria-label="Back"
              title="Back"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>Back</span>
            </Link>
          )}

          {/* Search */}
          <div className="flex-1 min-w-[260px]">
            <div className={cls("relative flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 text-sm", embedded ? "py-2" : "py-2.5")}>
              <Search className="h-4 w-4 text-gray-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by deloading type…"
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

          {/* Term nav */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={goPrev}
              disabled={atFirst}
              className={cls(
                "whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold",
                atFirst
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a4a]"
              )}
              title="Previous academic year"
            >
              ‹ Prev AY
            </button>

            <div className="w-[260px] min-w-[200px]">
              <Dropdown
                value={currentLabel}
                onChange={onSelectTerm}
                options={termOptions}
                placeholder="Select academic year"
                className="w-full"
              />
            </div>

            <button
              type="button"
              onClick={goNext}
              disabled={atLast}
              className={cls(
                "whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold",
                atLast
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a4a]"
              )}
              title="Next academic year"
            >
              Next AY ›
            </button>
          </div>

          {/* Edit controls (embedded only) */}
          {embedded && (
            <div className="ml-auto flex items-center gap-2">
              {!editMode && (
                <button type="button" onClick={startEdit} title="Edit deloading" className="text-gray-700 hover:text-gray-900">
                  <Edit className="h-4 w-4" />
                </button>
              )}

              {editMode && (
                <>
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={loading}
                    className={cls(
                      "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold",
                      loading
                        ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                        : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
                    )}
                    title="Save"
                  >
                    <Check className="h-4 w-4" />
                    <span>Save</span>
                  </button>
                  <button type="button" onClick={cancelEdit} className={lightRedBtn} title="Cancel">
                    <X className="h-4 w-4" />
                    <span>Cancel</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
        )}
        {loading && <div className="px-4 py-4 text-sm text-gray-500">Loading…</div>}

        {embedded && editMode && (
          <div className="px-4 py-4 border-b border-gray-200 bg-gray-50">
            <div className="text-sm font-semibold text-gray-900 mb-3">Edit deloading for this term</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">Deloading Type</div>
                <SelectBox
                  value={(() => {
                    const hit = types.find((t) => t.type_id === form.type_id);
                    return hit?.type || "Select…";
                  })()}
                  onChange={(label) => {
                    if (label === "Select…") return setForm((p) => ({ ...p, type_id: "" }));
                    const hit = types.find((t) => t.type === label);
                    setForm((p) => ({ ...p, type_id: hit?.type_id || "" }));
                  }}
                  options={["Select…", ...types.map((t) => t.type)]}
                />
              </div>
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">Units</div>
                <input
                  value={form.units_deloaded}
                  onChange={(e) => setForm((p) => ({ ...p, units_deloaded: e.target.value }))}
                  inputMode="decimal"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  placeholder="e.g., 3"
                />
              </div>
              <div className="sm:col-span-3">
                <div className="text-xs font-medium text-gray-700 mb-1">Notes</div>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  rows={3}
                  placeholder="Optional"
                />
              </div>
            </div>
          </div>
        )}

        {!loading && (!data || displayRows.length === 0) && !error && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            {query.trim() ? "No matching deloadings for this term." : "No deloadings recorded for this term."}
          </div>
        )}

        {!loading && displayRows.length > 0 && (
          <div className="p-4">
            <div className="overflow-hidden rounded-xl border border-gray-200">
              <table className="min-w-full table-fixed text-sm">
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
                  {displayRows.map((r, i) => (
                    <tr
                      key={`${r.deloading_type}-${i}`}
                      className={i % 2 === 0 ? "bg-white text-gray-800" : "bg-gray-50 text-gray-800"}
                    >
                      <td className="px-3 py-2 text-center">{r.deloading_type || "—"}</td>
                      <td className="px-3 py-2 text-center">{r.units_deloaded ?? "—"}</td>
                      <td className="px-3 py-2 text-center">{r.notes || "—"}</td>
                      <td className="px-3 py-2 text-center">{r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}</td>
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
