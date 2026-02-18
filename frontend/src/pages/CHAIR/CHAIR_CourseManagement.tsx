import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import SelectBox from "../../component/SelectBox";
import {
  ChevronDown,
  ChevronUp,
  Search as SearchIcon,
  FileText,
  X as XIcon,
  Users,
  Edit,
  Plus,
  X,
} from "lucide-react";
import {
  getChairCMOptions,
  listChairCMCourses,
  updateChairCoursePeople,
  type CMOptions,
  type CMCourseRow,
} from "../../api";

function ViewSyllabusButton({ onView }: { onView: () => void }) {
  return (
    <div className="relative inline-flex justify-center group">
      <button
        type="button"
        aria-label="View Syllabus"
        onClick={onView}
        className="inline-flex items-center gap-2  px-3 py-2 text-xs font-medium text-gray-800 hover:bg-gray-50"
      >
        <FileText className="h-4 w-4" />
        <span>Syllabus</span>
      </button>

      {/* Tooltip */}
      <div className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100">
        <div className="rounded-md bg-gray-900 px-2 py-1 text-xs text-white shadow">View Syllabus</div>
        <div className="mx-auto h-0 w-0 border-x-8 border-x-transparent border-t-8 border-t-gray-900" />
      </div>
    </div>
  );
}

function EditPeopleButton({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="relative inline-flex justify-center group">
      <button
        type="button"
        aria-label="Edit People"
        onClick={onEdit}
        className="inline-flex items-center gap-2  px-3 py-2 text-xs font-medium text-gray-800 hover:bg-gray-50"
      >
        <Edit className="h-4 w-4" />
        <span>People</span>
      </button>

      {/* Tooltip */}
      <div className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100">
        <div className="rounded-md bg-gray-900 px-2 py-1 text-xs text-white shadow">Edit People</div>
        <div className="mx-auto h-0 w-0 border-x-8 border-x-transparent border-t-8 border-t-gray-900" />
      </div>
    </div>
  );
}

function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "emerald" | "blue" }) {
  const cls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : tone === "blue"
        ? "bg-sky-50 text-sky-700 ring-sky-200"
        : "bg-gray-100 text-gray-700 ring-gray-200";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>
      {children}
    </span>
  );
}

function InitialsAvatar({ name }: { name: string }) {
  const initials = useMemo(() => {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? "?";
    const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (a + b).toUpperCase();
  }, [name]);

  return (
    <span
      aria-hidden="true"
      className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-700 ring-1 ring-inset ring-gray-200"
    >
      {initials}
    </span>
  );
}

function CompactPeopleList({
  people,
  max = 3,
}: {
  people: Array<{ name?: string; email?: string }>;
  max?: number;
}) {
  const shown = people.slice(0, max);
  const remaining = Math.max(0, people.length - shown.length);
  return (
    <div className="space-y-2">
      {shown.map((p, idx) => {
        const label = p.name || p.email || "—";
        return (
          <div key={`${label}-${idx}`} className="flex items-start gap-2 rounded-xl bg-gray-50 p-2">
            <InitialsAvatar name={label} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-gray-900">{p.name || "—"}</div>
              {p.email && <div className="truncate text-xs text-gray-500">{p.email}</div>}
            </div>
          </div>
        );
      })}

      {remaining > 0 && (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 ring-1 ring-inset ring-gray-200">
          +{remaining} more
        </span>
      )}
    </div>
  );
}

type Person = { name?: string; email?: string };

function isPerson(v: unknown): v is Person {
  return !!v && typeof v === "object" && ("name" in (v as any) || "email" in (v as any));
}

function NameWithEmailTooltip({ person }: { person: Person }) {
  const name = person.name || person.email || "—";
  const email = person.email?.trim();

  return (
    <span className="relative inline-flex items-center gap-2 rounded-full bg-gray-50 px-2 py-1 text-xs text-gray-800 ring-1 ring-inset ring-gray-200 group">
      <InitialsAvatar name={name} />
      <span className="max-w-[240px] truncate">{name}</span>

      {email ? (
        <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="block rounded-md bg-gray-900 px-2 py-1 text-xs text-white shadow">{email}</span>
          <span className="mx-auto block h-0 w-0 border-x-8 border-x-transparent border-t-8 border-t-gray-900" />
        </span>
      ) : null}
    </span>
  );
}

const isDrive = (u?: string) => !!u && /(?:drive|docs)\.google\.com/i.test(u);
const toPreview = (u: string) =>
  u.includes("/view")
    ? u.replace("/view", "/preview")
    : u.includes("?usp=sharing")
      ? u.replace("?usp=sharing", "/preview")
      : u;

type NamePair = { first_name: string; last_name: string };

function splitName(full: string): NamePair {
  const s = String(full || "").trim().replace(/\s+/g, " ");
  if (!s) return { first_name: "", last_name: "" };
  const parts = s.split(" ");
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

function EditPeopleModal({
  open,
  onClose,
  course,
  onSaved,
  userEmail,
  userId,
}: {
  open: boolean;
  onClose: () => void;
  course: CMCourseRow | null;
  onSaved: (patch: Partial<CMCourseRow>) => void;
  userEmail?: string;
  userId?: string;
}) {
  const [coordinators, setCoordinators] = useState<NamePair[]>([]);
  const [team, setTeam] = useState<NamePair[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    if (!open || !course) return;

    const initCoords: NamePair[] =
      (Array.isArray(course.coordinators) && course.coordinators.length
        ? course.coordinators.map((c: { name?: string }) => splitName(c?.name || ""))
        : course.coordinator_name
          ? course.coordinator_name.split(/\s*;\s*/).map((n: string) => splitName(n))
          : [])
        .filter((x: NamePair) => x.first_name || x.last_name);

    const initTeam: NamePair[] = (Array.isArray(course.composition) ? course.composition : [])
      .map((n: string) => splitName(String(n || "")))
      .filter((x: NamePair) => x.first_name || x.last_name);

    setCoordinators(initCoords.length ? initCoords : [{ first_name: "", last_name: "" }]);
    setTeam(initTeam.length ? initTeam : [{ first_name: "", last_name: "" }]);
    setErr("");
  }, [open, course]);

  function updateItem(list: NamePair[], i: number, key: keyof NamePair, val: string) {
    const next = list.slice();
    next[i] = { ...next[i], [key]: val };
    return next;
  }

  async function save() {
    if (!course) return;
    setSaving(true);
    setErr("");
    try {
      const payload = {
        coordinators: coordinators
          .map((n) => ({ first_name: (n.first_name || "").trim(), last_name: (n.last_name || "").trim() }))
          .filter((n) => n.first_name || n.last_name),
        teaching_team: team
          .map((n) => ({ first_name: (n.first_name || "").trim(), last_name: (n.last_name || "").trim() }))
          .filter((n) => n.first_name || n.last_name),
        userId,
        userEmail,
      };

      const res = await updateChairCoursePeople(course.course_id, payload);
      if (!res?.ok) throw new Error(res?.message || "Update failed.");

      onSaved({
        coordinators: (res.coordinators || []).map((c: { name: string; email?: string }) => ({ name: c.name, email: c.email })),
        coordinator_name: (res.coordinators || []).map((c: { name: string }) => c.name).join("; "),
        coordinator_email: res?.coordinators?.[0]?.email || "",
        composition: (res.teaching_team || []).map((t: { name: string }) => t.name),
      });

      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to update people.");
    } finally {
      setSaving(false);
    }
  }

  if (!open || !course) return null;

  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl overflow-y-auto max-h-[90vh]">
        <div className="flex items-start justify-between border-b border-gray-100 p-6">
          <div>
            <h2 className="text-lg font-semibold text-emerald-700">Edit People</h2>
            <div className="mt-1 text-sm text-gray-600">
              {course.code || "—"} · {course.title || "—"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {err && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

          <section>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Course Coordinator(s)</div>
            <div className="space-y-2">
              {coordinators.map((p, i) => (
                <div key={i} className="flex flex-wrap gap-2 items-center rounded-2xl border border-gray-200 p-3">
                  <input
                    value={p.first_name}
                    onChange={(e) => setCoordinators(updateItem(coordinators, i, "first_name", e.target.value))}
                    placeholder="First name"
                    className="flex-1 min-w-[160px] rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={p.last_name}
                    onChange={(e) => setCoordinators(updateItem(coordinators, i, "last_name", e.target.value))}
                    placeholder="Last name"
                    className="flex-1 min-w-[160px] rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setCoordinators((xs) => xs.filter((_, idx) => idx !== i))}
                    disabled={coordinators.length <= 1}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={() => setCoordinators((xs) => [...xs, { first_name: "", last_name: "" }])}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                <Plus className="h-4 w-4" /> Add coordinator
              </button>
            </div>
          </section>

          <section>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Teaching Composition</div>
            <div className="space-y-2">
              {team.map((p, i) => (
                <div key={i} className="flex flex-wrap gap-2 items-center rounded-2xl border border-gray-200 p-3">
                  <input
                    value={p.first_name}
                    onChange={(e) => setTeam(updateItem(team, i, "first_name", e.target.value))}
                    placeholder="First name"
                    className="flex-1 min-w-[160px] rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={p.last_name}
                    onChange={(e) => setTeam(updateItem(team, i, "last_name", e.target.value))}
                    placeholder="Last name"
                    className="flex-1 min-w-[160px] rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setTeam((xs) => xs.filter((_, idx) => idx !== i))}
                    disabled={team.length <= 1}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={() => setTeam((xs) => [...xs, { first_name: "", last_name: "" }])}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                <Plus className="h-4 w-4" /> Add instructor
              </button>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 p-6">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm" disabled={saving}>
            Cancel
          </button>
          <button
            onClick={save}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-60"
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CHAIR_CourseManagement() {
  const TEACHING_COMPOSITION_PREVIEW_COUNT = 7;
  const session = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  }, []);
  const userEmail = session?.email || session?.userEmail;
  const userId = session?.userId;

  const [clusters, setClusters] = useState<string[]>(["All Clusters"]);
  const [cluster, setCluster] = useState("All Clusters");
  const [termLabel, setTermLabel] = useState("");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const searchRef = useRef<HTMLInputElement | null>(null);

  const [rows, setRows] = useState<CMCourseRow[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const [syllabusUrl, setSyllabusUrl] = useState<string>("");
  const [showSyllabus, setShowSyllabus] = useState(false);

  const [expandedCourseId, setExpandedCourseId] = useState<string | number | null>(null);

  const [showEditPeople, setShowEditPeople] = useState(false);
  const [editCourse, setEditCourse] = useState<CMCourseRow | null>(null);

  const grouped = useMemo(() => {
    const by: Record<string, CMCourseRow[]> = {};
    for (const r of rows) {
      const key = (r.kac || "Uncategorized").trim() || "Uncategorized";
      (by[key] ||= []).push(r);
    }
    return Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  useEffect(() => {
    (async () => {
      try {
        const opt: CMOptions = await getChairCMOptions(userEmail, userId);
        setClusters(["All Clusters", ...(opt.clusters || [])]);
        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, [userEmail, userId]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const { ok, rows } = await listChairCMCourses({ userEmail, userId, cluster, search });
        if (!ok) throw new Error("Failed to load courses.");
        setRows(rows);
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load courses.");
      } finally {
        setLoading(false);
      }
    })();
  }, [userEmail, userId, cluster, search]);

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Course Management</h1>
        <p className="text-sm text-gray-600">
          Manage courses with their coordinators, teaching composition, and syllabi for {termLabel || ""}
        </p>
      </header>

      {err && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

      <div className="sticky top-0 z-10 mb-6 -mx-8 px-8 pt-2">
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-white/90 p-4 shadow-sm backdrop-blur">
          <div className="relative flex-1 min-w-[240px]">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              ref={searchRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by course code, title, coordinator, or teaching composition…"
              className="w-full rounded-lg border border-gray-300 pl-9 pr-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
            />

            {searchInput.trim().length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearchInput("");
                  setSearch("");
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-neutral-500 hover:bg-gray-100 hover:text-neutral-700"
              >
                <XIcon className="h-4 w-4" />
              </button>
            )}
          </div>
          <SelectBox value={cluster} onChange={setCluster} options={clusters} />
        </div>
      </div>

      <section className="space-y-6">
        {loading ? (
          <div className="grid gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="h-4 w-48 rounded bg-gray-100" />
                <div className="mt-3 h-3 w-72 rounded bg-gray-100" />
                <div className="mt-4 h-8 w-full rounded bg-gray-50" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
            <div className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-2xl bg-gray-50">
              <Users className="h-6 w-6 text-gray-400" />
            </div>
            <div className="text-sm font-medium text-gray-900">No results</div>
            <div className="mt-1 text-sm text-gray-500">Try a different search term or cluster filter.</div>
          </div>
        ) : (
          grouped.map(([kac, items]) => (
            <div key={kac} className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-900">{kac}</h2>
                  <Badge tone="blue">{items.length} course{items.length === 1 ? "" : "s"}</Badge>
                </div>
              </div>

              <div className="grid gap-4">
                {items.map((r) => {
                  const coordinators =
                    r.coordinators && r.coordinators.length > 0
                      ? r.coordinators
                      : [{ name: r.coordinator_name, email: r.coordinator_email }];

                  const compositionRaw = Array.isArray(r.composition) ? r.composition.filter(Boolean) : [];
                  const composition: Person[] = compositionRaw
                    .map((v) => (typeof v === "string" ? ({ name: v } as Person) : isPerson(v) ? v : ({ name: String(v) } as Person)))
                    .filter((p) => (p.name || p.email) && String(p.name || p.email).trim().length > 0);

                  const sortedComposition = composition
                    .slice()
                    .sort((a, b) => String(a.name || a.email || "").localeCompare(String(b.name || b.email || ""), undefined, { sensitivity: "base" }));

                  const hasMoreDetails =
                    (coordinators?.filter((c) => c?.name || c?.email).length || 0) > 2 ||
                    sortedComposition.length > TEACHING_COMPOSITION_PREVIEW_COUNT;
                  const isExpanded = expandedCourseId === r.course_id;

                  return (
                    <div key={r.course_id} className="rounded-2xl border border-gray-200 bg-white shadow-sm transition hover:shadow">
                      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                        <button
                          type="button"
                          disabled={!hasMoreDetails}
                          onClick={() => {
                            if (!hasMoreDetails) return;
                            setExpandedCourseId(isExpanded ? null : r.course_id);
                          }}
                          className={`group flex-1 text-left ${hasMoreDetails ? "cursor-pointer" : "cursor-default"}`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-emerald-700 group-hover:underline">{r.code || "—"}</span>
                            <Badge tone="emerald">{r.units ?? "—"} unit{Number(r.units) === 1 ? "" : "s"}</Badge>
                          </div>
                          <div className="mt-1 text-sm text-gray-800">{r.title || "—"}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                            <span className="inline-flex items-center gap-1">
                              <Users className="h-3.5 w-3.5" />
                              {sortedComposition.length
                                ? `${sortedComposition.length} instructor${sortedComposition.length === 1 ? "" : "s"}`
                                : "No teaching composition"}
                            </span>
                          </div>
                        </button>

                        <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-end">
                          <div className="flex items-center gap-2">
                            <ViewSyllabusButton
                              onView={() => {
                                setSyllabusUrl(r.syllabus || "");
                                setShowSyllabus(true);
                              }}
                            />
                            <EditPeopleButton
                              onEdit={() => {
                                setEditCourse(r);
                                setShowEditPeople(true);
                              }}
                            />
                          </div>

                          {hasMoreDetails && (
                            <button
                              type="button"
                              onClick={() => setExpandedCourseId(isExpanded ? null : r.course_id)}
                              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              {isExpanded ? (
                                <>
                                  Less <ChevronUp className="h-4 w-4" />
                                </>
                              ) : (
                                <>
                                  See more <ChevronDown className="h-4 w-4" />
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="border-t border-gray-100">
                        <div className="p-4">
                          <div className="grid gap-4 md:grid-cols-4">
                            <div className="md:col-span-1">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Course Coordinator(s)</div>
                              {coordinators.some((c) => c?.name || c?.email) ? (
                                isExpanded ? (
                                  <div className="space-y-2">
                                    {coordinators.map((c, idx) => (
                                      <div key={idx} className="flex items-start gap-2 rounded-xl bg-gray-50 p-2">
                                        <InitialsAvatar name={c.name || c.email || "—"} />
                                        <div className="min-w-0">
                                          <div className="truncate text-sm font-medium text-gray-900">{c.name || "—"}</div>
                                          {c.email && <div className="truncate text-xs text-gray-500">{c.email}</div>}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <CompactPeopleList people={coordinators} max={2} />
                                )
                              ) : (
                                <div className="text-sm text-gray-500">—</div>
                              )}
                            </div>

                            <div className="md:col-span-3">
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Teaching Composition</div>
                              {sortedComposition.length ? (
                                isExpanded ? (
                                  <div className="flex flex-wrap gap-2">
                                    {sortedComposition.map((p, idx) => (
                                      <NameWithEmailTooltip key={`${p.name || p.email || "—"}-${idx}`} person={p} />
                                    ))}
                                  </div>
                                ) : (
                                  <div className="flex flex-wrap gap-2">
                                    {sortedComposition.slice(0, TEACHING_COMPOSITION_PREVIEW_COUNT).map((p, idx) => (
                                      <NameWithEmailTooltip key={`${p.name || p.email || "—"}-${idx}`} person={p} />
                                    ))}
                                    {sortedComposition.length > TEACHING_COMPOSITION_PREVIEW_COUNT && (
                                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 ring-1 ring-inset ring-gray-200">
                                        +{sortedComposition.length - TEACHING_COMPOSITION_PREVIEW_COUNT} more
                                      </span>
                                    )}
                                  </div>
                                )
                              ) : (
                                <div className="text-sm text-gray-500">—</div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </section>

      {showSyllabus && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
            <h2 className="text-lg font-semibold text-emerald-700 mb-4">Syllabus</h2>
            {!syllabusUrl ? (
              <p className="text-gray-500 italic">No syllabus link provided.</p>
            ) : (
              <>
                <p className="mb-3">
                  Syllabus Link:
                  <a href={syllabusUrl} target="_blank" rel="noopener noreferrer" className="text-emerald-700 underline ml-2">
                    Open in New Tab
                  </a>
                </p>
                {isDrive(syllabusUrl) && <iframe className="w-full h-[500px] border rounded-xl" title="Syllabus" src={toPreview(syllabusUrl)} />}
              </>
            )}
            <div className="flex justify-end mt-6">
              <button onClick={() => setShowSyllabus(false)} className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <EditPeopleModal
        open={showEditPeople}
        onClose={() => {
          setShowEditPeople(false);
          setEditCourse(null);
        }}
        course={editCourse}
        userEmail={userEmail}
        userId={userId}
        onSaved={(patch) => {
          if (!editCourse) return;
          setRows((prev) => prev.map((r) => (r.course_id === editCourse.course_id ? ({ ...r, ...patch } as CMCourseRow) : r)));
        }}
      />
    </main>
  );
}
