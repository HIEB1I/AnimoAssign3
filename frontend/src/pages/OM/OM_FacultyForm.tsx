// frontend/src/pages/OM/OM_FacultyForm.tsx
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  Search as SearchIcon,
  Eye,
  GraduationCap,
  MapPin,
  Calendar,
  CalendarClock,
  BookOpen,
  Info,
  AlertTriangle,
  X,
  PanelRightClose,
} from "lucide-react";
import {
  getOMFOptions,
  listOMFFaculty,
  getOMFPreference,
  type OMFOptions,
  type OMFRow,
  userHasRole, // already exported from api.ts
} from "../../api";

/* ---------- countdown + banner (copied from FACULTY_Preferences) ---------- */
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
  openISO,
  deadlineISO,
  className,
}: {
  openISO: string;
  deadlineISO: string;
  className?: string;
}) {
  const hasWindow = !!openISO && !!deadlineISO;

  // NEW: no window started yet
  if (!hasWindow) {
    return (
      <div className={cls("mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700", className)}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid h-9 w-9 place-items-center rounded-full bg-slate-200 text-slate-700">
            <Info className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold">Submission Window Not Started</div>
            <div className="text-xs text-slate-600">
              Set an opening time and deadline above. Until then, faculty will not be able to submit preferences for this term.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { past: openPassed, label: openLabel } = useCountdown(openISO);
  const { past: deadlinePassed, label: deadlineLabel } = useCountdown(deadlineISO);

  if (!openPassed) {
    return (
      <div className={cls("mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950", className)}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid h-9 w-9 place-items-center rounded-full bg-amber-200 text-amber-900">
            <CalendarClock className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold">Submissions Open In</div>
            <div className="text-xs text-amber-900">
              Opens: {openISO ? new Date(openISO).toLocaleString() : "—"} · {openISO ? openLabel : "TBA"}
            </div>
            <div className="mt-1 text-[11px] text-amber-900/80">Once open, faculty can submit and update their preferences until the deadline.</div>
          </div>
        </div>
      </div>
    );
  }

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
/* ------------------------------------------------------------------------- */

/* ---------------- Page ---------------- */
export default function OM_FacultyForm() {
  const [searchParams] = useSearchParams();
  const deepLinkFacultyId = (searchParams.get('facultyId') || '').trim();
  const deepLinkTermId = (searchParams.get('termId') || '').trim();
  const deepLinkOpen = (searchParams.get('open') || '').trim();
  const shouldAutoOpen = !!deepLinkFacultyId && (deepLinkOpen === '1' || deepLinkOpen.toLowerCase() === 'true');

  // filters
  const [department, setDepartment] = useState("All Departments");
  const [status, setStatus] = useState("All Status");
  const [facultyType, setFacultyType] = useState("All Faculty Type");

  // live search
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // options
  const [deptOptions, setDeptOptions] = useState<string[]>(["All Departments"]);
  const [typeOptions, setTypeOptions] = useState<string[]>(["All Faculty Type"]);
  const [statusOptions, setStatusOptions] = useState<string[]>(["All Status"]);

  // header/term
  const [activeTerm, setActiveTerm] = useState<OMFOptions["activeTerm"] | null>(null);

  // prefs window (open/deadline) for banner
  const [prefsWindow, setPrefsWindow] = useState<{ openISO: string; deadlineISO: string }>({
    openISO: "",
    deadlineISO: "",
  });

  const [startingWindow, setStartingWindow] = useState(false);
  // Exact window schedule (like APO_CourseOfferings)
  const [openDraft, setOpenDraft] = useState<string>("");
  const [deadlineDraft, setDeadlineDraft] = useState<string>("");
  const isOm = userHasRole("Office Manager");

  // table rows
  const [rows, setRows] = useState<OMFRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  // inline preference viewer
  const [selected, setSelected] = useState<OMFRow | null>(null);
  const [pref, setPref] = useState<any>(null);
  const [prefLoading, setPrefLoading] = useState(false);

  /* ---- Custom confirm modal (replaces window.confirm) ---- */
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
  }) => {
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmState(payload);
    });
  };

  const closeConfirm = (result: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState(null);
    resolver?.(result);
  };

  const handleStartWindow = async () => {
    if (startingWindow) return;

    const hasExistingWindow = !!prefsWindow.openISO;

    // Validate deadline datetime
    const deadlineDate = new Date(deadlineDraft);
    if (!deadlineDraft || Number.isNaN(deadlineDate.getTime())) {
      setErr("Please provide a valid deadline date and time.");
      return;
    }

    // If a window was already set before, we auto-open submissions now (today/current)
    // and only let the user update the deadline.
    let openDate: Date;
    if (hasExistingWindow) {
      openDate = new Date();
      openDate.setSeconds(0, 0);
    } else {
      const d = new Date(openDraft);
      if (!openDraft || Number.isNaN(d.getTime())) {
        setErr("Please provide a valid opening date and time.");
        return;
      }
      openDate = d;
    }

    if (deadlineDate.getTime() <= openDate.getTime()) {
      setErr(
        hasExistingWindow
          ? "Deadline must be after the current time."
          : "Deadline must be after the opening date and time."
      );
      return;
    }

    const title = hasExistingWindow
      ? "Set submission deadline?"
      : "Start submission window?";

    const confirmText = hasExistingWindow ? "Set deadline" : "Start window";

    const message = hasExistingWindow
      ? `Set a new submission deadline? This will open submissions immediately and replace the current deadline.

Deadline: ${deadlineDate.toLocaleString()}`
      : `Start submission window with the following schedule?

Opens: ${openDate.toLocaleString()}
Deadline: ${deadlineDate.toLocaleString()}`;

    const ok = await openConfirm({
      title,
      message,
      accent: "emerald",
      confirmText,
      note: hasExistingWindow
        ? "This will apply immediately and replace the current deadline."
        : "This will apply immediately and set the opening time and deadline.",
    });
    if (!ok) return;

    try {
      setStartingWindow(true);
      setErr("");

      const params = new URLSearchParams();
      params.set("action", "startWindow");
      if (activeTerm?.term_id) params.set("termId", activeTerm.term_id);
      params.set("openISO", openDate.toISOString());
      params.set("deadlineISO", deadlineDate.toISOString());

      const res = await fetch(`/api/om/facultyforms?${params.toString()}`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || "Failed to set submission window.");
      }

      if (!data?.ok || !data.prefs_window) {
        throw new Error("Failed to set submission window.");
      }

      setPrefsWindow({
        openISO: data.prefs_window.openISO || "",
        deadlineISO: data.prefs_window.deadlineISO || "",
      });
    } catch (e: any) {
      setErr(
        e?.response?.data?.detail ||
          e?.message ||
          "Failed to set submission window."
      );
    } finally {
      setStartingWindow(false);
    }
  };

  // Load dropdown options
useEffect(() => {
    (async () => {
    try {
    // NEW: trigger deadline reminder generation (safe to call repeatedly; backend dedupes)
    fetch("/api/notifications/run-prefs-deadline-reminders", { method: "POST" }).catch(() => {});


    const opt = await getOMFOptions();
    if (!opt.ok) throw new Error("Failed to load options");
        setDeptOptions(["All Departments", ...opt.departments]);
        setTypeOptions(["All Faculty Type", ...opt.facultyTypes]);
        setActiveTerm(opt.activeTerm || null);
        // pick up window from backend
        setPrefsWindow({
          openISO: opt?.prefs_window?.openISO || "",
          deadlineISO: opt?.prefs_window?.deadlineISO || "",
        });

        // Initialize datetime drafts (prefer existing schedule; else prefill with now + 7 days)
        const toLocalInput = (isoOrDate: string) => {
          const d = new Date(isoOrDate);
          if (Number.isNaN(d.getTime())) return "";
          const pad = (n: number) => String(n).padStart(2, "0");
          const yyyy = d.getFullYear();
          const mm = pad(d.getMonth() + 1);
          const dd = pad(d.getDate());
          const hh = pad(d.getHours());
          const mi = pad(d.getMinutes());
          return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
        };

        const existingOpen = (opt?.prefs_window?.openISO || "").trim();
        const existingDeadline = (opt?.prefs_window?.deadlineISO || "").trim();
        if (existingOpen && existingDeadline) {
          setOpenDraft(toLocalInput(existingOpen));
          setDeadlineDraft(toLocalInput(existingDeadline));
        } else {
          const now = new Date();
          const plus7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          setOpenDraft(toLocalInput(now.toISOString()));
          setDeadlineDraft(toLocalInput(plus7.toISOString()));
        }
      } catch (e: any) {
        setErr(
          e?.response?.data?.detail ||
            e?.message ||
            "Failed to load options."
        );
      }
    })();
  }, []);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  
  // If opened from Course Profile deep-link, reset filters/search to ensure the faculty is visible
  useEffect(() => {
    if (!shouldAutoOpen) return;
    setDepartment('All Departments');
    setStatus('All Status');
    setFacultyType('All Faculty Type');
    setSearchInput('');
    setSearch('');
  }, [shouldAutoOpen]);

  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!shouldAutoOpen) return;
    if (!deepLinkFacultyId) return;
    if (loading) return;
    if (!rows || rows.length === 0) return;

    const target = rows.find((r) => (r.faculty_id || '').trim() === deepLinkFacultyId);
    if (!target) return;

    autoOpenedRef.current = true;
    openView(target, deepLinkTermId || activeTerm?.term_id);
  }, [shouldAutoOpen, deepLinkFacultyId, deepLinkTermId, loading, rows, activeTerm?.term_id]);

// Fetch table rows when filters/search change
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const { ok, rows } = await listOMFFaculty({
          department,
          facultyType,
          status,
          search,
          termId: deepLinkTermId || activeTerm?.term_id,
        });
        if (!ok) throw new Error("Failed to load faculty preferences");
        setRows(rows);
        const unique = Array.from(
          new Set(rows.map((r) => r.status).filter(Boolean))
        );
        setStatusOptions(["All Status", ...unique.sort()]);
      } catch (e: any) {
        setRows([]);
        setErr(
          e?.response?.data?.detail ||
            e?.message ||
            "Failed to load faculty preferences."
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [department, facultyType, status, search, activeTerm?.term_id, deepLinkTermId]);

  const openView = async (row: OMFRow, termIdOverride?: string) => {
    if (selected?.faculty_id === row.faculty_id && (prefLoading || pref)) return;
    setSelected(row);
    setPref(null);
    setPrefLoading(true);
    try {
      const { ok, preference } = await getOMFPreference(
        row.faculty_id,
        termIdOverride || deepLinkTermId || activeTerm?.term_id
      );
      if (ok) setPref(preference ?? null);
    } finally {
      setPrefLoading(false);
    }
  };
  const closeView = () => {
    setSelected(null);
    setPref(null);
    setPrefLoading(false);
  };

  const headerLabel = activeTerm?.label || "—";

  const shownLabel =
    (pref as any)?.meta?.shown_term_label ||
    (pref as any)?.meta?.shownTermLabel ||
    "";
  const isFallbackShown = Boolean((pref as any)?.meta?.is_fallback && shownLabel);

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
    <main className="w-full px-6 py-6">
      {/* Header */}
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Faculty Preferences</h1>
          <p className="text-sm text-gray-600">
            Manage faculty preference submissions for {headerLabel}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {activeTerm?.submission_deadline && (
            <p className="text-sm font-semibold text-red-600">
            </p>
          )}

          {isOm && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!prefsWindow.openISO && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-700">Opens</span>
                  <input
                    type="datetime-local"
                    className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                    value={openDraft}
                    onChange={(e) => setOpenDraft(e.target.value)}
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-700">Deadline</span>
                <input
                  type="datetime-local"
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
                title={prefsWindow.openISO ? "Set a new deadline (opens immediately)" : "Set the opening time and deadline"}
              >
                {startingWindow
                  ? "Saving…"
                  : prefsWindow.openISO
                    ? "Set Deadline"
                    : "Start Window"}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Banner */}
      <DeadlineBanner
        openISO={prefsWindow.openISO}
        deadlineISO={prefsWindow.deadlineISO}
        className="mb-6"
      />

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
        <div className="relative flex-1 min-w-[260px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 pr-8 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <SelectBox value={department} onChange={setDepartment} options={deptOptions} />
        <SelectBox value={status} onChange={setStatus} options={statusOptions} />
        <SelectBox value={facultyType} onChange={setFacultyType} options={typeOptions} />
      </div>

      {/* Table + inline viewer */}
      <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(240px,0.82fr)_minmax(0,1.68fr)]">
        <div className="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm md:max-h-[calc(100vh-3rem)]">
          <div className="overflow-auto md:max-h-[calc(100vh-3rem)]">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[68%]" />
                <col className="w-[32%]" />
              </colgroup>
              <thead className="border-b bg-gray-50 text-gray-900">
                <tr>
                  <th className="px-4 py-3 text-left">Faculty</th>
                  <th className="px-3 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-6 text-center text-gray-500">
                      No results
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const isActive = selected?.faculty_id === r.faculty_id;
                    return (
                      <tr
                        key={r.faculty_id}
                        onClick={() => openView(r)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openView(r);
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={`View ${r.name || "faculty"} preference`}
                        className={cls(
                          "cursor-pointer transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-500/30",
                          isActive && "bg-emerald-50/70"
                        )}
                      >
                        <td className="px-4 py-4 font-semibold text-emerald-700">
                          <div className="truncate" title={r.name || "—"}>{r.name || "—"}</div>
                          <div className="truncate text-xs font-normal text-gray-500" title={r.email || "—"}>{r.email || "—"}</div>
                        </td>
                        <td className="px-3 py-4 text-center text-gray-700">
                          {(() => {
                            const statusLabel = r.status || "—";
                            const normalizedStatus = String(statusLabel).trim().toLowerCase();
                            const isSubmitted = normalizedStatus === "submitted";

                            return (
                              <span
                                className={cls(
                                  "inline-flex max-w-full items-center justify-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1",
                                  isSubmitted
                                    ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
                                    : "bg-gray-100 text-gray-700 ring-gray-200"
                                )}
                                title={statusLabel}
                              >
                                <span className="truncate">{statusLabel}</span>
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="min-w-0 md:sticky md:top-6 md:self-start">
          <div className="flex max-h-[calc(100vh-3rem)] min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b bg-gradient-to-r from-slate-900 via-emerald-900 to-emerald-700 px-5 py-5 text-white">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
                    Preference Viewer
                  </div>
                  <h2 className="mt-1 text-lg font-semibold">
                    {selected?.name || "Select a faculty member"}
                  </h2>
                  <p className="mt-1 text-sm text-white/85">
                    {selected?.email || "Choose any faculty from the table to inspect their latest submitted preferences."}
                  </p>
                </div>
                {selected && (
                  <button
                    type="button"
                    onClick={closeView}
                    className="rounded-xl border border-white/15 bg-white/10 p-2 text-white/90 transition hover:bg-white/20"
                    aria-label="Close preference viewer"
                    title="Close preference viewer"
                  >
                    <PanelRightClose className="h-5 w-5" />
                  </button>
                )}
              </div>

              {selected && (
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded-xl bg-white/10 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-white/70">Department</div>
                    <div className="mt-1 text-sm font-medium text-white">{selected.department || "—"}</div>
                  </div>
                  <div className="rounded-xl bg-white/10 px-3 py-2">
                    <div className="text-[11px] uppercase tracking-wide text-white/70">Faculty Type</div>
                    <div className="mt-1 text-sm font-medium text-white">{selected.type || "—"}</div>
                  </div>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-5">
              {!selected && (
                <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-700">
                    <Eye className="h-6 w-6" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-gray-900">No faculty selected yet</h3>
                  <p className="mt-2 text-sm text-gray-600">
                    Click any faculty row to preview preferences here without opening a modal.
                  </p>
                </div>
              )}

              {selected && prefLoading && (
                <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
                  Loading preference…
                </div>
              )}

              {selected && !prefLoading && !pref && (
                <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
                  No preference record found for the active term.
                  <div className="mt-1 text-xs text-gray-500">
                    If the faculty has submitted before, their last submitted preferences will appear here.
                  </div>
                </div>
              )}

              {selected && !prefLoading && pref && isFallbackShown && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <div className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                    <div>
                      <div className="font-semibold">No submission for the active term</div>
                      <div className="mt-0.5 text-[13px] text-amber-900/90">
                        Showing the faculty&apos;s last submitted preferences from <span className="font-semibold">{shownLabel}</span>.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {selected && !prefLoading && pref && (
                <div className="grid grid-cols-1 gap-4">
                  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center gap-2 text-gray-900">
                      <GraduationCap className="h-4 w-4 text-emerald-700" />
                      <h3 className="font-semibold">Teaching Load</h3>
                    </div>

                    <div className="mt-3 space-y-3 text-sm">
                      <div>
                        <p className="text-xs font-medium text-gray-600">Preferred Teaching Units</p>
                        <p className="mt-1 break-words text-gray-800">
                          {pref.teaching?.preferred_units ?? "—"}
                        </p>
                      </div>

                      <div>
                        <p className="text-xs font-medium text-gray-600">Deloading</p>

                        {(() => {
                          const raw = pref.teaching?.deloading;
                          const deload: string[] = Array.isArray(raw)
                            ? raw
                            : raw
                              ? [String(raw)]
                              : [];

                          if (!deload.length) {
                            return (
                              <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                                <div>
                                  <div className="font-semibold">No deloading indicated</div>
                                  <div className="mt-0.5 text-amber-800/90">
                                    This faculty has no deloading entry for the current preference record.
                                  </div>
                                </div>
                              </div>
                            );
                          }

                          return (
                            <ul className="mt-2 space-y-1 text-gray-700">
                              {deload.map((d, i) => (
                                <li key={i} className="flex gap-2">
                                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-gray-400" />
                                  <span className="flex-1 break-words">{d}</span>
                                </li>
                              ))}
                            </ul>
                          );
                        })()}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center gap-2 text-gray-900">
                      <Calendar className="h-4 w-4 text-emerald-700" />
                      <h3 className="font-semibold">Schedule</h3>
                    </div>

                    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <p className="text-xs font-medium text-gray-600">Days</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(() => {
                              const days: string[] = Array.isArray(pref.schedule?.days) ? pref.schedule.days : [];
                              if (!days.length) return <span className="text-sm text-gray-800">—</span>;
                              return days.map((d, idx) => (
                                <span
                                  key={`${d}-${idx}`}
                                  className="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-semibold text-gray-800 ring-1 ring-gray-200"
                                >
                                  {d}
                                </span>
                              ));
                            })()}
                          </div>
                        </div>

                        <div>
                          <p className="text-xs font-medium text-gray-600">Time Slots</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {(() => {
                              const times: string[] = Array.isArray(pref.schedule?.times) ? pref.schedule.times : [];
                              if (!times.length) return <span className="text-sm text-gray-800">—</span>;
                              return times.map((t, idx) => (
                                <span
                                  key={`${t}-${idx}`}
                                  className="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-semibold text-gray-800 ring-1 ring-gray-200"
                                >
                                  {t}
                                </span>
                              ));
                            })()}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center gap-2 text-gray-900">
                      <MapPin className="h-4 w-4 text-emerald-700" />
                      <h3 className="font-semibold">Location and Mode</h3>
                    </div>

                    <div className="mt-3 text-sm">
                      <p className="text-xs font-medium text-gray-600">Mode</p>
                      <p className="mt-1 break-words text-gray-800">
                        {typeof pref.location_mode?.mode === "object"
                          ? JSON.stringify(pref.location_mode?.mode)
                          : pref.location_mode?.mode ?? "—"}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center gap-2 text-gray-900">
                      <BookOpen className="h-4 w-4 text-emerald-700" />
                      <h3 className="font-semibold">Academic Specialization</h3>
                    </div>

                    <div className="mt-3 text-sm">
                      <p className="text-xs font-medium text-gray-600">KAC's</p>
                      {(pref.specialization?.courses || []).length ? (
                        <ul className="mt-2 space-y-2 text-gray-800">
                          {(pref.specialization?.courses || []).map((kac: string, idx: number) => (
                            <li
                              key={`${kac}-${idx}`}
                              className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 break-words"
                            >
                              {kac}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 break-words text-gray-800">—</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center gap-2 text-gray-900">
                      <Info className="h-4 w-4 text-emerald-700" />
                      <h3 className="font-semibold">Remarks</h3>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm text-gray-800">
                      {pref.submission?.notes && String(pref.submission.notes).trim()
                        ? pref.submission.notes
                        : "—"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

        {/* Start/Restart Window Confirm Modal */}
        {confirmState && (
          <div className="fixed inset-0 z-[110] grid place-items-center bg-black/40 p-4">
            <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl border border-gray-200">
              <div
                className={cls(
                  "px-5 py-4 text-white",
                  confirmState.accent === "amber"
                    ? "bg-amber-600"
                    : "bg-emerald-700"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 grid h-10 w-10 place-items-center rounded-full bg-white/15">
                    <Info className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-base font-extrabold tracking-tight">
                      {confirmState.title}
                    </div>
                    <div className="mt-1 text-sm text-white/90">
                      Review the details below before continuing.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => closeConfirm(false)}
                    className="ml-auto rounded-lg p-2 text-white/90 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/40"
                    aria-label="Close"
                    title="Close"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="p-5">
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800 whitespace-pre-line">
                  {confirmState.message}
                </div>

                <div className="mt-5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => closeConfirm(false)}
                    className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => closeConfirm(true)}
                    className={cls(
                      "rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm",
                      confirmState.accent === "amber"
                        ? "bg-amber-600 hover:bg-amber-700"
                        : "bg-emerald-600 hover:bg-emerald-700"
                    )}
                  >
                    {confirmState.confirmText}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
    </main>
    </div>
  );
}
