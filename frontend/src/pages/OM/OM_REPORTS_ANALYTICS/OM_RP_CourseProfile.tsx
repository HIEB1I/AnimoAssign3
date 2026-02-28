import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Search as SearchIcon, ChevronLeft, ChevronDown, ChevronUp, BarChart2 } from "lucide-react";
import { fetchCourseProfile, type CMCourseRow } from "@/api";

/* -----------------------------
 * Types (kept small + defensive)
 * ----------------------------- */

type InstructorInfo = {
  faculty_id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  source?: string;
  teaching_history?: {
    count?: number;
    most_recent_taught?: { acad_year_start?: number; term_number?: number };
  };
};

type PastTeach = {
  acad_year_start?: number;
  term_number?: number;
};

type PastInstructorCount = InstructorInfo & {
  count?: number;
  sections?: PastTeach[];
};

type AYDemandRow = {
  ay: number;
  t1?: number;
  t2?: number;
  t3?: number;
};

type HistoryMetrics = {
  total_sections: number;
  unique_instructors: number;
  most_recent_taught?: { acad_year_start?: number; term_number?: number };
  ay_demand_visual?: AYDemandRow[];
};

type TermLite = {
  term_id: string;
  acad_year_start: number;
  term_number: number;
  is_current?: boolean;
};

type CourseProfile = {
  course_id: string;
  course_code?: string[];
  title?: string;
  qualified_faculty?: InstructorInfo[];
  past_instructors_top3?: PastInstructorCount[];
  past_instructors_remaining_count?: number;
  past_instructors_others?: PastInstructorCount[];
  history_metrics?: HistoryMetrics;
  preferences?: string | InstructorInfo[];
  terms?: TermLite[];
  active_term?: { term_id?: string; acad_year_start?: number; term_number?: number };
  term?: { term_id?: string; acad_year_start?: number; term_number?: number };
};

/* -----------------------------
 * Helpers
 * ----------------------------- */

function joinCodes(codes?: string[]): string {
  return codes && codes.length ? codes.join(" / ") : "";
}

function fmtAY(start?: number): string {
  if (typeof start !== "number") return "—";
  return `${start}–${start + 1}`;
}

function fmtAYHyphen(start?: number): string {
  if (typeof start !== "number") return "—";
  return `${start}-${start + 1}`;
}

function fullName(last?: string, first?: string): string {
  const L = (last || "").trim();
  const F = (first || "").trim();
  if (!L && !F) return "—";
  if (!L) return F;
  if (!F) return L;
  return `${L}, ${F}`;
}

function isKacSource(src?: string) {
  return (src || "").toLowerCase().includes("kac");
}

function mostRecentLabel(m?: { acad_year_start?: number; term_number?: number }): string {
  if (!m || typeof m.acad_year_start !== "number" || typeof m.term_number !== "number") return "Never";
  return `${fmtAY(m.acad_year_start)} Term ${m.term_number}`;
}

/* -----------------------------
 * Course Demand (Area Chart)
 * ----------------------------- */

type TermPoint = {
  key: string;
  ay: number;
  term: 1 | 2 | 3;
  value: number;
};

function buildTermPoints(rows: AYDemandRow[]): TermPoint[] {
  const sorted = [...rows].sort((a, b) => a.ay - b.ay);
  const pts: TermPoint[] = [];
  for (const r of sorted) {
    pts.push({ key: `${r.ay}-1`, ay: r.ay, term: 1, value: Number(r.t1 ?? 0) });
    pts.push({ key: `${r.ay}-2`, ay: r.ay, term: 2, value: Number(r.t2 ?? 0) });
    pts.push({ key: `${r.ay}-3`, ay: r.ay, term: 3, value: Number(r.t3 ?? 0) });
  }
  return pts;
}

function AreaDemandChart({ rows }: { rows: AYDemandRow[] }) {
  const pts = useMemo(() => buildTermPoints(rows), [rows]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!pts.length) {
    return <div className="py-6 text-center text-sm text-gray-500">No history data available.</div>;
  }

  const W = 760;
  const H = 260;
  const pad = { l: 44, r: 12, t: 14, b: 52 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const rawMax = Math.max(1, ...pts.map((p) => p.value));
  const maxTick = Math.ceil(rawMax / 10) * 10; // 0,10,20,30...
  const ticks = Array.from({ length: Math.floor(maxTick / 10) + 1 }, (_, i) => i * 10);

  const x = (i: number) => pad.l + (pts.length === 1 ? innerW / 2 : (i * innerW) / (pts.length - 1));
  const y = (v: number) => pad.t + ((maxTick - v) * innerH) / Math.max(1, maxTick);

  const lineD = pts
    .map((p, i) => {
      const xi = x(i);
      const yi = y(p.value);
      return `${i === 0 ? "M" : "L"} ${xi} ${yi}`;
    })
    .join(" ");

  const areaD = `${lineD} L ${x(pts.length - 1)} ${pad.t + innerH} L ${x(0)} ${pad.t + innerH} Z`;

  // AY labels at the midpoint of each (T1,T2,T3) group
  const ayGroups = useMemo(() => {
    const g: Array<{ ay: number; midIndex: number }> = [];
    for (let i = 0; i < pts.length; i += 3) {
      const mid = i + 1; // T2
      if (pts[mid]) g.push({ ay: pts[mid].ay, midIndex: mid });
    }
    return g;
  }, [pts]);

  // Vertical separators between academic years (between T3 and next T1)
  const aySeparators = useMemo(() => {
    const xs: number[] = [];
    for (let i = 2; i < pts.length - 1; i += 3) {
      xs.push((x(i) + x(i + 1)) / 2);
    }
    return xs;
  }, [pts, innerW]);

  // Tooltip (hover on dot)
  const hover = hoverIdx === null ? null : pts[hoverIdx];
  const tooltip = useMemo(() => {
    if (!hover || hoverIdx === null) return null;

    const hx = x(hoverIdx);
    const hy = y(hover.value);

    const label = `${fmtAY(hover.ay)} • T${hover.term}: ${hover.value} section${hover.value === 1 ? "" : "s"}`;
    const approxW = Math.min(280, Math.max(150, Math.round(label.length * 6.4 + 18)));
    const th = 26;

    let tx = hx + 10;
    if (tx + approxW > W - pad.r) tx = hx - approxW - 10;
    tx = Math.max(pad.l, Math.min(tx, W - pad.r - approxW));

    let ty = hy - 34;
    ty = Math.max(pad.t + 4, ty);

    return { label, tx, ty, tw: approxW, th, hx, hy };
  }, [hoverIdx, hover]);

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[620px] w-full">
        {/* grid + y-ticks */}
        {ticks.map((t) => {
          const yy = y(t);
          return (
            <g key={`tick-${t}`}>
              <line x1={pad.l} y1={yy} x2={W - pad.r} y2={yy} stroke="#E5E7EB" />
              <text x={pad.l - 8} y={yy + 4} fontSize={11} textAnchor="end" fill="#6B7280">
                {t}
              </text>
            </g>
          );
        })}

        {/* AY separators */}
        {aySeparators.map((xx, idx) => (
          <line
            key={`ay-sep-${idx}`}
            x1={xx}
            y1={pad.t}
            x2={xx}
            y2={pad.t + innerH}
            stroke="#a2a4a7"
            strokeDasharray="4 4"
          />
        ))}

        {/* area + line */}
        <path d={areaD} fill="#D1FAE5" opacity={0.9} />
        <path d={lineD} fill="none" stroke="#10B981" strokeWidth={2.5} />

        {/* points */}
        {pts.map((p, i) => {
          const isHover = hoverIdx === i;
          return (
            <circle
              key={p.key}
              cx={x(i)}
              cy={y(p.value)}
              r={isHover ? 5 : 4}
              fill="#10B981"
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
            />
          );
        })}

        {/* tooltip */}
        {tooltip ? (
          <g>
            <line x1={tooltip.hx} y1={tooltip.hy} x2={tooltip.hx} y2={tooltip.ty + tooltip.th} stroke="#D1D5DB" />
            <rect
              x={tooltip.tx}
              y={tooltip.ty}
              width={tooltip.tw}
              height={tooltip.th}
              rx={8}
              ry={8}
              fill="#FFFFFF"
              stroke="#D1D5DB"
            />
            <text x={tooltip.tx + 9} y={tooltip.ty + 17} fontSize={11} fill="#111827">
              {tooltip.label}
            </text>
          </g>
        ) : null}

        {/* term labels */}
        {pts.map((p, i) => (
          <text
            key={`${p.key}-t`}
            x={x(i)}
            y={pad.t + innerH + 18}
            fontSize={11}
            textAnchor="middle"
            fill="#6B7280"
          >
            {`T${p.term}`}
          </text>
        ))}

        {/* horizontal separator before AY labels */}
        <line
          x1={pad.l}
          y1={pad.t + innerH + 26}
          x2={W - pad.r}
          y2={pad.t + innerH + 26}
          stroke="#E5E7EB"
        />

        {/* AY labels */}
        {ayGroups.map((g) => (
          <text
            key={`ay-${g.ay}`}
            x={x(g.midIndex)}
            y={pad.t + innerH + 44}
            fontSize={11}
            textAnchor="middle"
            fill="#047857"
            fontWeight={600}
          >
            {fmtAY(g.ay)}
          </text>
        ))}
      </svg>
    </div>
  );
}


function CourseDemandOverTime({
  rows,
  totalSections,
  mostRecent,
}: {
  rows: AYDemandRow[];
  totalSections: number;
  mostRecent: string;
}) {
  const sorted = useMemo(() => [...rows].sort((a, b) => a.ay - b.ay), [rows]);

  return (
    <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <h3 className="text-md font-semibold text-emerald-700 flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-emerald-500" />
          Course Demand Over Time
        </h3>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-0.5 text-xs font-semibold text-gray-700">
            {`Total sections: ${Number(totalSections ?? 0)}`}
          </span>
          {mostRecent && mostRecent !== "—" ? (
            <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
              {`Most recent: ${mostRecent}`}
            </span>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-gray-700 mb-3">Demand trend shows the sections offered per term over time.</p>

      <AreaDemandChart rows={sorted} />

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-gray-100 pt-3">
        <p className="text-xs text-gray-600">Hover over a dot to see the section count for that term.</p>
        <div className="text-[11px] text-gray-500">
          <span className="font-semibold text-gray-700">T1</span> / <span className="font-semibold text-gray-700">T2</span> /{" "}
          <span className="font-semibold text-gray-700">T3</span>
        </div>
      </div>
    </div>
  );
}

/* -----------------------------
 * Main Page
 * ----------------------------- */

export default function OM_RP_CourseProfile() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [courseList, setCourseList] = useState<Array<{ course_id: string; code: string; title: string }>>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);

  const [data, setData] = useState<CourseProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [showOtherInstructors, setShowOtherInstructors] = useState(false);

  useEffect(() => {
    setShowOtherInstructors(false);
  }, [data?.course_id]);

  // Fetch course list on mount
  useEffect(() => {
    let alive = true;

    async function run() {
      setListErr(null);
      setListLoading(true);
      try {
        const u = JSON.parse(localStorage.getItem("animo.user") || "null");
        const userId = u?.userId;
        const userEmail = u?.email;

        const { getCMOptions, listCMCourses } = await import("@/api");
        const opts = await getCMOptions(userEmail, userId);
        const clusters = Array.isArray(opts?.clusters) ? opts.clusters : [];

        const calls = [
          listCMCourses({ userId, userEmail, search: "" }),
          ...clusters.map((cluster: string) => listCMCourses({ userId, userEmail, cluster, search: "" })),
        ];
        const results = await Promise.allSettled(calls);

        const map = new Map<string, { course_id: string; code: string; title: string }>();
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const rows = (r.value?.rows || []) as CMCourseRow[];
          for (const row of rows) {
            if (!row?.course_id) continue;
            if (!map.has(row.course_id)) {
              map.set(row.course_id, {
                course_id: row.course_id,
                code: row.code || "",
                title: row.title || "",
              });
            }
          }
        }

        const items = Array.from(map.values());
        items.sort((a, b) => {
          const A = (a.code || "").toLowerCase();
          const B = (b.code || "").toLowerCase();
          if (A < B) return -1;
          if (A > B) return 1;
          return (a.title || "").localeCompare(b.title || "");
        });

        if (alive) setCourseList(items);
      } catch (e: any) {
        if (alive) setListErr(e?.message || "Failed to load course list.");
      } finally {
        if (alive) setListLoading(false);
      }
    }

    run();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return courseList;
    return courseList.filter((c) => c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
  }, [query, courseList]);

  async function loadProfile(courseIdOrCode: string) {
    setErr(null);
    setLoading(true);
    try {
      const res = await fetchCourseProfile(courseIdOrCode);
      setData(res as CourseProfile);
    } catch (e: any) {
      setErr(e?.message || "Failed to fetch course profile");
    } finally {
      setLoading(false);
    }
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    await loadProfile(q);
  }

  const metrics = data?.history_metrics;

  const courseHeader = useMemo(() => {
    const code = data?.course_code?.length ? joinCodes(data.course_code) : data?.course_id || "";
    const title = data?.title || "No title listed";
    return `${code || "—"} - ${title || "—"}`;
  }, [data]);

  const planningTermLabel = useMemo(() => {
    const ts = Array.isArray(data?.terms) ? (data?.terms as TermLite[]) : [];
    if (ts.length) {
      const curIdx = ts.findIndex((t) => !!t.is_current);
      const planning = curIdx >= 0 ? ts[curIdx + 1] || ts[curIdx] : ts[0];
      if (planning && typeof planning.term_number === "number" && typeof planning.acad_year_start === "number") {
        return `Term ${planning.term_number} AY ${fmtAYHyphen(planning.acad_year_start)}`;
      }
    }
    const fallback = data?.active_term || data?.term;
    if (fallback && typeof fallback.term_number === "number" && typeof fallback.acad_year_start === "number") {
      return `Term ${fallback.term_number} AY ${fmtAYHyphen(fallback.acad_year_start)}`;
    }
    return "—";
  }, [data]);

  const planningTermId = useMemo(() => {
    const ts = Array.isArray(data?.terms) ? (data?.terms as TermLite[]) : [];
    if (ts.length) {
      const curIdx = ts.findIndex((t) => !!t.is_current);
      const planning = curIdx >= 0 ? ts[curIdx + 1] || ts[curIdx] : ts[0];
      return (planning?.term_id || "").trim();
    }
    const fallback: any = data?.active_term || data?.term;
    return (fallback?.term_id || "").trim();
  }, [data]);

  const taughtMap = useMemo(() => {
    const map = new Map<string, { count: number; last?: { acad_year_start?: number; term_number?: number } }>();
    const all: PastInstructorCount[] = [...(data?.past_instructors_top3 || []), ...(data?.past_instructors_others || [])];

    for (const pi of all) {
      const fid = (pi?.faculty_id || "").trim();
      if (!fid) continue;

      const count = Number(pi.count ?? pi.teaching_history?.count ?? 0);
      let last = pi.teaching_history?.most_recent_taught;

      if (!last && Array.isArray(pi.sections) && pi.sections.length) {
        const valid = pi.sections
          .filter((s) => typeof s.acad_year_start === "number" && typeof s.term_number === "number")
          .sort((a, b) => (b.acad_year_start! - a.acad_year_start!) || (b.term_number! - a.term_number!));
        if (valid[0]) last = { acad_year_start: valid[0].acad_year_start, term_number: valid[0].term_number };
      }

      const prev = map.get(fid);
      if (!prev || count > prev.count) map.set(fid, { count, last });
    }

    return map;
  }, [data?.past_instructors_top3, data?.past_instructors_others]);

  const qualified = useMemo(
    () => (Array.isArray(data?.qualified_faculty) ? (data?.qualified_faculty as InstructorInfo[]) : []),
    [data?.qualified_faculty]
  );

  const kacIds = useMemo(() => {
    const s = new Set<string>();
    for (const qf of qualified) {
      if (qf?.faculty_id && isKacSource(qf.source)) s.add(qf.faculty_id);
    }
    return s;
  }, [qualified]);

  const bestFit = useMemo(() => {
    return qualified
      .filter((qf) => isKacSource(qf.source))
      .filter((qf) => (taughtMap.get(qf.faculty_id)?.count || 0) > 0);
  }, [qualified, taughtMap]);

  const qualifiedKacNoHistory = useMemo(() => {
    return qualified
      .filter((qf) => isKacSource(qf.source))
      .filter((qf) => (taughtMap.get(qf.faculty_id)?.count || 0) === 0);
  }, [qualified, taughtMap]);

  const taughtButNotKac = useMemo(() => {
    const allPast: PastInstructorCount[] = [...(data?.past_instructors_top3 || []), ...(data?.past_instructors_others || [])];
    const uniq = new Map<string, PastInstructorCount>();
    for (const pi of allPast) {
      if (!pi?.faculty_id) continue;
      if (kacIds.has(pi.faculty_id)) continue;
      const count = Number(pi.count ?? 0);
      if (count <= 0) continue;
      if (!uniq.has(pi.faculty_id)) uniq.set(pi.faculty_id, pi);
    }
    return Array.from(uniq.values());
  }, [data?.past_instructors_top3, data?.past_instructors_others, kacIds]);

  const prefsUnique = useMemo(() => {
    if (!data) return [] as InstructorInfo[];
    if (typeof data.preferences === "string") return [] as InstructorInfo[];
    if (!Array.isArray(data.preferences)) return [] as InstructorInfo[];

    const seen = new Map<string, InstructorInfo>();
    for (const p of data.preferences as InstructorInfo[]) {
      const fid = (p?.faculty_id || "").trim();
      if (!fid) continue;
      // Preferences (Planning Term) should only show faculty who have taught this course before.
      const taughtCount = taughtMap.get(fid)?.count || 0;
      if (taughtCount <= 0) continue;
      if (!seen.has(fid)) seen.set(fid, p);
    }
    return Array.from(seen.values());
  }, [data, taughtMap]);

  function renderFacultyCard(person: InstructorInfo, opts?: { showNoHistoryText?: boolean }) {
    const meta = taughtMap.get(person.faculty_id);
    const taughtCount = meta?.count || 0;
    const last = meta?.last;

    return (
      <div key={person.faculty_id} className="rounded-lg border border-gray-200 bg-white p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-gray-900">{fullName(person.last_name, person.first_name)}</div>
            {person.email ? <div className="truncate text-xs text-gray-500">{person.email}</div> : null}
          </div>

          {taughtCount > 0 ? (
            <span className="shrink-0 inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-0.5 text-xs font-semibold text-gray-700">
              {`Taught ${taughtCount}×`}
            </span>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {last && typeof last.acad_year_start === "number" && typeof last.term_number === "number" ? (
            <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
              {`Last: ${fmtAY(last.acad_year_start)} T${last.term_number}`}
            </span>
          ) : null}
        </div>

        {opts?.showNoHistoryText && taughtCount === 0 ? (
          <div className="mt-2 text-xs text-gray-500">No recorded teaching history.</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="w-full px-8 py-8">
      <h1 className="text-2xl font-bold mb-2">Course Profile</h1>
      <p className="text-sm text-gray-600 mb-6">
        Summarizes a course’s usual teaching pattern (who teaches it, how often it runs, typical sections) to guide assignments and planning.
      </p>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-gray-200">
          <Link
            to="/om/home/reports-analytics"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
            aria-label="Back"
            title="Back"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>Back</span>
          </Link>

          <form onSubmit={onSearch} className="flex items-center gap-2 flex-1 min-w-[320px]">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by course code…"
                className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
              />
              {!!query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  title="Clear"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
                >
                  ×
                </button>
              )}
            </div>
          </form>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
          <div className="border-r border-gray-200">
            {listErr && <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{listErr}</div>}
            {listLoading && <div className="px-4 py-4 text-sm text-gray-500">Loading course list…</div>}

            {!listLoading && !listErr && (
              <>
                <div className="px-4 py-2 text-xs text-gray-500 border-b">
                  Showing {filtered.length} of {courseList.length} courses
                </div>
                <ul className="max-h-[70vh] overflow-auto divide-y" role="list" aria-label="Courses">
                  {filtered.map((c) => (
                    <li key={c.course_id} className="bg-white">
                      <button
                        onClick={() => loadProfile(c.course_id)}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50"
                        title="View course profile"
                      >
                        <div className="font-semibold text-emerald-700">{c.code || "—"}</div>
                        <div className="text-sm text-gray-700 line-clamp-1">{c.title || "No title"}</div>
                      </button>
                    </li>
                  ))}
                  {filtered.length === 0 && <li className="px-4 py-4 text-sm text-gray-500">No courses match your filter.</li>}
                </ul>
              </>
            )}
          </div>

          <div className="md:col-span-2 p-6 space-y-6">
            {err && <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">{err}</div>}
            {loading && <div className="px-4 py-4 text-sm text-gray-500">Loading course profile…</div>}

            {!loading && !err && !data && (
              <div className="px-6 py-10 text-center text-sm text-gray-500 border border-gray-200 rounded-lg">
                Select a course on the left to view its analytical profile.
              </div>
            )}

            {!loading && !err && data && (
              <div className="space-y-6">
                <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-200">
                  <h2 className="text-xl font-bold text-emerald-800">{courseHeader}</h2>
                  <p className="text-sm text-emerald-700">Course History & Assignment Analysis</p>
                </div>

                <CourseDemandOverTime
                  rows={metrics?.ay_demand_visual || []}
                  totalSections={Number(metrics?.total_sections ?? 0)}
                  mostRecent={mostRecentLabel(metrics?.most_recent_taught)}
                />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                    <h3 className="text-md font-semibold text-emerald-700 mb-3">Faculty Fit</h3>

                    <div className="space-y-4">
                      {/* 1) Best-fit stays first and is the ONLY default-open panel */}
                      <details open className="rounded-lg border border-gray-200 bg-white">
                        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-gray-900 flex items-center justify-between">
                          <span>Best-fit (KAC + Taught before)</span>
                          <span className="text-xs text-gray-500">{bestFit.length}</span>
                        </summary>
                        <div className="p-3 grid grid-cols-1 gap-2">
                          {bestFit.length ? bestFit.map((p) => renderFacultyCard(p)) : <div className="text-sm text-gray-500">None listed.</div>}
                        </div>
                      </details>

                      {/* 2) Has taught before comes second */}
                      <details className="rounded-lg border border-gray-200 bg-white">
                        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-gray-900 flex items-center justify-between">
                          <span>Has taught before</span>
                          <span className="text-xs text-gray-500">{taughtButNotKac.length}</span>
                        </summary>
                        <div className="p-3 grid grid-cols-1 gap-2">
                          {taughtButNotKac.length ? taughtButNotKac.map((p) => renderFacultyCard(p)) : <div className="text-sm text-gray-500">None listed.</div>}
                        </div>
                      </details>

                      {/* 3) Qualified by KAC becomes third and is collapsed by default */}
                      <details className="rounded-lg border border-gray-200 bg-white">
                        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-gray-900 flex items-center justify-between">
                          <span>Qualified by KAC (no recorded history)</span>
                          <span className="text-xs text-gray-500">{qualifiedKacNoHistory.length}</span>
                        </summary>
                        <div className="p-3 grid grid-cols-1 gap-2">
                          {qualifiedKacNoHistory.length ? (
                            qualifiedKacNoHistory.map((p) => renderFacultyCard(p, { showNoHistoryText: true }))
                          ) : (
                            <div className="text-sm text-gray-500">None listed.</div>
                          )}
                        </div>
                      </details>
                    </div>
                  </div>

                  <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                    <h3 className="text-md font-semibold text-emerald-700 mb-2">Preferences (Planning Term)</h3>
                    <p className="text-xs text-gray-600 mb-3">{planningTermLabel}</p>

                    {typeof data.preferences === "string" ? (
                      <p className="text-sm text-gray-700">{data.preferences}</p>
                    ) : prefsUnique.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {prefsUnique.map((p) => (
                          <button
                            key={p.faculty_id}
                            type="button"
                            onClick={() => {
                              const termPart = planningTermId ? `&termId=${encodeURIComponent(planningTermId)}` : "";
                              navigate(`/om/home/faculty-form?facultyId=${encodeURIComponent(p.faculty_id)}${termPart}&open=1`);
                            }}
                            className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
                          >
                            {fullName(p.last_name, p.first_name)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-gray-500 text-sm">No matching preference records.</p>
                    )}
                  </div>

                  <div className="md:col-span-2 bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                    <h3 className="text-md font-semibold text-emerald-700 mb-1">Past Instructors Insight</h3>
                    <p className="text-xs text-gray-600 mb-3">
                      {`${Number(metrics?.unique_instructors ?? 0)} instructor(s) have taught this course across all terms.`}
                    </p>

                    {!data.past_instructors_top3 || data.past_instructors_top3.length === 0 ? (
                      <p className="text-gray-500">None listed.</p>
                    ) : (
                      <>
                        <h4 className="font-semibold text-gray-700 mb-2">Top 3 Most Frequent Instructors</h4>
                        <ul className="space-y-2">
                          {data.past_instructors_top3.map((pi, i) => (
                            <li
                              key={pi.faculty_id}
                              className="flex items-center justify-between p-3 bg-gray-50 rounded-md border border-gray-100"
                            >
                              <div className="flex items-center space-x-3 min-w-0">
                                <span
                                  className={`text-xl font-extrabold ${
                                    i === 0 ? "text-yellow-600" : i === 1 ? "text-slate-500" : "text-amber-700"
                                  }`}
                                >
                                  #{i + 1}
                                </span>
                                <div className="truncate font-semibold text-gray-800">{fullName(pi.last_name, pi.first_name)}</div>
                              </div>
                              <div className="text-sm text-gray-700">
                                Taught <span className="font-bold text-lg text-emerald-700">{Number(pi.count ?? 0)}</span> sections
                              </div>
                            </li>
                          ))}
                        </ul>

                        {(() => {
                          const otherCount = data.past_instructors_remaining_count || (data.past_instructors_others?.length ?? 0);
                          if (!otherCount) return null;
                          return (
                            <div className="mt-3">
                              <button
                                type="button"
                                onClick={() => setShowOtherInstructors((v) => !v)}
                                className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
                              >
                                <span>
                                  {showOtherInstructors ? "Hide" : "Show"} {otherCount} other instructor(s)
                                </span>
                                {showOtherInstructors ? <ChevronUp className="h-4 w-4 text-gray-600" /> : <ChevronDown className="h-4 w-4 text-gray-600" />}
                              </button>

                              {showOtherInstructors && (
                                <div className="mt-2 max-h-64 overflow-auto rounded-md border border-gray-200 bg-white">
                                  {data.past_instructors_others && data.past_instructors_others.length ? (
                                    <ul className="divide-y">
                                      {data.past_instructors_others.map((pi) => (
                                        <li key={pi.faculty_id} className="flex items-center justify-between px-3 py-2">
                                          <div className="text-sm font-medium text-gray-800">{fullName(pi.last_name, pi.first_name)}</div>
                                          <div className="text-sm text-gray-600">
                                            <span className="font-semibold text-emerald-700">{Number(pi.count ?? 0)}</span> time(s)
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  ) : (
                                    <div className="px-3 py-2 text-sm text-gray-500">No details available.</div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
