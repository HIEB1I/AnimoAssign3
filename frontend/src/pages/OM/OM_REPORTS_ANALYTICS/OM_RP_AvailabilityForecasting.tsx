// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_AvailabilityForecasting.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronLeft, FileDown, X, Search } from "lucide-react";

/* ---------------- Small helpers ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

/* ---------------- SelectBox (same look as ANA) ---------------- */
function SelectBox({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className={cls("relative min-w-[180px]", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pr-8 text-left text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2" />
      </button>

      {open && (
        <div
          ref={listRef}
          className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl"
        >
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls(
                "block w-full px-4 py-2 text-left text-sm hover:bg-emerald-50",
                value === opt && "bg-emerald-100 text-emerald-800 font-medium"
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

/* ---------------- Faculty Combobox (ANA-style) ---------------- */
function FacultyCombobox({
  value,
  onChange,
  options,
  placeholder = "Search faculty…",
  className = "",
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: { id: string; name: string; email: string }[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hoverIndex, setHoverIndex] = useState<number>(-1);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !wrapRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selected = useMemo(
    () => options.find((o) => o.id === value) || null,
    [options, value]
  );

  const filtered = useMemo(() => {
    const q = (selected ? selected.name : query).trim().toLowerCase();
    if (!q) return options.slice(0, 50);
    return options.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 50);
  }, [options, query, selected]);

  const commit = (id: string | null) => {
    onChange(id);
    setOpen(false);
    if (!id) setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHoverIndex((i) => Math.min((i < 0 ? -1 : i) + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIndex((i) => Math.max((i < 0 ? filtered.length : i) - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hoverIndex >= 0 && filtered[hoverIndex]) commit(filtered[hoverIndex].id);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className={cls("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      <input
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        value={selected ? selected.name : query}
        onChange={(e) => {
          if (selected) onChange(null);
          setQuery(e.target.value);
        }}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
      />
      {(selected || query) && (
        <button
          type="button"
          onClick={() => commit(null)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100"
          aria-label="Clear"
          title="Clear"
        >
          ✕
        </button>
      )}

      {open && !selected && (
        <div className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl">
          {filtered.length ? (
            filtered.map((opt, idx) => {
              const active = idx === hoverIndex;
              return (
                <button
                  key={opt.id}
                  onMouseEnter={() => setHoverIndex(idx)}
                  onMouseLeave={() => setHoverIndex(-1)}
                  onClick={() => commit(opt.id)}
                  className={cls(
                    "block w-full px-4 py-2 text-left text-sm",
                    active ? "bg-emerald-50" : "hover:bg-emerald-50"
                  )}
                >
                  <div className="font-medium">{opt.name}</div>
                </button>
              );
            })
          ) : (
            <div className="px-4 py-3 text-sm text-gray-500">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Types from API ---------------- */
type DayPairId = "mon_thu" | "tue_fri" | "wed_sat";
type DayPair = { id: DayPairId; label: string };

type FacultyEntry = { id: string; name: string; email: string; p: number };
type SlotDetail = { available: FacultyEntry[]; unavailable: FacultyEntry[] };
type FacultyBySlot = Partial<Record<DayPairId, Partial<Record<number, SlotDetail>>>>;

type ApiPayload = {
  ok: boolean;
  meta?: { term_label?: string };
  campuses: string[];
  dayPairs: DayPair[];
  timeSlots: string[];
  forecast: Record<DayPairId, number[]>;
  facultyBySlot: FacultyBySlot;
  facultyOptions: { id: string; name: string; email: string }[];
};

/* ---------------- Palette & helpers ---------------- */
const maxForecast = (data: Record<string, number[]>) => Math.max(0, ...Object.values(data).flat());

const classForValue = (v: number, max: number) => {
  if (max === 0 || v === 0) return "bg-[#FCF8E8] text-slate-900"; // None
  const ratio = v / max;
  if (ratio >= 0.67) return "bg-[#94B49F] text-slate-900"; // High
  if (ratio >= 0.34) return "bg-[#ECB390] text-slate-900"; // Medium
  return "bg-[#DF7861] text-white"; // Low
};

function buildFacultyIndex(data: FacultyBySlot) {
  const index = new Map<string, Array<{ dp: DayPairId; i: number }>>();
  (Object.keys(data) as DayPairId[]).forEach((dp) => {
    const byIdx = data[dp] || {};
    Object.keys(byIdx).forEach((k) => {
      const i = Number(k);
      const detail = byIdx[i]!;
      (detail.available || []).forEach((f) => {
        const arr = index.get(f.id) || [];
        arr.push({ dp, i });
        index.set(f.id, arr);
      });
    });
  });
  return index;
}

/* ---------------- Page ---------------- */
export default function OM_RP_AvailabilityForecasting() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [termLabel, setTermLabel] = useState<string>("");
  const [campus, setCampus] = useState<string>("");

  const [dayPairs, setDayPairs] = useState<DayPair[]>([]);
  const [timeSlots, setTimeSlots] = useState<string[]>([]);
  const [forecast, setForecast] = useState<Record<DayPairId, number[]>>({
    mon_thu: [],
    tue_fri: [],
    wed_sat: [],
  });
  const [facultyBySlot, setFacultyBySlot] = useState<FacultyBySlot>({});
  const [facultyOptions, setFacultyOptions] = useState<{ id: string; name: string; email: string }[]>([]);

  const [selectedFacultyId, setSelectedFacultyId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/analytics/availability-forecast", {
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: ApiPayload = await res.json();
        if (!json.ok) throw new Error("Server returned ok=false");

        setTermLabel(json.meta?.term_label || "");
        setCampus(json.campuses?.[0] || "Manila");
        setDayPairs(json.dayPairs || []);
        setTimeSlots(json.timeSlots || []);
        setForecast(json.forecast || { mon_thu: [], tue_fri: [], wed_sat: [] });
        setFacultyBySlot(json.facultyBySlot || {});
        setFacultyOptions(json.facultyOptions || []);
      } catch (e: any) {
        setError(e?.message || "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const maxVal = useMemo(() => maxForecast(forecast), [forecast]);
  const facultyIndex = useMemo(() => buildFacultyIndex(facultyBySlot), [facultyBySlot]);

  const matchSet = useMemo(() => {
    if (!selectedFacultyId) return null;
    const entries = facultyIndex.get(selectedFacultyId) || [];
    return new Set(entries.map((e) => `${e.dp}|${e.i}`));
  }, [selectedFacultyId, facultyIndex]);

  const isCellMatch = (dp: DayPairId, i: number) => {
    if (!matchSet) return true;
    return matchSet.has(`${dp}|${i}`);
  };

  // modal state
  const [open, setOpen] = useState(false);
  const [activePair, setActivePair] = useState<DayPairId | null>(null);
  const [activePairLabel, setActivePairLabel] = useState<string>("");
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [activeValue, setActiveValue] = useState<number>(0);

  const openModal = (dp: DayPairId, dpLabel: string, idx: number, value: number) => {
    setActivePair(dp);
    setActivePairLabel(dpLabel);
    setActiveIndex(idx);
    setActiveValue(value);
    setOpen(true);
  };
  const closeModal = () => setOpen(false);

  // low coverage list (ratio < 0.34)
  const lowCoverage = useMemo(() => {
    const lows: { dp: DayPairId; dpLabel: string; i: number; t: string; v: number }[] = [];
    for (const dp of dayPairs) {
      for (let i = 0; i < timeSlots.length; i++) {
        const v = forecast[dp.id]?.[i] ?? 0;
        if (maxVal > 0 && v / maxVal < 0.34) lows.push({ dp: dp.id, dpLabel: dp.label, i, t: timeSlots[i], v });
      }
    }
    return lows.sort((a, b) => a.v - b.v);
  }, [dayPairs, timeSlots, forecast, maxVal]);

  const activeAvail = activePair ? facultyBySlot?.[activePair]?.[activeIndex]?.available ?? [] : [];
  const activeUnavail = activePair ? facultyBySlot?.[activePair]?.[activeIndex]?.unavailable ?? [] : [];

  const selectedFaculty = useMemo(
    () => (selectedFacultyId ? facultyOptions.find((o) => o.id === selectedFacultyId) || null : null),
    [selectedFacultyId, facultyOptions]
  );

  const handleExportCsv = () => {
    const rows: (string | number)[][] = [
      ["Term", termLabel || "—"],
      ["Campus", campus || "—"],
      selectedFacultyId ? ["Faculty Filter", selectedFacultyId] : [],
      [],
      ["Day Pair", "Time Slot", "Predicted Available"],
    ].filter((r) => r.length) as (string | number)[][];

    for (const dp of dayPairs) {
      for (let i = 0; i < timeSlots.length; i++) {
        const match =
          !selectedFacultyId ||
          (facultyBySlot?.[dp.id]?.[i]?.available || []).some((f) => f.id === selectedFacultyId);
        if (match) rows.push([dp.label, timeSlots[i], forecast[dp.id]?.[i] ?? 0]);
      }
    }
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `availability-forecast-${(termLabel || "term").replace(/\s+/g, "_")}-${campus}${
      selectedFacultyId ? `-${selectedFacultyId}` : ""
    }.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // esc to close modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="w-full px-8 py-8">
      {/* Header */}
      <header className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Faculty Availability Forecast (Pre-Survey)</h1>
          <p className="text-sm text-gray-600">
            Predictive forecast {termLabel ? <>for <strong>{termLabel}</strong></> : null}
          </p>
        </div>
      </header>

      {/* Filter Bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <Link
          to="/om/home/reports-analytics"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>Back</span>
        </Link>

        <FacultyCombobox
          value={selectedFacultyId}
          onChange={setSelectedFacultyId}
          options={facultyOptions}
          className="flex-1 min-w-[240px]"
        />

        <div className="ml-auto flex items-center gap-3">
          <SelectBox
            value={campus}
            onChange={setCampus}
            options={["Manila", "Laguna"]}
            placeholder="— Campus —"
            className="min-w-[180px]"
          />
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100 focus:ring-2 focus:ring-emerald-500/30"
            aria-label="Export CSV"
            title="Export CSV"
          >
            <FileDown className="h-4 w-4" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Heatmap */}
      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        {loading ? (
          <div className="py-10 text-center text-sm text-gray-600">Loading forecast…</div>
        ) : error ? (
          <div className="py-10 text-center text-sm text-red-600">Error: {error}</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0">
                <colgroup>
                  <col className="w-[112px] min-w-[112px] max-w-[112px]" />
                  <col />
                  <col />
                  <col />
                </colgroup>

                <thead>
                  <tr>
                    <th className="p-1.5 text-center align-middle text-[10px] uppercase tracking-wide text-gray-500 whitespace-nowrap">
                      Time Slot
                    </th>
                    {dayPairs.map((dp) => (
                      <th
                        key={dp.id}
                        className="p-2 text-left text-[11px] uppercase tracking-wide text-gray-500"
                      >
                        {dp.label}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {timeSlots.map((slot, i) => (
                    <tr key={i} className="align-top">
                      <td className="p-1.5 w-[112px] text-center align-middle text-xs font-medium whitespace-nowrap">
                        {slot}
                      </td>

                      {dayPairs.map((dp) => {
                        const v = forecast[dp.id]?.[i] ?? 0;
                        const top = facultyBySlot?.[dp.id]?.[i]?.available?.[0] ?? null;
                        const tooltip = `Pred. faculty: ${v}${top ? ` | Top: ${top.name} (${top.p.toFixed(2)})` : ""}`;
                        const match = isCellMatch(dp.id, i);

                        return (
                          <td key={dp.id} className="p-2">
                            <button
                              type="button"
                              title={tooltip}
                              aria-label={tooltip}
                              onClick={() => match && openModal(dp.id, dp.label, i, v)}
                              disabled={!match}
                              className={cls(
                                "slotbtn relative grid h-12 w-full place-items-center rounded-xl text-center shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] focus:outline-none",
                                classForValue(v, maxVal),
                                match
                                  ? "focus:ring-2 focus:ring-emerald-500/30"
                                  : "opacity-40 grayscale pointer-events-none"
                              )}
                            >
                              <div className="text-base font-extrabold leading-none">{v}</div>
                              <div className="text-[10px] opacity-90">pred. faculty</div>
                              {selectedFacultyId && match && (
                                <span className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-emerald-400/50" />
                              )}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-gray-600">
              <span className="inline-flex items-center gap-2">
                <i className="h-3.5 w-3.5 rounded-md border border-black/5 bg-[#94B49F]"></i> High
              </span>
              <span className="inline-flex items-center gap-2">
                <i className="h-3.5 w-3.5 rounded-md border border-black/5 bg-[#ECB390]"></i> Medium
              </span>
              <span className="inline-flex items-center gap-2">
                <i className="h-3.5 w-3.5 rounded-md border border-black/5 bg-[#DF7861]"></i> Low
              </span>
              <span className="inline-flex items-center gap-2">
                <i className="h-3.5 w-3.5 rounded-md border border-black/5 bg-[#FCF8E8]"></i> None
              </span>
              {selectedFaculty && (
                <span className="inline-flex items-center gap-2">
                  <i className="h-3.5 w-3.5 rounded-md border border-emerald-300 ring-2 ring-emerald-400/50"></i>{" "}
                  {selectedFaculty.name} available
                </span>
              )}
            </div>

            <p className="mt-2 text-xs text-gray-500">
              Numbers represent predicted counts prior to new preference forms. Click a cell to see faculty names with confidence.
            </p>
          </>
        )}
      </section>

      {/* Low-coverage pill */}
      <div className="mt-3 flex justify-end">
        <div
          className={cls(
            "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm shadow-sm",
            lowCoverage.length
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          )}
          role="status"
          aria-live="polite"
        >
          {lowCoverage.length ? (
            <>
              <span>{lowCoverage.length} low-coverage slots detected.</span>
              <button
                type="button"
                onClick={() =>
                  openModal(lowCoverage[0].dp, lowCoverage[0].dpLabel, lowCoverage[0].i, lowCoverage[0].v)
                }
                className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs hover:bg-amber-100"
              >
                View first
              </button>
            </>
          ) : (
            <span>No low-coverage windows detected.</span>
          )}
        </div>
      </div>

      {/* Modal */}
      {open && activePair && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
          aria-hidden={false}
        >
          <div className="w-full max-w-[640px] overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  {activePairLabel}
                </div>
                <div className="text-sm font-semibold text-slate-800">
                  {timeSlots[activeIndex]} • Pred: {activeValue}
                </div>
              </div>
              <button
                onClick={closeModal}
                className="rounded-md p-1.5 text-gray-600 hover:bg-gray-100"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2">
              {/* Available */}
              <div className="min-w-0 border-b border-gray-200 p-4 sm:border-b-0 sm:border-r">
                <div className="mb-2 flex items-center justify-between">
                  <strong className="text-sm">Predicted Available</strong>
                  <span className="rounded-full border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600">
                    {activeAvail.length}
                  </span>
                </div>
                <ul className="max-h-64 space-y-1 overflow-auto text-sm">
                  {activeAvail.map((f) => {
                    const isSelected = selectedFacultyId === f.id;
                    return (
                      <li
                        key={f.id}
                        className={cls(
                          "flex items-center justify-between gap-2 rounded-md px-1 py-0.5",
                          isSelected ? "bg-emerald-50 font-medium text-emerald-900" : ""
                        )}
                      >
                        <span className="truncate">{f.name}</span>
                        <span className="text-xs text-gray-500">{Math.round(f.p * 100)}%</span>
                      </li>
                    );
                  })}
                  {!activeAvail.length && <li className="text-sm text-gray-500">No predictions available.</li>}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const text = activeAvail.map((f) => `${f.name} <${f.email}>`).join(", ");
                      try {
                        await navigator.clipboard.writeText(text);
                      } catch {
                        window.prompt("Copy the list below:", text);
                      }
                    }}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
                  >
                    Copy names/emails
                  </button>
                </div>
              </div>

              {/* Unavailable */}
              <div className="min-w-0 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <strong className="text-sm">Likely Unavailable</strong>
                  <span className="rounded-full border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600">
                    {activeUnavail.length}
                  </span>
                </div>
                <ul className="max-h-64 space-y-1 overflow-auto text-sm">
                  {activeUnavail.map((f) => (
                    <li key={f.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{f.name}</span>
                      <span className="text-xs text-gray-500">{Math.round(f.p * 100)}%</span>
                    </li>
                  ))}
                  {!activeUnavail.length && <li className="text-sm text-gray-500">No predictions available.</li>}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>

            <div className="border-t border-gray-200 px-4 py-3 text-xs text-gray-500">
              Tip: Export CSV respects the current faculty filter.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
