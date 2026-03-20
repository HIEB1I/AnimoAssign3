import { useEffect, useState, type ReactNode } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import { Check, Search as SearchIcon, Edit, X } from "lucide-react";
import {
  getOMSPOptions,
  listOMSP,
  updateOMSPCourse,
  type OMPetitionRow,
  type OMPetitionOptions,
} from "../../api";
import { getSessionUserId } from "../../lib/session";

function TextBox({
  value,
  onChange,
  placeholder = "Enter text...",
  className = "",
  disabled = false,
  multiline = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  multiline?: boolean;
}) {
  const controlClass = cls(
    "w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm shadow-sm transition",
    "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none",
    disabled && "cursor-not-allowed bg-gray-100 text-gray-400 opacity-70"
  );

  return (
    <div className={className}>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          rows={3}
          className={cls(controlClass, "resize-none")}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={controlClass}
        />
      )}
    </div>
  );
}

const STATUS_PILL: Record<string, string> = {
  "Less Than Minimum": "bg-amber-100 text-amber-800 ring-amber-200",
  "Forwarded To Department": "bg-amber-50 text-amber-800 ring-amber-200",
  Rejected: "bg-red-100 text-red-800 ring-red-200",
  "Wait For Frosh Block": "bg-purple-100 text-purple-800 ring-purple-200",
  "Wait For College Enlistment": "bg-yellow-100 text-yellow-800 ring-yellow-200",
  "Open Slots Available": "bg-green-100 text-green-800 ring-green-200",
  "New Class Opened": "bg-green-100 text-green-800 ring-green-200",
  "Advised For Special Class": "bg-indigo-100 text-indigo-800 ring-indigo-200",
  "Slots Increased": "bg-teal-100 text-teal-800 ring-teal-200",
};

function pillClass(status?: string) {
  if (!status) return "bg-gray-100 text-gray-600 ring-gray-200";
  return STATUS_PILL[status] || "bg-gray-100 text-gray-600 ring-gray-200";
}

function SectionShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="bg-gradient-to-r from-slate-900 via-emerald-900 to-emerald-700 px-5 py-5 text-white">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-white/80">{subtitle}</p>
      </div>
      <div className="bg-gray-50 p-5">{children}</div>
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500 shadow-sm">
      {text}
    </div>
  );
}

function InlineDetail({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cls("min-w-0 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3", className)}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 min-w-0 text-sm text-gray-900">{children}</div>
    </div>
  );
}

export default function OM_StudentPetition() {
  const [status, setStatus] = useState("All Status");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [statuses, setStatuses] = useState<string[]>(["All Status"]);
  const [activeTermLabel, setActiveTermLabel] = useState<string>("");

  const [rows, setRows] = useState<OMPetitionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [editCourseId, setEditCourseId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status?: string; remarks?: string }>({});

  useEffect(() => {
    (async () => {
      try {
        const opt: OMPetitionOptions = await getOMSPOptions();
        if (!opt.ok) throw new Error("Failed to load options");
        setStatuses(["All Status", ...(opt.statuses || [])]);
        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setActiveTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const { ok, rows } = await listOMSP({ status, search });
        if (!ok) throw new Error("Failed to load petitions.");
        setRows(rows);
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load petitions.");
      } finally {
        setLoading(false);
      }
    })();
  }, [status, search]);

  const beginEdit = (row: OMPetitionRow) => {
    setEditCourseId(row.course_id);
    setDraft({ status: row.status, remarks: row.remarks || "" });
  };

  const cancelEdit = () => {
    setEditCourseId(null);
    setDraft({});
  };

  const saveEdit = async () => {
    if (!editCourseId) return;
    try {
      setLoading(true);
      setErr("");
      await updateOMSPCourse(editCourseId, draft, getSessionUserId());
      const { rows } = await listOMSP({ status, search });
      setRows(rows);
      setEditCourseId(null);
      setDraft({});
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to update course petitions.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen w-full bg-gray-50 px-8 py-8 text-slate-900">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Student Petition</h1>
        <p className="text-sm text-gray-600">
          Review petitioned courses, update their status, and keep remarks organized
          {activeTermLabel && ` for ${activeTermLabel}`}
        </p>
      </header>

      {err && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-sm">
          {err}
        </div>
      )}

      <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_260px] xl:items-center">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by course code or title…"
              className={cls(
                "w-full rounded-xl border border-gray-300 bg-white px-10 py-2.5 text-sm shadow-sm transition",
                "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none"
              )}
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
                aria-label="Clear search"
                title="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="min-w-0">
            <SelectBox value={status} onChange={setStatus} options={statuses} />
          </div>
        </div>
      </div>

      <div className="mt-8">
        <SectionShell title="Petitioned Courses" subtitle="">
          <div className="space-y-4">
            {loading ? (
              <div className="rounded-2xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500 shadow-sm">
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <EmptyState text="No results." />
            ) : (
              rows.map((r) => {
                const editing = editCourseId === r.course_id;

                return (
                  <article
                    key={r.course_id}
                    className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition"
                  >
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-4">
                          <div className="min-w-0 lg:min-w-[240px] xl:min-w-[280px]">
                            <div className="text-lg font-semibold text-emerald-700">{r.course_code}</div>
                            <div className="text-sm text-gray-600">{r.course_title}</div>
                          </div>

                          <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
                            <InlineDetail label="Petition Count">
                              <span className="font-medium">{r.count}</span>
                            </InlineDetail>

                            <InlineDetail label="Remarks">
                              {editing ? (
                                <TextBox
                                  value={draft.remarks || ""}
                                  onChange={(v) => setDraft((d) => ({ ...d, remarks: v }))}
                                  placeholder="Add remarks…"
                                  multiline
                                  className="w-full"
                                />
                              ) : r.remarks ? (
                                <span className="block whitespace-pre-wrap break-words text-gray-700">
                                  {r.remarks}
                                </span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </InlineDetail>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 self-start xl:justify-end">
                        {!editing ? (
                          <span
                            className={cls(
                              "inline-flex rounded-full px-3 py-1 text-xs font-semibold ring-1",
                              pillClass(r.status)
                            )}
                          >
                            {r.status || "—"}
                          </span>
                        ) : (
                          <div className="min-w-[240px]">
                            <SelectBox
                              value={draft.status || ""}
                              onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                              options={statuses.filter((s) => s !== "All Status")}
                            />
                          </div>
                        )}

                        {editing ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={saveEdit}
                              className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100"
                              title="Save"
                            >
                              <Check className="h-4 w-4" />
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                              title="Cancel"
                            >
                              <X className="h-4 w-4" />
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginEdit(r)}
                            className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-100"
                            title="Edit"
                          >
                            <Edit className="h-4 w-4" />
                            Edit
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </SectionShell>
      </div>
    </main>
  );
}
