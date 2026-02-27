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
  BookOpen,
  Info,
  X,
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
      <div
        className={cls(
          "mb-4 flex items-start gap-3 rounded-xl border p-4 border-gray-200 bg-gray-50 text-gray-700",
          className
        )}
      >
        <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-gray-400" />
        <div className="text-sm">
          <div className="font-semibold">Submission Window Not Started</div>
          <div className="mt-0.5 text-[13px]">
            The OM can start the submission window from this page. Until then,
            faculty will not be able to submit their preferences for this term.
          </div>
        </div>
      </div>
    );
  }

  const { past: openPassed, label: openLabel } = useCountdown(openISO);
  const { past: deadlinePassed, label: deadlineLabel } = useCountdown(deadlineISO);

  if (!openPassed) {
    return (
      <div
        className={cls(
          "mb-4 flex items-start gap-3 rounded-xl border p-4 border-amber-300 bg-amber-50 text-amber-900",
          className
        )}
      >
        <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
        <div className="text-sm">
          <div className="font-semibold">Submissions Open In</div>
          <div className="mt-0.5">
            Opens:{" "}
            <span className="font-medium">
              {openISO ? new Date(openISO).toLocaleString() : "—"}
            </span>{" "}
            •{" "}
            <span className="font-bold text-amber-700">
              {openISO ? openLabel : "TBA"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (deadlinePassed) {
    return (
      <div
        className={cls(
          "mb-4 flex items-start gap-3 rounded-xl border p-4 border-red-300 bg-red-50 text-red-800",
          className
        )}
      >
        <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
        <div className="text-sm">
          <div className="font-semibold">Editing Locked</div>
          <div className="mt-0.5">
            Deadline:{" "}
            <span className="font-medium">
              {deadlineISO ? new Date(deadlineISO).toLocaleString() : "—"}
            </span>{" "}
            •{" "}
            <span className="font-bold text-red-700">Deadline passed</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cls(
        "mb-4 flex items-start gap-3 rounded-xl border p-4 border-amber-300 bg-amber-50 text-amber-900",
        className
      )}
    >
      <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
      <div className="text-sm">
        <div className="font-semibold">Submission Deadline Approaching</div>
        <div className="mt-0.5">
          Deadline:{" "}
          <span className="font-medium">
            {deadlineISO ? new Date(deadlineISO).toLocaleString() : "—"}
          </span>{" "}
          •{" "}
          <span className="font-bold text-amber-700">
            {deadlineISO ? deadlineLabel : "TBA"}
          </span>
        </div>
      </div>
    </div>
  );
}
/* ------------------------------------------------------------------------- */

/* ---- Row action: view preference ---- */
function ViewPreferenceButton({ onView }: { onView: () => void }) {
  return (
    <button
      type="button"
      onClick={onView}
      className="inline-flex items-center justify-center rounded-full p-2 text-gray-700 hover:bg-gray-100"
      title="View Preference"
      aria-label="View Preference"
    >
      <Eye className="h-4 w-4" />
    </button>
  );
}

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

  // modal
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
      }
    | null
  >(null);

  const openConfirm = (payload: {
    title: string;
    message: string;
    accent: "emerald" | "amber";
    confirmText: string;
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

    // Validate draft datetimes
    const openDate = new Date(openDraft);
    const deadlineDate = new Date(deadlineDraft);
    if (!openDraft || Number.isNaN(openDate.getTime())) {
      setErr("Please provide a valid opening date and time.");
      return;
    }
    if (!deadlineDraft || Number.isNaN(deadlineDate.getTime())) {
      setErr("Please provide a valid deadline date and time.");
      return;
    }
    if (deadlineDate.getTime() <= openDate.getTime()) {
      setErr("Deadline must be after the opening date and time.");
      return;
    }

    const verb = prefsWindow.openISO ? "Restart" : "Start";
    const message = `${verb} submission window with the following schedule? This will override the existing schedule.\n\nOpens: ${openDate.toLocaleString()}\nDeadline: ${deadlineDate.toLocaleString()}`;

    const ok = await openConfirm({
      title: `${verb} submission window?`,
      message,
      accent: prefsWindow.openISO ? "amber" : "emerald",
      confirmText: verb === "Restart" ? "Restart window" : "Start window",
    });
    if (!ok) return;

    try {
      setStartingWindow(true);
      setErr("");

      // NOTE: We intentionally call the endpoint directly instead of using the
      // startOMFWindow helper from ../../api because its TypeScript payload type
      // may not include openISO/deadlineISO in some codebases.
      // This keeps the change isolated to this page and avoids TS errors.
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
        throw new Error(data?.detail || "Failed to start submission window.");
      }

      if (!data?.ok || !data.prefs_window) {
        throw new Error("Failed to start submission window.");
      }

      setPrefsWindow({
        openISO: data.prefs_window.openISO || "",
        deadlineISO: data.prefs_window.deadlineISO || "",
      });
    } catch (e: any) {
      setErr(
        e?.response?.data?.detail ||
          e?.message ||
          "Failed to start submission window."
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
  };

  const fmtDate = (iso?: string) => {
    if (!iso) return "N/A";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "N/A" : d.toLocaleDateString();
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
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-700">Opens</span>
                <input
                  type="datetime-local"
                  className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm"
                  value={openDraft}
                  onChange={(e) => setOpenDraft(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-700">Deadline</span>
                <input
                  type="datetime-local"
                  className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm"
                  value={deadlineDraft}
                  onChange={(e) => setDeadlineDraft(e.target.value)}
                />
              </div>
              <button
                type="button"
                onClick={handleStartWindow}
                disabled={startingWindow}
                className="inline-flex h-9 items-center rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
              >
                {startingWindow
                  ? "Saving…"
                  : prefsWindow.openISO
                    ? "Restart Window"
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

      {/* Table */}
      <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible rounded-xl">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-gray-50 border-b text-gray-700">
            <tr>
              <th className="w-[32%] text-left px-4 py-3">Faculty</th>
              <th className="w-[32%] text-center px-4 py-3">Department</th>
              <th className="w-[13.5%] text-center px-4 py-3">Faculty Type</th>
              <th className="w-[13.5%] text-center px-4 py-3">Submission Date</th>
              <th className="w-[13.5%] text-center px-4 py-3">Status</th>
              <th className="w-[14%] text-center px-4 py-3">Preference</th>
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
              rows.map((r) => (
                <tr key={r.faculty_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-emerald-700 font-semibold">
                    {r.name}
                    <div className="text-xs text-gray-500">{r.email}</div>
                  </td>
                  <td className="text-center">{r.department || "—"}</td>
                  <td className="px-4 py-3 text-center">{r.type || "—"}</td>
                  <td className="px-4 py-3 text-center">{fmtDate(r.submission_date)}</td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={cls(
                        "inline-block rounded-full px-3 py-1 text-xs font-semibold",
                        r.status === "Submitted"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-gray-100 text-gray-700"
                      )}
                    >
                      {r.status || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ViewPreferenceButton onView={() => openView(r)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

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
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800">
                  {confirmState.message}
                </div>

                <div className="mt-4 text-xs text-gray-600">
                  <span className="font-semibold">Note:</span> This action will apply immediately and replace any existing schedule.
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

        {/* View Preference Modal */}
        {selected && (
          <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
            <div className="w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl max-h-[90vh] flex flex-col">
              {/* Header */}
              <div className="relative flex-none bg-gradient-to-r from-emerald-700 to-emerald-600 px-6 py-5 text-white">
                <button
                  onClick={closeView}
                  className="absolute right-4 top-4 rounded-lg p-2 text-white/90 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/40"
                  aria-label="Close"
                  title="Close"
                >
                  <X className="h-5 w-5" />
                </button>

                <div className="flex items-start gap-4">
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/15 ring-1 ring-white/25 text-lg font-semibold">
                    {(selected.name || "?")
                      .trim()
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((p) => p[0]?.toUpperCase())
                      .join("")}
                  </div>

                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold leading-tight truncate">
                      {selected.name || "—"}
                    </h2>
                    <p className="mt-0.5 text-sm text-white/90 truncate">
                      {selected.email || ""}
                    </p>
                  </div>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50 p-6">
                {prefLoading && (
                  <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
                    Loading preference…
                  </div>
                )}

                {!prefLoading && !pref && (
                  <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600">
                    No preference record found for the active term.
                    <div className="mt-1 text-xs text-gray-500">
                      If the faculty has submitted before, their last submitted preferences will appear here.
                    </div>
                  </div>
                )}

                {!prefLoading && pref && isFallbackShown && (
                  <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <div className="flex items-start gap-2">
                      <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                      <div>
                        <div className="font-semibold">
                          No submission for the active term
                        </div>
                        <div className="mt-0.5 text-[13px] text-amber-900/90">
                          Showing the faculty&apos;s last submitted preferences from <span className="font-semibold">{shownLabel}</span>.
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!prefLoading && pref && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {/* Teaching Load */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className="flex items-center gap-2 text-gray-900">
                        <GraduationCap className="h-4 w-4 text-emerald-700" />
                        <h3 className="font-semibold">Teaching Load</h3>
                      </div>

                      <div className="mt-3 space-y-3 text-sm">
                        <div>
                          <p className="text-xs font-medium text-gray-600">
                            Preferred Teaching Units
                          </p>
                          <p className="mt-1 break-words text-gray-800">
                            {pref.teaching?.preferred_units ?? "—"}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs font-medium text-gray-600">
                            Deloading
                          </p>

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
                                    <div className="font-semibold">
                                      No deloading indicated
                                    </div>
                                    <div className="mt-0.5 text-amber-800/90">
                                      This faculty has no deloading entry for
                                      the current preference record.
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
                                    <span className="flex-1 break-words">
                                      {d}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    {/* Location and Mode */}
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

                    {/* Schedule */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className="flex items-center gap-2 text-gray-900">
                        <Calendar className="h-4 w-4 text-emerald-700" />
                        <h3 className="font-semibold">Schedule</h3>
                      </div>

                      <div className="mt-3 space-y-3 text-sm">
                        <div>
                          <p className="text-xs font-medium text-gray-600">
                            Days
                          </p>
                          <p className="mt-1 break-words text-gray-800">
                            {(pref.schedule?.days || []).length
                              ? pref.schedule.days.join(", ")
                              : "—"}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs font-medium text-gray-600">
                            Time Slots
                          </p>
                          <p className="mt-1 break-words text-gray-800">
                            {(pref.schedule?.times || []).length
                              ? pref.schedule.times.join(", ")
                              : "—"}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Academic Specialization */}
                    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className="flex items-center gap-2 text-gray-900">
                        <BookOpen className="h-4 w-4 text-emerald-700" />
                        <h3 className="font-semibold">
                          Academic Specialization
                        </h3>
                      </div>

                      <div className="mt-3 text-sm">
                        <p className="text-xs font-medium text-gray-600">
                          Courses
                        </p>
                        <p className="mt-1 break-words text-gray-800">
                          {(pref.specialization?.courses || []).length
                            ? pref.specialization.courses.join(", ")
                            : "—"}
                        </p>
                      </div>
                    </div>

                    {/* Remarks */}
                    <div className="md:col-span-2 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-1">
                        <div>
                          <p className="text-xs font-medium text-gray-600">
                            Remarks
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800">
                            {pref.submission?.notes &&
                            String(pref.submission.notes).trim()
                              ? pref.submission.notes
                              : "—"}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>
        )}
      </div>
    </main>
    </div>
  );
}