import { useEffect, useRef, useState } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import { AlertTriangle, CalendarClock, Check, Edit, Info, Search as SearchIcon, X } from "lucide-react";
import {
  getOMSPOptions,
  listOMSP,
  updateOMSPCourse,
  startOMSPWindow,
  type OMPetitionRow,
  type OMPetitionOptions,
} from "../../api";
import { getSessionUserId } from "../../lib/session";

function useCountdown(targetISO: string) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const target = new Date(targetISO || 0).getTime();
  const diff = Math.max(0, target - now);
  const past = targetISO ? now > target : false;
  const d = Math.floor(diff / (1000 * 60 * 60 * 24));
  const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const m = Math.floor((diff / (1000 * 60)) % 60);
  const s = Math.floor(diff / 1000) % 60;
  const label = past ? "Deadline passed" : `${d}d ${h}h ${m}m ${s}s`;
  return { past, label };
}

function DeadlineBanner({
  deadlineISO,
  className,
}: {
  deadlineISO: string;
  className?: string;
}) {
  if (!deadlineISO) {
    return (
      <div className={cls("mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700", className)}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid h-9 w-9 place-items-center rounded-full bg-slate-200 text-slate-700">
            <Info className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold">Submission Window Not Started</div>
            <div className="text-xs text-slate-600">
              Set a deadline above. Until then, students will not be able to submit requests for this term.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { past: deadlinePassed, label: deadlineLabel } = useCountdown(deadlineISO);

  if (deadlinePassed) {
    return (
      <div className={cls("mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900", className)}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid h-9 w-9 place-items-center rounded-full bg-red-200 text-red-900">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold">Editing Locked</div>
            <div className="text-xs text-red-800">Deadline: {deadlineISO ? new Date(deadlineISO).toLocaleString() : "—"}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cls("mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950", className)}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid h-9 w-9 place-items-center rounded-full bg-amber-200 text-amber-900">
          <CalendarClock className="h-5 w-5" />
        </div>
        <div>
          <div className="font-semibold">Submission Deadline Approaching</div>
          <div className="text-xs text-amber-900">
            Deadline: {deadlineISO ? new Date(deadlineISO).toLocaleString() : "—"} · {deadlineISO ? deadlineLabel : "TBA"}
          </div>
        </div>
      </div>
    </div>
  );
}

function toLocalInput(isoOrDate: string) {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function nextMinuteFrom(date = new Date()) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  return d;
}

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
  return (
    <div className={className}>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          rows={3}
          className={cls(
            "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm resize-none",
            "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
            disabled && "cursor-not-allowed bg-gray-100 text-gray-400 opacity-70"
          )}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={cls(
            "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
            "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
            disabled && "cursor-not-allowed bg-gray-100 text-gray-400 opacity-70"
          )}
        />
      )}
    </div>
  );
}

const STATUS_PILL: Record<string, string> = {
  "Less Than Minimum": "bg-amber-100 text-amber-800",
  "Forwarded To Department": "bg-amber-50 text-amber-800",
  Rejected: "bg-red-100 text-red-800",
  "Wait For Frosh Block": "bg-purple-100 text-purple-800",
  "Wait For College Enlistment": "bg-yellow-100 text-yellow-800",
  "Open Slots Available": "bg-green-100 text-green-800",
  "New Class Opened": "bg-green-100 text-green-800",
  "Advised For Special Class": "bg-indigo-100 text-indigo-800",
  "Slots Increased": "bg-teal-100 text-teal-800",
};

function pillClass(status?: string) {
  if (!status) return "bg-gray-100 text-gray-600";
  return STATUS_PILL[status] || "bg-gray-100 text-gray-600";
}

export default function OM_StudentPetition() {
  const [status, setStatus] = useState("All Status");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [statuses, setStatuses] = useState<string[]>(["All Status"]);
  const [activeTerm, setActiveTerm] = useState<OMPetitionOptions["activeTerm"] | null>(null);
  const [activeTermLabel, setActiveTermLabel] = useState<string>("");
  const [submissionWindow, setSubmissionWindow] = useState<{ openISO: string; deadlineISO: string }>({
    openISO: "",
    deadlineISO: "",
  });
  const [deadlineDraft, setDeadlineDraft] = useState("");
  const [startingWindow, setStartingWindow] = useState(false);

  const [rows, setRows] = useState<OMPetitionRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [editCourseId, setEditCourseId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status?: string; remarks?: string }>({});

  const confirmResolverRef = useRef<((v: boolean) => void) | null>(null);
  const [confirmState, setConfirmState] = useState<
    | {
        title: string;
        message: string;
        accent: "emerald" | "amber";
        confirmText: string;
        note?: string;
      }
    | null
  >(null);

  const openConfirm = (payload: {
    title: string;
    message: string;
    accent: "emerald" | "amber";
    confirmText: string;
    note?: string;
  }) =>
    new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmState(payload);
    });

  const closeConfirm = (result: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState(null);
    resolver?.(result);
  };

  useEffect(() => {
    (async () => {
      try {
        const opt: OMPetitionOptions = await getOMSPOptions();
        if (!opt.ok) throw new Error("Failed to load options");
        setStatuses(["All Status", ...(opt.statuses || [])]);
        setActiveTerm(opt.activeTerm || null);
        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setActiveTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");
        const win = opt.submission_window || {};
        const nextWindow = {
          openISO: win.openISO || "",
          deadlineISO: win.deadlineISO || "",
        };
        setSubmissionWindow(nextWindow);
        if (nextWindow.deadlineISO) {
          setDeadlineDraft(toLocalInput(nextWindow.deadlineISO));
        } else {
          const base = nextMinuteFrom();
          const plus7 = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
          setDeadlineDraft(toLocalInput(plus7.toISOString()));
        }
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
        setSelected((sel) => sel.filter((cid) => rows.some((r) => r.course_id === cid)));
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load petitions.");
      } finally {
        setLoading(false);
      }
    })();
  }, [status, search]);

  const toggleAll = (checked: boolean) => setSelected(checked ? rows.map((r) => r.course_id) : []);

  const beginEdit = (row: OMPetitionRow) => {
    setEditCourseId(row.course_id);
    setDraft({ status: row.status, remarks: row.remarks || "" });
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

  const handleStartWindow = async () => {
    if (startingWindow) return;

    const deadlineDate = new Date(deadlineDraft);
    if (!deadlineDraft || Number.isNaN(deadlineDate.getTime())) {
      setErr("Please provide a valid deadline date and time.");
      return;
    }

    const minDeadlineDate = nextMinuteFrom();
    if (deadlineDate.getTime() < minDeadlineDate.getTime()) {
      setErr(`Deadline must be at or after ${minDeadlineDate.toLocaleString()}.`);
      return;
    }

    const openDate = new Date();

    const ok = await openConfirm({
      title: "Set submission deadline?",
      message: `Set the submission deadline to ${deadlineDate.toLocaleString()}? This will apply immediately.`,
      accent: "emerald",
      confirmText: "Set deadline",
      note: `Students will be able to submit immediately until the selected deadline. The earliest valid deadline is ${minDeadlineDate.toLocaleString()}.`,
    });
    if (!ok) return;

    try {
      setStartingWindow(true);
      setErr("");
      const data = await startOMSPWindow({
        termId: activeTerm?.term_id,
        openISO: openDate.toISOString(),
        deadlineISO: deadlineDate.toISOString(),
      });
      if (!data?.ok || !data.submission_window) throw new Error("Failed to set submission window.");

      setSubmissionWindow({
        openISO: data.submission_window.openISO || "",
        deadlineISO: data.submission_window.deadlineISO || "",
      });
      setDeadlineDraft(toLocalInput(data.submission_window.deadlineISO || deadlineDate.toISOString()));
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to set submission window.");
    } finally {
      setStartingWindow(false);
    }
  };

  const minDeadlineLocal = toLocalInput(nextMinuteFrom().toISOString());

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Student Petition</h1>
          <p className="text-sm text-gray-600">Manage course section requests {activeTermLabel && `for ${activeTermLabel}`}</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-700">Deadline</span>
              <input
                type="datetime-local"
                min={minDeadlineLocal}
                className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                value={deadlineDraft}
                onChange={(e) => setDeadlineDraft(e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={handleStartWindow}
              disabled={startingWindow}
              className="inline-flex h-9 items-center rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
              title="Set or update the submission deadline"
            >
              {startingWindow ? "Saving…" : "Set Deadline"}
            </button>
          </div>
        </div>
      </header>

      <DeadlineBanner deadlineISO={submissionWindow.deadlineISO} className="mb-6" />

      {err && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="relative min-w-[240px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by course code or title…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>
        <SelectBox value={status} onChange={setStatus} options={statuses} />
      </div>

      <div className="overflow-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full table-auto text-sm">
          <thead className="border-b bg-gray-50 text-gray-900">
            <tr>
              <th className="w-10 px-3 py-2 text-center">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.length === rows.length}
                  onChange={(e) => toggleAll(e.target.checked)}
                  className="h-4 w-4 accent-emerald-600"
                />
              </th>
              <th className="px-4 py-2 text-left">Course Code & Title</th>
              <th className="px-4 py-2 text-center">Petition Count</th>
              <th className="px-4 py-2 text-center">Status</th>
              <th className="w-[40%] px-4 py-2 text-left">Remarks</th>
              <th className="w-10 px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-center text-gray-500" colSpan={6}>
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-gray-500" colSpan={6}>
                  No results
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const editing = editCourseId === r.course_id;
                return (
                  <tr key={r.course_id} className="align-top hover:bg-gray-50">
                    <td className="px-3 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={selected.includes(r.course_id)}
                        onChange={() =>
                          setSelected((prev) =>
                            prev.includes(r.course_id) ? prev.filter((id) => id !== r.course_id) : [...prev, r.course_id]
                          )
                        }
                        className="h-4 w-4 accent-emerald-600"
                      />
                    </td>
                    <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                      {r.course_code}
                      <div className="text-xs text-gray-500">{r.course_title}</div>
                    </td>
                    <td className="px-4 py-3 text-center">{r.count}</td>
                    <td className="px-4 py-3 text-center">
                      {editing ? (
                        <SelectBox
                          value={draft.status || ""}
                          onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                          options={statuses.filter((s) => s !== "All Status")}
                        />
                      ) : (
                        <span className={cls("inline-block rounded-full px-3 py-1 text-xs font-semibold", pillClass(r.status))}>
                          {r.status || "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-left">
                      {editing ? (
                        <TextBox
                          value={draft.remarks || ""}
                          onChange={(v) => setDraft((d) => ({ ...d, remarks: v }))}
                          placeholder="Add remarks…"
                          multiline
                          className="w-full"
                        />
                      ) : (
                        <span className="block whitespace-pre-wrap text-gray-700">{r.remarks || <span className="text-gray-400">—</span>}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {editing ? (
                        <button
                          onClick={saveEdit}
                          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                          title="Save"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      ) : (
                        <button onClick={() => beginEdit(r)} className="text-emerald-700 hover:brightness-110" title="Edit">
                          <Edit className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {confirmState && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
            <div
              className={cls(
                "flex items-start gap-3 px-5 py-4 text-white",
                confirmState.accent === "amber" ? "bg-amber-600" : "bg-emerald-700"
              )}
            >
              <div className="mt-0.5 rounded-full bg-white/15 p-2">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold">{confirmState.title}</div>
                {confirmState.note && <div className="mt-1 text-sm text-white/85">{confirmState.note}</div>}
              </div>
              <button
                type="button"
                onClick={() => closeConfirm(false)}
                className="rounded-lg p-1 text-white/90 transition hover:bg-white/10"
                aria-label="Close confirmation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-5 py-4 text-sm whitespace-pre-line text-slate-700">{confirmState.message}</div>
            <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-4">
              <button
                type="button"
                onClick={() => closeConfirm(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => closeConfirm(true)}
                className={cls(
                  "rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm",
                  confirmState.accent === "amber" ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-700 hover:bg-emerald-800"
                )}
              >
                {confirmState.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
