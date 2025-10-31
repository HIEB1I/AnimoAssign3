// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_DeloadingUtilization.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

/* ---------- small utility ---------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

/* ---------- Visual parts (mirrors ANA styling) ---------- */
function KpiCard({ title, value, subtitle }: { title: string; value: React.ReactNode; subtitle?: string }) {
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-gray-200">
      <div className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">{title}</span>
          <span aria-hidden>•</span>
        </div>
        <div className="text-3xl font-bold mt-3">{value}</div>
        {subtitle ? <p className="text-xs text-gray-500 mt-1">{subtitle}</p> : null}
      </div>
    </div>
  );
}

const TYPE_PALETTE = {
  Admin: { bar: "bg-emerald-500", pill: "bg-emerald-100 text-emerald-800" },
  Research: { bar: "bg-sky-500", pill: "bg-sky-100 text-sky-800" },
  Others: { bar: "bg-amber-500", pill: "bg-amber-100 text-amber-800" },
} as const;

const normalizeType = (t = "") => {
  const x = t.toLowerCase();
  if (x.startsWith("admin")) return "Admin";
  if (x.startsWith("research")) return "Research";
  return "Others";
};

function TypeBreakdownBar({ activeByType }: { activeByType: Record<string, number> }) {
  const usedTotal = Object.values(activeByType).reduce((s, n) => s + n, 0);
  const segments = [
    { key: "Admin", value: activeByType.Admin || 0 },
    { key: "Research", value: activeByType.Research || 0 },
    { key: "Others", value: activeByType.Others || 0 },
  ];
  return (
    <div className="mt-6 rounded-2xl border bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-700">Units by Type (Used)</h4>
        <div className="text-xs text-gray-400">Total {usedTotal}</div>
      </div>
      <div className="mb-2 h-3 w-full overflow-hidden rounded-full bg-gray-100 flex">
        {segments.map(({ key, value }) => {
          const width = usedTotal === 0 ? 0 : Math.round((value / usedTotal) * 100);
          return (
            <div key={key} className={cls(TYPE_PALETTE[key as keyof typeof TYPE_PALETTE].bar, "h-3")} style={{ width: `${width}%` }} />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {(["Admin", "Research", "Others"] as const).map((k) => (
          <span key={k} className={cls("inline-flex items-center gap-2 rounded-full px-2.5 py-1", TYPE_PALETTE[k].pill)}>
            <span className="inline-block h-2 w-2 rounded-full bg-current/50" />
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-gray-200 mt-6">
      <div className="border-b px-5 py-3">
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

/* ---------- types ---------- */
type ActiveRow = { id: number; faculty: string; type: string; units: number; notes?: string; status?: string };

type ApiPayload = {
  ok: boolean;
  meta?: { term_label?: string };
  metrics: {
    totalApproved: number;
    facultyWithActive: number;
    utilization: number;
    usedUnits: number;
    denom: number;
    activeByType: Record<string, number>;
  };
  active: ActiveRow[];
};

/* ---------- page ---------- */
export default function OM_RP_DeloadingUtilization() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [active, setActive] = useState<ActiveRow[]>([]);
  const [metrics, setMetrics] = useState<ApiPayload["metrics"]>({
    totalApproved: 0,
    facultyWithActive: 0,
    utilization: 0,
    usedUnits: 0,
    denom: 0,
    activeByType: { Admin: 0, Research: 0, Others: 0 },
  });

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/analytics/deloading-utilization", {
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: ApiPayload = await res.json();
        if (!json.ok) throw new Error("Server returned ok=false");
        setActive(json.active || []);
        setMetrics(json.metrics);
      } catch (e: any) {
        setError(e?.message || "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // local recompute if user adjusts Units
  const recomputed = useMemo(() => {
    const totalApproved = active.reduce((s, r) => s + (Number(r.units) || 0), 0);
    const facultyWithActive = active.length;
    const usedUnits = totalApproved;
    const denom = usedUnits;
    const utilization = usedUnits > 0 ? 100 : 0;
    const activeByType: Record<string, number> = { Admin: 0, Research: 0, Others: 0 };
    for (const r of active) activeByType[normalizeType(r.type)] += Number(r.units) || 0;
    return { totalApproved, facultyWithActive, utilization, usedUnits, denom, activeByType };
  }, [active]);

  const m = active.length ? recomputed : metrics;

  const changeUnits = (id: number, value: string) =>
    setActive((rows) => rows.map((r) => (r.id === id ? { ...r, units: Number(value) } : r)));

  return (
    <div className="w-full px-8 py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-2">Deloading Utilization Report</h1>
      <p className="text-sm text-gray-600 mb-6">Monitor faculty deloading usage for the current term.</p>

      {/* Filter bar with Back — same ANA vibe, but no independent AppShell */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <Link
          to="/om/home/reports-analytics"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>Back</span>
        </Link>
        <div className="ml-auto" />
      </div>

      {/* KPI cards */}
      <div className="grid gap-4 md:grid-cols-3 mb-2">
        <KpiCard title="Total Approved Units (This Term)" value={m.totalApproved} />
        <KpiCard title="Faculty with Active Deloadings" value={m.facultyWithActive} />
        <KpiCard title="Utilization Rate" value={`${m.utilization}%`} subtitle={`${m.usedUnits} used of ${m.denom || 0} available`} />
      </div>

      {/* Type breakdown */}
      <TypeBreakdownBar activeByType={m.activeByType} />

      {/* Table */}
      <Section title="Faculty Deloading — Department Breakdown">
        {loading ? (
          <div className="p-4 text-sm text-gray-600">Loading…</div>
        ) : error ? (
          <div className="p-4 text-sm text-red-600">Error: {error}</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-100">
                  <tr className="text-gray-600">
                    <th className="px-4 py-2">Faculty</th>
                    <th className="px-4 py-2">Type of Deloading</th>
                    <th className="px-4 py-2">Units</th>
                    <th className="px-4 py-2">Notes</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {active.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50/60">
                      <td className="px-4 py-2 font-medium">{r.faculty}</td>
                      <td className="px-4 py-2">{normalizeType(r.type)}</td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          className="w-24 rounded border px-2 py-1"
                          value={r.units}
                          onChange={(e) => changeUnits(r.id, e.target.value)}
                        />
                      </td>
                      <td className="px-4 py-2">{r.notes || "—"}</td>
                      <td className="px-4 py-2">
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
                          {r.status || "Active"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Save (no-op for now) */}
            <div className="mt-8 flex justify-end">
              <button className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow hover:bg-emerald-700">
                Save Changes
              </button>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
