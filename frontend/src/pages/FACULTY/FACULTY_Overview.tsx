// frontend/src/pages/FACULTY/FAC_Overview.tsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ReactDOM from "react-dom";
import {
  Send as SendIcon,
  X,
  Check,
  MessageSquareText,
  BookOpen as SyllabusIcon,
  Edit,
  AlertTriangle,
} from "lucide-react";

import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import PreferencesContent from "./FACULTY_Preferences";
import { InboxContent } from "./FACULTY_Inbox";


// ---------------- Special-class display helpers ----------------
// NOTE: These are intentionally *display* helpers only (no persistence side-effects).
// Requirements:
// - For special classes, show TBA instead of ONLINE.
// - For special classes (List view), show day initials (M/T/W/H/F/S/U) instead of full words.
// - For special classes, mode should be FOL if BOTH rooms are unassigned (empty/TBA/ONLINE), else HYB.
const isRoomUnassignedForSpecial = (v?: unknown) => {
  const s = String(v ?? "").trim();
  if (!s) return true;
  const u = s.toUpperCase();
  return u === "TBA" || u === "ONLINE";
};

const normalizeRoomDisplayForSpecial = (v?: unknown) => {
  const s = String(v ?? "").trim();
  if (!s) return "—";
  const u = s.toUpperCase();
  if (u === "ONLINE") return "TBA";
  return s;
};

const dayInitial = (d?: unknown) => {
  const s = String(d ?? "").trim();
  if (!s) return "";
  const u = s.toUpperCase();
  if (u === "TBA") return "TBA";
  // If already a short code, keep it.
  if (s.length <= 2) return u;
  const norm = s.toLowerCase();
  if (norm.startsWith("mon")) return "M";
  if (norm.startsWith("tue")) return "T";
  if (norm.startsWith("wed")) return "W";
  // Common local abbreviation: Thursday = H
  if (norm.startsWith("thu")) return "H";
  if (norm.startsWith("fri")) return "F";
  if (norm.startsWith("sat")) return "S";
  if (norm.startsWith("sun")) return "U";
  return s.charAt(0).toUpperCase();
};

const specialModeFromRooms = (room1?: unknown, room2?: unknown) => {
  return isRoomUnassignedForSpecial(room1) && isRoomUnassignedForSpecial(room2)
    ? "FOL"
    : "HYB";
};


import {
  getFacultyOverviewList,
  getFacultyOverviewProfile,
  getActiveRole,
  setActiveRole,
  userIsChair,
} from "../../api";

import {
  getFacultyLoadAssignmentRfc,
  sendFacultyLoadAssignmentRfcMessage,
  acceptFacultyLoadAssignment,
} from "../../api.ts";
import { useNavigate } from "react-router-dom";

/* =========================================
   Toast (Faculty)
   - Lightweight in-file toast stack (no extra deps)
   - Upper-right, beneath TopBar
   ========================================= */
type ToastKind = "success" | "error" | "info" | "warning";
type ToastItem = { id: string; kind: ToastKind; title?: string; message: string };

function ToastViewport({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (!items.length) return null;

  const tone = (k: ToastKind) => {
    if (k === "success") return "border-emerald-200 bg-emerald-50 text-emerald-900";
    if (k === "error") return "border-red-200 bg-red-50 text-red-900";
    if (k === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
    return "border-slate-200 bg-white text-slate-900";
  };

  return (
    <div className="pointer-events-none fixed right-6 top-[72px] z-[1200] flex w-[360px] max-w-[90vw] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cls(
            "pointer-events-auto rounded-xl border px-4 py-3 shadow-lg",
            "backdrop-blur supports-[backdrop-filter]:bg-white/90",
            tone(t.kind)
          )}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {t.title && <div className="text-sm font-semibold">{t.title}</div>}
              <div className="mt-0.5 break-words text-sm">{t.message}</div>
            </div>
            <button
              type="button"
              className="rounded-md p-1 hover:bg-black/5"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss toast"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* =========================================
   Confirm Dialog (Faculty)
   - Custom replacement for window.confirm (avoids generic browser prompt)
   - Uses a portal so it floats above page/modals
   ========================================= */
function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  tone = "warning",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: "warning" | "danger" | "info";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => confirmBtnRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const ring =
    tone === "danger"
      ? "ring-red-500/30"
      : tone === "info"
      ? "ring-slate-500/20"
      : "ring-amber-500/30";

  const iconTone =
    tone === "danger"
      ? "bg-red-50 text-red-700 border-red-200"
      : tone === "info"
      ? "bg-slate-50 text-slate-700 border-slate-200"
      : "bg-amber-50 text-amber-800 border-amber-200";

  const confirmBtn =
    tone === "danger"
      ? "bg-red-600 hover:bg-red-700 focus:ring-red-500/30"
      : tone === "info"
      ? "bg-slate-900 hover:bg-slate-800 focus:ring-slate-500/30"
      : "bg-amber-600 hover:bg-amber-700 focus:ring-amber-500/30";

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[1300] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close dialog"
        onClick={onCancel}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cls(
          "relative w-full max-w-[520px] overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl",
          "outline-none ring-2",
          ring
        )}
      >
        <div className="flex items-start gap-3 border-b border-neutral-100 px-5 py-4">
          <div
            className={cls(
              "mt-0.5 inline-flex h-10 w-10 flex-none items-center justify-center rounded-xl border",
              iconTone
            )}
          >
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold text-neutral-900">{title}</div>
            {description ? (
              <div className="mt-1 text-sm text-neutral-600">{description}</div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-9 items-center justify-center rounded-xl border border-neutral-200 bg-white px-4 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-400/20"
          >
            {cancelText}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            className={cls(
              "inline-flex h-9 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white shadow-sm",
              "focus:outline-none focus:ring-2",
              confirmBtn
            )}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}


function BulkSpecialMessageDialog({
  open,
  selectedCount,
  message,
  sending,
  onChangeMessage,
  onClose,
  onSend,
}: {
  open: boolean;
  selectedCount: number;
  message: string;
  sending: boolean;
  onChangeMessage: (value: string) => void;
  onClose: () => void;
  onSend: () => void;
}) {
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => textRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[1300] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close dialog"
        onClick={onClose}
      />

      <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl">
        <div className="border-b border-neutral-100 px-5 py-4">
          <div className="text-base font-semibold text-neutral-900">Send message to students</div>
          <div className="mt-1 text-sm text-neutral-600">
            Accepted special class confirmations will be grouped into one inbox message per student whenever possible.
            Students will also receive in-app and Gmail notifications and can reply in Inbox.
          </div>
        </div>

        <div className="px-5 py-4">
          <label className="mb-2 block text-sm font-medium text-neutral-800">Additional note (optional)</label>
          <textarea
            ref={textRef}
            rows={5}
            value={message}
            onChange={(e) => onChangeMessage(e.target.value)}
            placeholder="Add an optional note to include in every message…"
            className="w-full resize-none rounded-xl border border-neutral-300 bg-white p-3 text-sm outline-none focus:ring-2 focus:ring-emerald-600/20"
          />
          <div className="mt-2 text-xs text-neutral-500">
            The system will automatically include each confirmed course, section, and reflected schedule in a clear grouped message for every student.
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-neutral-100 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-xl border border-neutral-200 bg-white px-4 text-sm font-medium text-neutral-800 shadow-sm hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={sending || selectedCount === 0}
            className={cls(
              "inline-flex h-9 items-center justify-center rounded-xl px-4 text-sm font-semibold text-white shadow-sm",
              sending || selectedCount === 0
                ? "cursor-not-allowed bg-neutral-300 text-neutral-600"
                : "bg-emerald-700 hover:bg-emerald-800"
            )}
          >
            {sending ? "Sending…" : `Send to ${selectedCount} student${selectedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}


/* =========================================
   0) Page
   ========================================= */
export default function FAC_Overview() {
  const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = raw.userId || raw.user_id || raw.id;

  const TAB_VALUES = ["Schedule", "Preferences"] as const;
  type FacultyTab = (typeof TAB_VALUES)[number];

  const tabStorageKey = userId
    ? `animo.faculty.overview.activeTab.${userId}`
    : "animo.faculty.overview.activeTab";

  const readInitialTab = (): FacultyTab => {
    try {
      const saved = localStorage.getItem(tabStorageKey);
      if (!saved) return "Schedule";
      if (saved === "My Profile") return "Schedule";
      if (saved === "Schedule Overview") return "Schedule";
      if (saved === "Submit Preferences") return "Preferences";
      return (TAB_VALUES as readonly string[]).includes(saved) ? (saved as FacultyTab) : "Schedule";
    } catch {
      return "Schedule";
    }
  };

  const [tab, setTab] = useState<FacultyTab>(readInitialTab);
  const [showInbox, setShowInbox] = useState(false); // NEW
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

const toastSeq = useRef(0);
const [toasts, setToasts] = useState<ToastItem[]>([]);

const dismissToast = useCallback((id: string) => {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}, []);

const pushToast = useCallback(
  (kind: ToastKind, message: string, title?: string) => {
    const id = String(++toastSeq.current);
    setToasts((prev) => [...prev, { id, kind, title, message }]);
    window.setTimeout(() => dismissToast(id), 3800);
  },
  [dismissToast]
);

  // Prevent warning toasts from spamming on refreshes/re-renders.
  const lastWarnKey = useRef<string>("");


  const navigate = useNavigate();

  // show only if: user is a chair AND they’re currently browsing as “faculty”
  const canReturnToChair = userIsChair() && getActiveRole() === "faculty";

  useEffect(() => {
  if (userIsChair() && !getActiveRole()) {
        setActiveRole("faculty");
      }
    }, []);

  // Persist active tab across refresh.
  useEffect(() => {
    try {
      localStorage.setItem(tabStorageKey, tab);
    } catch {
      // ignore storage write failures (private mode / denied storage)
    }
  }, [tab, tabStorageKey]);


  // Expose a global helper so other components can open the inbox if needed
  useEffect(() => {
    (window as any).FACULTY_openInbox = () => window.dispatchEvent(new Event("faculty:openInbox"));
  }, []);

  // Listen for TopBar's inbox icon click
  useEffect(() => {
    const onOpen = () => setShowInbox(true);
    const onClose = () => setShowInbox(false);
    window.addEventListener("faculty:openInbox", onOpen);
    window.addEventListener("faculty:closeInbox", onClose);
    return () => {
      window.removeEventListener("faculty:openInbox", onOpen);
      window.removeEventListener("faculty:closeInbox", onClose);
    };
  }, []);

  const loadOverview = useCallback(async () => {
  if (!userId) {
    setError("Missing userId in local storage.");
    return;
  }
  try {
    // Parallel loads (pattern parity with Student Petition)
    const [list, profile] = await Promise.all([
      getFacultyOverviewList(userId),
      getFacultyOverviewProfile(userId),
      // getFacultyOverviewOptions(userId) // not needed by this page; stub is available
    ]);

    if (!list?.ok) throw new Error(list?.detail || "Failed to load list.");
    if (!profile?.ok) throw new Error(profile?.detail || "Failed to load profile.");

    const teachingLoadNormalizedRaw = (list?.teaching_load || []).map((x: any) => ({
      ...x,
      // normalize section_id no matter what the backend sends
      section_id:
        x.section_id ||
        x.sectionId ||
        x.section?.section_id ||
        x.section?.id ||
        "",
    }));

    // De-duplicate rows (prevents Special Class duplicates from multiple backend versions)
    const seen = new Set<string>();
    const teachingLoadNormalized = teachingLoadNormalizedRaw.filter((x: any) => {
      const isSpecial = Boolean(x?.is_special_class);
      const baseId = String(isSpecial ? (x?.special_id || "") : (x?.section_id || "")).trim();
      const fallback = [
        x?.course_code,
        x?.section,
        x?.day1,
        x?.time1,
        x?.room1,
        x?.day2,
        x?.time2,
        x?.room2,
        isSpecial ? "special" : "regular",
      ]
        .map((v) => String(v ?? "").trim())
        .join("|");

      const key = isSpecial
        ? `SPECIAL:${baseId || fallback}`
        : `REG:${baseId || fallback}`;

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Compose into the same shape the page already renders
    const nextData = {
      ok: true,
      faculty: profile.faculty,
      term: list.term,
      summary: list.summary,
      teaching_load: teachingLoadNormalized,
      notifications: profile.notifications || [],
      // Load assignment workflow flags (backwards-compatible)
      is_proposed: (list as any).is_proposed,
      proposal_status: (list as any).proposal_status,
      rfc: (list as any).rfc,
      schedule_final: (list as any).schedule_final,
    };
    setData(nextData);
    setError(null);

    // Warn if limits are exceeded (teaching units / course prep).
    const summary = (nextData as any)?.summary || {};
    const parsePair = (v: any): [number, number] => {
      const s = String(v ?? "0/0");
      const [a, b] = s.split("/");
      const left = Number(a);
      const right = Number(b);
      return [Number.isFinite(left) ? left : 0, Number.isFinite(right) ? right : 0];
    };

    const [uCur, uMax] = parsePair(summary?.teaching_units);
    const [pCur, pMax] = parsePair(summary?.course_preps);
    const overUnits = typeof summary?.exceeded_teaching_units === "boolean" ? summary.exceeded_teaching_units : (uMax > 0 ? uCur > uMax : uCur > 0);
    const overPreps = typeof summary?.exceeded_course_preps === "boolean" ? summary.exceeded_course_preps : (pMax > 0 ? pCur > pMax : pCur > 0);

    const warnKey = `${overUnits ? `U:${uCur}/${uMax}` : ""}|${overPreps ? `P:${pCur}/${pMax}` : ""}`;
    if (warnKey !== lastWarnKey.current && (overUnits || overPreps)) {
      lastWarnKey.current = warnKey;
      if (overUnits) {
        const overBy = typeof summary?.teaching_units_over_by === "number" ? summary.teaching_units_over_by : Math.max(0, uCur - uMax);
        pushToast(
          "warning",
          `Teaching units exceeded (${summary?.teaching_units ?? `${uCur}/${uMax}`})${overBy ? ` — +${overBy}` : ""}.`,
          "Warning"
        );
      }
      if (overPreps) {
        const overBy = typeof summary?.course_preps_over_by === "number" ? summary.course_preps_over_by : Math.max(0, pCur - pMax);
        pushToast(
          "warning",
          `Course prep exceeded (${summary?.course_preps ?? `${pCur}/${pMax}`})${overBy ? ` — +${overBy}` : ""}.`,
          "Warning"
        );
      }
    }
  } catch (e: any) {
    setError(e?.response?.data?.detail || e?.message || "Failed to load faculty overview.");
  }
}, [userId, pushToast]);

useEffect(() => {
  loadOverview();
}, [loadOverview]);

// Auto-refresh so room allocations (and other APO/OM updates) reflect
// in both list + calendar views without requiring a manual page reload.
useEffect(() => {
  if (!userId) return;

  // Modest cadence to keep the UI responsive without hammering the server.
  const intervalMs = 15_000;
  const id = window.setInterval(() => {
    // Fire-and-forget; loadOverview handles its own errors.
    loadOverview();
  }, intervalMs);

  return () => window.clearInterval(id);
}, [userId, loadOverview]);


  if (error) return <div className="p-10 text-red-600">{error}</div>;
  if (!data) return <div className="p-10 text-gray-600">Loading faculty overview…</div>;

  const fullName =
    data?.faculty?.full_name ||
    data?.faculty?.fullName ||
    `${(data?.faculty?.first_name ?? data?.faculty?.firstName ?? "")} ${(data?.faculty?.last_name ?? data?.faculty?.lastName ?? "")}`.trim();

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar
        fullName={fullName}
        role={data.faculty.role}
        department={data.faculty.department}
        notifications={data.notifications}
        /* No need to pass handlers; we use window events */
      />

      <ToastViewport items={toasts} onDismiss={dismissToast} />

      {canReturnToChair && (
        <button
          onClick={() => {
            setActiveRole("chair");
            navigate("/chair"); // cleaner landing to chair shell
          }}
          className="fixed bottom-4 right-4 z-[1000] rounded-full px-4 py-2 shadow-lg bg-emerald-600 text-white hover:bg-emerald-700 focus:outline-none"
          aria-label="Back to Chair View"
        >
          Back to Chair View
        </button>
      )}



      {/* Tabs should remain visible even when Inbox is open (match APO Inbox UX) */}
      <Tabs
        mode="state"
        activeTab={tab}
        onTabChange={(newTab) => {
          // If the user clicks a tab while viewing the Inbox, close Inbox and switch.
          if (showInbox) setShowInbox(false);
          setTab(newTab as typeof tab);
        }}
        items={[{ label: "Schedule" }, { label: "Preferences" }]}
      />

      {/*
        IMPORTANT: Match APO Inbox sizing.
        APO renders <InboxShell /> directly under <Tabs /> with no extra page padding.
        Faculty previously rendered inbox inside <main className="p-6">, which made it narrower.
      */}
      {showInbox ? (
        <div className="w-full">
          <InboxContent />
        </div>
      ) : (
        <main className={cls("w-full", "p-6 pb-24")}>
          {tab === "Schedule" && (
            <>
              <StatCards summary={data.summary} />
              <div className="my-6" />
              <TeachingLoadEnhanced
                teachingLoad={data.teaching_load}
                term={data.term}
                workflow={data}
                onToast={pushToast}
                onRefresh={loadOverview}
              />
            </>
          )}
          {tab === "Preferences" && <PreferencesContent />}
        </main>
      )}
    </div>
  );
}

/* =========================================
   1) Stat Cards (MODIFIED)
   ========================================= */
function StatCards({ summary }: { summary: any }) {
  const parsePair = (v: any): [number, number] => {
    const s = String(v ?? "0/0");
    const [a, b] = s.split("/");
    const left = Number(a);
    const right = Number(b);
    return [Number.isFinite(left) ? left : 0, Number.isFinite(right) ? right : 0];
  };

  const unitsValue = summary?.teaching_units ?? "0/0";
  const prepValue = summary?.course_preps ?? "0/0";

  const [unitsCurrent, unitsMax] = parsePair(unitsValue);
  const [prepCurrent, prepMax] = parsePair(prepValue);

  // Backwards compatible: prefer backend booleans if present
  const unitsExceeded =
    typeof summary?.exceeded_teaching_units === "boolean"
      ? summary.exceeded_teaching_units
      : (unitsMax > 0 ? unitsCurrent > unitsMax : unitsCurrent > 0);

  const prepsExceeded =
    typeof summary?.exceeded_course_preps === "boolean"
      ? summary.exceeded_course_preps
      : (prepMax > 0 ? prepCurrent > prepMax : prepCurrent > 0);

  const unitsOverBy =
    typeof summary?.teaching_units_over_by === "number"
      ? summary.teaching_units_over_by
      : Math.max(0, unitsCurrent - unitsMax);

  const prepsOverBy =
    typeof summary?.course_preps_over_by === "number"
      ? summary.course_preps_over_by
      : Math.max(0, prepCurrent - prepMax);

  // Progress calculations (cap bar at 100% but keep % text meaningful)
  const unitsProgress = Number.isFinite(Number(summary?.percent)) ? Number(summary?.percent) : (unitsMax > 0 ? Math.round((unitsCurrent / unitsMax) * 100) : 0);
  const prepProgress = prepMax > 0 ? Math.round((prepCurrent / prepMax) * 100) : 0;

  const cards = [
    {
      title: "Teaching Units",
      value: unitsValue,
      progress: unitsProgress,
      exceeded: unitsExceeded,
      overBy: unitsOverBy,
    },
    {
      title: "Course Prep",
      value: prepValue,
      progress: prepProgress,
      exceeded: prepsExceeded,
      overBy: prepsOverBy,
    },
  ];

  return (
    <div className="mx-auto grid w-full max-w-screen-2xl grid-cols-1 gap-3 px-4 sm:grid-cols-2">
      {cards.map(({ title, value, progress, exceeded, overBy }) => (
        <div
          key={title}
          className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm hover:shadow-md transition"
        >
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold tracking-tight">{value}</div>
            <div className="text-[13px] text-neutral-700">{title}</div>
          </div>
          {exceeded && (
            <div className="mt-1 inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900">
              <span>Exceeded</span>
              {overBy > 0 && <span className="opacity-90">(+{overBy})</span>}
            </div>
          )}
          <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-600">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200">
            <div
              className={cls(
                "h-full transition-all",
                exceeded ? "bg-amber-600" : "bg-emerald-700"
              )}
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* =========================================
   2) Enhanced Teaching Load (Calendar/List + Modal)
   ========================================= */

// --- *** MODIFIED: Add "TBA" as a valid day *** ---
type DayLong =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "TBA"; // <-- NEW

// --- *** MODIFIED: Add "TBA" to list of days *** ---
const DAY_ORDER: DayLong[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "TBA", // <-- NEW
];

// Accept both long-day labels and short codes coming from DB/API.
const DAY_ALIASES: Record<string, DayLong> = {
  M: "Monday",
  MON: "Monday",
  T: "Tuesday",
  TU: "Tuesday",
  TUE: "Tuesday",
  W: "Wednesday",
  WED: "Wednesday",
  TH: "Thursday",
  THU: "Thursday",
  H: "Thursday",
  R: "Thursday",
  F: "Friday",
  FRI: "Friday",
  S: "Saturday",
  SAT: "Saturday",
  TBA: "TBA",
};

function normalizeDay(raw?: string): DayLong | null {
  const s = (raw || "").trim();
  if (!s) return null;
  const u = s.toUpperCase();
  if (DAY_ALIASES[u]) return DAY_ALIASES[u];
  // Already in long format? (case-insensitive)
  const t = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return DAY_ORDER.includes(t as DayLong) ? (t as DayLong) : null;
}

// --- *** NEW: This type matches the backend (Python) output *** ---
type TLItemStudentReasonPair = {
  special_id?: string;
  student: string;
  reason: string;
};

type TLItem = {
  section_id: string;
  course_id?: string;
  // Special Class reflection (OM_SpecialClass -> Faculty)
  is_special_class?: boolean;
  special_id?: string;
  special_ids?: string[];
  special_group_key?: string;
  special_faculty_status?: "PENDING" | "ACCEPTED" | "REJECTED" | string;
  student?: string;
  students?: string[];
  reason?: string;
  reasons?: string[];
  student_reason_pairs?: TLItemStudentReasonPair[];
  student_count?: number;
  is_serviced?: boolean;
  serviced_department?: string;
  course_code: string;
  course_title: string;
  section: string;
  units: number;
  mode: string;
  day1?: string;
  room1?: string;
  time1?: string;
  day2?: string;
  room2?: string;
  time2?: string;
  syllabus?: string;
};

const collectSpecialIds = (item?: Partial<TLItem> | null): string[] => {
  if (!item) return [];
  const ids = new Set<string>();

  const push = (value: unknown) => {
    const sid = String(value ?? "").trim();
    if (sid) ids.add(sid);
  };

  (item.special_ids || []).forEach(push);
  push(item.special_id);
  (item.student_reason_pairs || []).forEach((pair) => push(pair?.special_id));

  return Array.from(ids);
};


// --- *** NEW: This type is for the Calendar items *** ---
type TLItemForCalendar = {
  code: string;
  title: string;
  sec: string;
  units: number;
  mode: string;
  room: string; // The specific room for this day
  time: string; // The specific time for this day
  syllabus?: string;
  is_special_class?: boolean;
  special_id?: string;
  special_ids?: string[];
  is_serviced?: boolean;
  serviced_department?: string;
  // Store original item for modal
  originalItem: TLItem;

  // UI-only controls for RFC modal behavior
  forceConversationOnly?: boolean;
  allowStartConversation?: boolean;
};


const TIME_BANDS_LABEL = [
  "7:30 – 9:00",
  "9:15 – 10:45",
  "11:00 – 12:30",
  "12:30 – 14:15",
  "14:30 – 16:00",
  "16:15 – 17:45",
  "18:00 – 19:30",
  "19:45 – 21:00",
];


const BANDS_STARTS = [
  "07:30",
  "09:15",
  "11:00",
  "12:30",
  "14:30",
  "16:15",
  "18:00",
  "19:45",
];

// NEW: helper to convert "HH:MM" to minutes since midnight
function hmToMinutes(hm: string): number | null {
  const m = hm.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

type Placed = { day: DayLong; row: number; data: TLItemForCalendar };

// --- *** NEW: This function splits the combined rows for the calendar *** ---
function placeItems(teachingLoad: TLItem[]): Placed[] {
  const out: Placed[] = [];

  // Build band ranges from your canonical labels, e.g. "7:30 – 9:00"
  const bandRanges = TIME_BANDS_LABEL.map((label, idx) => {
    const [startPart, endPart] = label.split("–").map((s) => s.trim());
    const startMin = hmToMinutes(startPart) ?? hmToMinutes(BANDS_STARTS[idx] || "");
    const endMin = hmToMinutes(endPart || "") ?? startMin;
    return { startMin: startMin ?? 0, endMin: endMin ?? (startMin ?? 0), idx };
  });
  
  (teachingLoad || []).forEach((it) => {
    // Helper function to place a single schedule item
    const place = (day: string | undefined, time: string | undefined, room: string | undefined) => {
      const dayLong = normalizeDay(day);
      if (!dayLong || dayLong === "TBA" || !time || time === "TBA") {
        return; // Don't place on calendar
      }
      const rawStart = String(time || "").split("–")[0].trim();
      const startMin = hmToMinutes(rawStart);
      
      let rowIdx = 0;
      if (startMin != null) {
        // 1) try to find a band whose [start,end) range contains this time
        let match = bandRanges.find((b) => startMin >= b.startMin && startMin < b.endMin)?.idx;

        // 2) if none, snap to the nearest band by start time
        if (match == null) {
          let bestIdx = 0;
          let bestDiff = Infinity;
          for (const b of bandRanges) {
            const diff = Math.abs(startMin - b.startMin);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestIdx = b.idx;
            }
          }
          match = bestIdx;
        }
        rowIdx = match ?? 0;
      }

      out.push({
        day: dayLong,
        row: rowIdx,
        data: {
          code: it.course_code,
          title: it.course_title,
          sec: it.section,
          units: it.units,
          mode: it.mode,
          // IMPORTANT: Even if there is no assigned room yet, the schedule must still reflect.
          // Use a neutral placeholder instead of implying an online room.
          // Special class requirement: show TBA instead of ONLINE for Room 1/2 in Calendar view.
          room: (() => {
            const base = (room && String(room).trim()) ? String(room).trim() : "TBA";
            const isSpecial = Boolean((it as any)?.is_special_class);
            const isConvertedFromSpecial = Boolean((it as any)?.converted_from_special);
            if ((isSpecial || isConvertedFromSpecial) && String(base).trim().toUpperCase() === "ONLINE") return "TBA";
            return base;
          })(),
          time: time,
          syllabus: it.syllabus,
          is_special_class: Boolean((it as any)?.is_special_class),
          special_id: (it as any)?.special_id,
          is_serviced: Boolean((it as any)?.is_serviced),
          serviced_department: (it as any)?.serviced_department,
          originalItem: it, // Pass the full original item
        },
      });
    };

    // Place both Day 1 and Day 2
    place(it.day1, it.time1, it.room1);
    place(it.day2, it.time2, it.room2);
  });

  return out;
}


type CellGroup = { day: DayLong; row: number; items: TLItemForCalendar[] };
function groupPlacedByCell(placed: Placed[]): CellGroup[] {
  const map = new Map<string, CellGroup>();
  for (const p of placed) {
    if (p.day === "TBA") continue; 
    const key = `${p.day}|${p.row}`;
    if (!map.has(key)) map.set(key, { day: p.day, row: p.row, items: [] });
    map.get(key)!.items.push(p.data);
  }
  return Array.from(map.values()).sort((a, b) => {
    const dc = DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
    return dc !== 0 ? dc : a.row - b.row;
  });
}

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

const CAMPUS_COLORS = {
  manila: "#4F7A5A",
  laguna: "#819171",
  serviced: "#CBD5C0",
} as const;

const getScheduleVisual = (it: TLItemForCalendar): {
  backgroundColor?: string;
  textColor?: string;
  borderClass: string;
  hoverClass: string;
} => {
  if (it.is_special_class) {
    return {
      borderClass: "border-emerald-200",
      hoverClass: "hover:bg-emerald-100",
    };
  }

  if (it.is_serviced) {
    return {
      backgroundColor: CAMPUS_COLORS.serviced,
      textColor: "#000000",
      borderClass: "border-transparent",
      hoverClass: "hover:brightness-[1.05]",
    };
  }

  const s = String(it.sec || "").trim().toUpperCase();
  if (s.startsWith("XX") || s.startsWith("XC")) {
    return {
      backgroundColor: CAMPUS_COLORS.laguna,
      textColor: "#ffffff",
      borderClass: "border-transparent",
      hoverClass: "hover:brightness-[1.03]",
    };
  }

  if (s.startsWith("S") || s.startsWith("G")) {
    return {
      backgroundColor: CAMPUS_COLORS.manila,
      textColor: "#ffffff",
      borderClass: "border-transparent",
      hoverClass: "hover:brightness-[1.05]",
    };
  }

  return {
    borderClass: "border-emerald-200",
    hoverClass: "hover:bg-emerald-50",
  };
};

const ClassBlock = ({ onClick, it }: { onClick?: () => void; it: TLItemForCalendar }) => {
  const visual = getScheduleVisual(it);

  return (
    <button
      onClick={it.is_special_class ? undefined : onClick}
      className={cls(
        "flex w-full flex-col items-center justify-center rounded-xl border shadow-sm transition",
        it.is_special_class
          ? "bg-emerald-50"
          : visual.backgroundColor
          ? ""
          : "bg-emerald-50/90",
        visual.borderClass,
        visual.hoverClass,
        it.is_special_class && "cursor-default"
      )}
      style={{
        ...(visual.backgroundColor ? { backgroundColor: visual.backgroundColor } : {}),
        ...(visual.textColor ? { color: visual.textColor } : {}),
      }}
      title={`${it.code} • ${it.sec} | ${it.room} • ${it.mode}`}
    >
      <div className="text-[13px] font-extrabold tracking-wide">{it.code}</div>
      <div className="text-[12px]">{it.sec} | {it.room}</div>
      {/* Removed mode display here as requested */}
    </button>
  );
};

type TeachingLoadEnhancedProps = {
  teachingLoad: TLItem[];
  term: any;
  workflow?: {
    schedule_final?: boolean;
    proposal_status?: string | null;
    rfc?: { status?: string | null } | null;
  };
  onToast?: (kind: ToastKind, message: string, title?: string) => void;
  onRefresh?: () => Promise<void> | void;
};


// --- *** MODIFIED: Headers for the list view (match OM confirmation modal; plus Syllabus) *** ---
const LIST_HEADERS = [
  "Course Code & Title",
  "Section",
  "Day",
  "Time",
  "Room",
  "Mode",
  "Syllabus",
];

// Special Class tab columns: keep details but group schedule fields so rows fit without horizontal scrolling.
const SPECIAL_TABLE_HEADERS = ["Student", "Reason", "Course Code & Title", "Section", "Day", "Time", "Room", "Mode", "Syllabus", "Action"];

const TABLE_HEADER_BASE = "h-12 px-4 text-sm font-semibold align-middle";
const TABLE_HEADER_CENTER = `${TABLE_HEADER_BASE} text-center`;
const TABLE_HEADER_LEFT = `${TABLE_HEADER_BASE} text-left`;

function splitBeginEnd(time?: string): { begin: string; end: string } {
  const raw = (time || "").trim();
  if (!raw || raw.toUpperCase() === "TBA") return { begin: "—", end: "—" };

  // Accept a few common separators: en dash, em dash, hyphen
  const parts = raw
    .split(/\s*(?:–|—|-)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length >= 2) return { begin: parts[0], end: parts[1] };
  // If only one time is present, keep it as begin and leave end blank.
  return { begin: parts[0] || "—", end: "—" };
}

function TeachingLoadEnhanced({ teachingLoad, term, workflow, onToast, onRefresh }: TeachingLoadEnhancedProps) {
  const [view, setView] = useState<"Calendar" | "List" | "Special">("Calendar");
  const [modal, setModal] = useState<{ day: DayLong; item: TLItemForCalendar } | null>(null);
  const [specialEdit, setSpecialEdit] = useState<null | {
    special_id: string;
    special_ids: string[];
    section_id: string;
    original: any;
  }>(null);
  const [specialEditBusy, setSpecialEditBusy] = useState(false);
  const [selectedSpecialIds, setSelectedSpecialIds] = useState<Record<string, boolean>>({});
  const [specialActionOverrides, setSpecialActionOverrides] = useState<Record<string, "ACCEPTED" | "REJECTED">>({});
  const [bulkSpecialOpen, setBulkSpecialOpen] = useState(false);
  const [bulkSpecialSending, setBulkSpecialSending] = useState(false);
  const [bulkSpecialMessage, setBulkSpecialMessage] = useState("");
  const [specialRooms1, setSpecialRooms1] = useState<any[]>([]);
  const [specialRooms2, setSpecialRooms2] = useState<any[]>([]);
  const [specialRoomsLoading, setSpecialRoomsLoading] = useState(false);
  const [specialEditDraft, setSpecialEditDraft] = useState({
    day1: "",
    begin1: "",
    end1: "",
    room1: "",
    day2: "",
    begin2: "",
    end2: "",
    room2: "",
  });
  

  // Auto-pair common begin/end slots (default behavior; user can still manually adjust End).
  const TIME_PAIR: Record<string, string> = useMemo(
    () => ({
      "07:30": "09:00",
      "09:15": "10:45",
      "11:00": "12:30",
      "14:15": "16:00",
      "14:30": "16:00",
      "16:15": "17:45",
      "18:00": "19:30",
      "19:45": "21:00",
    }),
    []
  );

  // Auto-pair common day combinations (default behavior; user can still manually adjust Day 2).
  const DAY_PAIR: Record<string, string> = useMemo(
    () => ({
      Monday: "Thursday",
      Thursday: "Monday",
      Tuesday: "Friday",
      Friday: "Tuesday",
      Wednesday: "Saturday",
      Saturday: "Wednesday",
    }),
    []
  );

  const DD_BASE =
    "w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm shadow-sm outline-none hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30";
  const DD_MENU =
    // NOTE: menu is rendered in a portal (fixed) so it won't be clipped by modal scroll containers.
    "fixed z-[2000] mt-2 max-h-80 overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg";

  function SpecialDropdown({
    value,
    onChange,
    options,
    placeholder = "—",
    className = "w-full",
    disabled = false,
    includeEmptyOption,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string }>;
    placeholder?: string;
    className?: string;
    disabled?: boolean;
    includeEmptyOption?: { value: string; label: string };
  }) {
    const [open, setOpen] = useState(false);
    const [hover, setHover] = useState(0);
    const btnRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(null);

    const fullOptions = useMemo(() => {
      const base = Array.isArray(options) ? options : [];
      return includeEmptyOption ? [includeEmptyOption, ...base] : base;
    }, [options, includeEmptyOption]);

    const currentLabel =
      fullOptions.find((o) => String(o.value) === String(value))?.label || "";

    useEffect(() => {
      const idx = Math.max(
        0,
        fullOptions.findIndex((o) => String(o.value) === String(value))
      );
      setHover(idx);
    }, [value, fullOptions]);

    useEffect(() => {
      const close = (e: MouseEvent) =>
        open &&
        !btnRef.current?.contains(e.target as Node) &&
        !listRef.current?.contains(e.target as Node) &&
        setOpen(false);
      document.addEventListener("mousedown", close);
      return () => document.removeEventListener("mousedown", close);
    }, [open]);

    // Keep the dropdown menu positioned correctly (and above all modal content).
    useEffect(() => {
      if (!open || disabled) return;

      const compute = () => {
        const el = btnRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setMenuRect({ top: r.bottom, left: r.left, width: r.width });
      };

      compute();
      window.addEventListener("scroll", compute, true);
      window.addEventListener("resize", compute);
      return () => {
        window.removeEventListener("scroll", compute, true);
        window.removeEventListener("resize", compute);
      };
    }, [open, disabled]);

    const onKey = (e: React.KeyboardEvent) => {
      if (disabled) return;
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
        setHover((i) => (i + 1) % Math.max(1, fullOptions.length));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHover((i) => (i - 1 + Math.max(1, fullOptions.length)) % Math.max(1, fullOptions.length));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const picked = fullOptions[hover];
        if (picked) onChange(String(picked.value));
        setOpen(false);
        btnRef.current?.focus();
      }
    };

    return (
      <div className={cls("relative", className)} onKeyDown={onKey}>
        <button
          ref={btnRef}
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cls(DD_BASE, disabled ? "opacity-60 cursor-not-allowed" : "")}
        >
          {currentLabel || value || <span className="text-gray-400">{placeholder}</span>}
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2">▾</span>
        </button>

        {open && !disabled && menuRect &&
          ReactDOM.createPortal(
            <div
              ref={listRef}
              role="listbox"
              className={DD_MENU}
              style={{ top: menuRect.top + 8, left: menuRect.left, width: menuRect.width }}
            >
              {fullOptions.map((opt, i) => (
                <button
                  key={`${opt.value}-${opt.label}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={String(value) === String(opt.value)}
                  onMouseEnter={() => setHover(i)}
                  onClick={() => {
                    onChange(String(opt.value));
                    setOpen(false);
                    btnRef.current?.focus();
                  }}
                  className={cls(
                    "block w-full px-4 py-3 text-left text-[15px]",
                    i === hover && "bg-emerald-50"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>,
            document.body
          )}
      </div>
    );
  }
const [isAccepting, setIsAccepting] = useState(false);
  const [isSyncingSpecial, setIsSyncingSpecial] = useState(false);
  const [sendToGcal, setSendToGcal] = useState(true); // default ON to keep current behavior

  useEffect(() => {
    setSpecialActionOverrides({});
  }, [teachingLoad]);

  const TIME_POINTS = useMemo(
    () =>
      Array.from(
        new Set([
          "07:30",
          "09:00",
          "09:15",
          "10:45",
          "11:00",
          "12:30",
          "14:15",
          "14:30",
          "16:00",
          "16:15",
          "17:45",
          "18:00",
          "19:30",
          "19:45",
          "21:00",
        ])
      ),
    []
  );

  const hmToHHMM = useCallback(
    (v: string) => String(v || "").replace(/\D/g, "").padStart(4, "0"),
    []
  );

  const apiGet = useCallback(async (url: string) => {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t || `Request failed: ${r.status}`);
    }
    return r.json();
  }, []);

  const apiPost = useCallback(async (url: string, body: any) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t || `Request failed: ${r.status}`);
    }
    return r.json();
  }, []);

  // ---------------- Special-class room value normalization ----------------
  // Backend expects `room_id`, but the Faculty overview list provides *room labels* (room_number).
  // If we post the label as room_id, the backend can't resolve it and will display TBA after save.
  // These helpers map between the two using the eligible rooms list (room_id + room_number).
  const isUnassignedRoomLabel = useCallback((v: unknown) => {
    const s = String(v ?? "").trim();
    if (!s) return true;
    const u = s.toUpperCase();
    return u === "TBA" || u === "ONLINE";
  }, []);

  const resolveRoomIdFromEligible = useCallback(
    (eligible: any[], valueOrLabel: string) => {
      const raw = String(valueOrLabel ?? "").trim();
      if (!raw || isUnassignedRoomLabel(raw)) return "";
      const list = Array.isArray(eligible) ? eligible : [];

      // If already a room_id from the list, keep it.
      const direct = list.find((r: any) => String(r?.room_id ?? "") === raw);
      if (direct) return String(direct?.room_id ?? "");

      // Otherwise treat it as a label and try to match room_number / room_name.
      const norm = raw.toUpperCase();
      const byLabel = list.find((r: any) => {
        const label = String(r?.room_number || r?.room_name || "").trim();
        return label && label.toUpperCase() === norm;
      });
      return byLabel ? String(byLabel?.room_id ?? "") : raw; // fallback (keeps current UI text)
    },
    [isUnassignedRoomLabel]
  );

  const openEditSpecial = async (it: any) => {
    try {
      const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
      const userId = raw.userId || raw.user_id || raw.id;
      const special_id = String(it?.special_id || it?.originalItem?.special_id || "").trim();
      const special_ids = Array.from(
        new Set(
          ((it?.special_ids || it?.originalItem?.special_ids || []) as any[])
            .map((v) => String(v || "").trim())
            .filter(Boolean)
        )
      );
      if (special_id && !special_ids.includes(special_id)) special_ids.unshift(special_id);
      const section_id = String(it?.section_id || it?.originalItem?.section_id || "").trim();
      if (!userId || !special_id || !section_id) {
        onToast?.("error", "Missing special class identifiers.");
        return;
      }

      const oi = it?.originalItem || it;
      const t1 = splitBeginEnd(oi?.time1);
      const t2 = splitBeginEnd(oi?.time2);
      const d1 = String(oi?.day1 || "TBA");
      const d2 = String(oi?.day2 || "");
      // NOTE: In the overview list these are room *labels* (room_number), not room_id.
      const room1Label = String((oi as any)?.room1 || "").trim();
      const room2Label = String((oi as any)?.room2 || "").trim();

      setSpecialEdit({ special_id, special_ids, section_id, original: oi });

      const day1Val = d1 && d1 !== "TBA" ? d1 : "Monday";
      const begin1Val = t1.begin && t1.begin !== "—" ? t1.begin : "";
      const end1ValRaw = t1.end && t1.end !== "—" ? t1.end : "";
      const end1Val = end1ValRaw || (begin1Val ? (TIME_PAIR[begin1Val] || "") : "");

      const day2ValRaw = d2 && d2 !== "TBA" ? d2 : "";
      const day2Val = day2ValRaw || (DAY_PAIR[day1Val] || "");
      const begin2Val = t2.begin && t2.begin !== "—" ? t2.begin : "";
      const end2ValRaw = t2.end && t2.end !== "—" ? t2.end : "";
      const end2Val = end2ValRaw || (begin2Val ? (TIME_PAIR[begin2Val] || "") : "");

      setSpecialEditDraft({
        day1: day1Val,
        begin1: begin1Val,
        end1: end1Val,
        // Keep label for now; we will convert to room_id once eligible rooms are loaded.
        room1: room1Label && room1Label.toUpperCase() !== "ONLINE" ? room1Label : "",
        day2: day2Val,
        begin2: begin2Val,
        end2: end2Val,
        room2: room2Label && room2Label.toUpperCase() !== "ONLINE" ? room2Label : "",
      });

      // Load eligible rooms for both meetings (best-effort).
      setSpecialRoomsLoading(true);
      const paramsBase = (day: string, begin: string, end: string) =>
        `/api/faculty/special-class/eligible-rooms?user_id=${encodeURIComponent(String(userId))}` +
        `&section_id=${encodeURIComponent(section_id)}` +
        `&day=${encodeURIComponent(String(day || ""))}` +
        `&start_time=${encodeURIComponent(hmToHHMM(begin))}` +
        `&end_time=${encodeURIComponent(hmToHHMM(end))}`;

      const list1 =
        d1 && t1.begin !== "—" && t1.end !== "—"
          ? await apiGet(paramsBase(d1, t1.begin, t1.end))
          : [];
      const list2 =
        d2 && t2.begin !== "—" && t2.end !== "—"
          ? await apiGet(paramsBase(d2, t2.begin, t2.end))
          : [];
      setSpecialRooms1(Array.isArray(list1) ? list1 : []);
      setSpecialRooms2(Array.isArray(list2) ? list2 : []);

      // Convert existing room labels to room_id so saving won't wipe rooms.
      // Only auto-convert if the user hasn't already picked something else.
      setSpecialEditDraft((p) => {
        const next = { ...p } as any;
        if (p.room1 && String(p.room1) === room1Label) {
          next.room1 = resolveRoomIdFromEligible(list1, p.room1);
        }
        if (p.room2 && String(p.room2) === room2Label) {
          next.room2 = resolveRoomIdFromEligible(list2, p.room2);
        }
        return next;
      });
    } catch (e: any) {
      onToast?.("error", e?.message || "Failed to open edit modal.");
      setSpecialEdit(null);
    } finally {
      setSpecialRoomsLoading(false);
    }
  };

  const saveSpecialEdit = async () => {
    if (!specialEdit) return;
    try {
      const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
      const userId = raw.userId || raw.user_id || raw.id;
      if (!userId) throw new Error("User is not logged in");

      setSpecialEditBusy(true);

      // Ensure we post room_id (not room label). If the current value is a label,
      // map it using the latest eligible rooms list.
      const room1Id = resolveRoomIdFromEligible(specialRooms1, specialEditDraft.room1);
      const room2Id = resolveRoomIdFromEligible(specialRooms2, specialEditDraft.room2);

      await apiPost("/api/faculty/special-class/update-schedule", {
        user_id: userId,
        special_id: specialEdit.special_id,
        special_ids: specialEdit.special_ids,
        section_id: specialEdit.section_id,
        meeting1: {
          day: specialEditDraft.day1,
          begin: hmToHHMM(specialEditDraft.begin1),
          end: hmToHHMM(specialEditDraft.end1),
          room_id: room1Id || "",
        },
        meeting2:
          specialEditDraft.day2 && specialEditDraft.begin2 && specialEditDraft.end2
            ? {
                day: specialEditDraft.day2,
                begin: hmToHHMM(specialEditDraft.begin2),
                end: hmToHHMM(specialEditDraft.end2),
                room_id: room2Id || "",
              }
            : {},
      });

      onToast?.("success", "Special class schedule updated. Notifications sent to OM, Chair, and student(s).");
      setSpecialEdit(null);
      setSpecialRooms1([]);
      setSpecialRooms2([]);

      // Refresh Overview so the row reflects changes.
      await Promise.resolve(onRefresh?.());
    } catch (e: any) {
      onToast?.("error", e?.message || "Failed to save schedule changes.");
    } finally {
      setSpecialEditBusy(false);
    }
  };

  // Re-fetch eligible rooms when the user adjusts the day/time fields.
  useEffect(() => {
    if (!specialEdit) return;

    const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
    const userId = raw.userId || raw.user_id || raw.id;
    if (!userId) return;

    const t = window.setTimeout(async () => {
      try {
        setSpecialRoomsLoading(true);
        const paramsBase = (day: string, begin: string, end: string) =>
          `/api/faculty/special-class/eligible-rooms?user_id=${encodeURIComponent(String(userId))}` +
          `&section_id=${encodeURIComponent(specialEdit.section_id)}` +
          `&day=${encodeURIComponent(String(day || ""))}` +
          `&start_time=${encodeURIComponent(hmToHHMM(begin))}` +
          `&end_time=${encodeURIComponent(hmToHHMM(end))}`;

        const can1 = !!specialEditDraft.day1 && !!specialEditDraft.begin1 && !!specialEditDraft.end1;
        const can2 = !!specialEditDraft.day2 && !!specialEditDraft.begin2 && !!specialEditDraft.end2;

        const [r1, r2] = await Promise.all([
          can1 ? apiGet(paramsBase(specialEditDraft.day1, specialEditDraft.begin1, specialEditDraft.end1)) : [],
          can2 ? apiGet(paramsBase(specialEditDraft.day2, specialEditDraft.begin2, specialEditDraft.end2)) : [],
        ]);

        setSpecialRooms1(Array.isArray(r1) ? r1 : []);
        setSpecialRooms2(Array.isArray(r2) ? r2 : []);

        // If the current selection is still a label, try to normalize it to a room_id
        // based on the freshly fetched eligible rooms list.
        setSpecialEditDraft((p) => {
          const next = { ...p } as any;
          next.room1 = resolveRoomIdFromEligible(Array.isArray(r1) ? r1 : [], p.room1);
          next.room2 = resolveRoomIdFromEligible(Array.isArray(r2) ? r2 : [], p.room2);
          return next;
        });
      } catch {
        // Best-effort: keep dropdown usable (TBA still selectable)
      } finally {
        setSpecialRoomsLoading(false);
      }
    }, 250);

    return () => window.clearTimeout(t);
  }, [
    specialEdit?.section_id,
    specialEditDraft.day1,
    specialEditDraft.begin1,
    specialEditDraft.end1,
    specialEditDraft.day2,
    specialEditDraft.begin2,
    specialEditDraft.end2,
    apiGet,
    hmToHHMM,
    resolveRoomIdFromEligible,
  ]);

  // Calendar row sizing:
  // - Keep empty rows compact and consistent (match the schedule card height)
  // - Still allow rows to expand if a slot contains multiple cards
  const CALENDAR_ROW_MIN_PX = 60;

  // Schedule is finalized only when backend explicitly marks it so (e.g., an admin lock).
  // Faculty acceptance should NOT lock/finalize; OM can still edit/resend, and faculty can RFC/accept again.
  const scheduleFinal = Boolean(workflow?.schedule_final);

  const hasServiced = useMemo(
    () =>
      (teachingLoad || []).some(
        (it) => !Boolean((it as any)?.is_special_class) && Boolean((it as any)?.is_serviced)
      ),
    [teachingLoad]
  );

  // Extra guard (frontend): if serviced classes exist, ensure RFC isn't blocked by a stale lock state.
  const scheduleFinalEffective = scheduleFinal && !hasServiced;

  // If OM already marked the schedule as Approved (faculty accepted), prevent accepting again.
  // The button should re-enable when OM sends a new schedule proposal (proposal_status changes away from Approved/Accepted).
  const proposalStatusLower = String(workflow?.proposal_status || "").toLowerCase();
  const isAlreadyApprovedRaw =
    proposalStatusLower === "approved" || proposalStatusLower === "accepted";
  // If serviced classes arrived after acceptance, allow faculty to RFC/accept again.
  const isAlreadyApproved = isAlreadyApprovedRaw && !hasServiced;


const scheduleFinalLabel = (() => {
  if (proposalStatusLower === "accepted") return "Finalized (Accepted)";
  return "Finalized";
})();


  // Split teaching load into regular/serviced vs special classes.
  // Requirement: Special classes must NOT appear in the main Calendar/List views.
  const regularTeachingLoad = useMemo(
    () => (teachingLoad || []).filter((it) => !Boolean((it as any)?.is_special_class)),
    [teachingLoad]
  );
  const specialTeachingLoad = useMemo(
    () => (teachingLoad || []).filter((it) => Boolean((it as any)?.is_special_class)),
    [teachingLoad]
  );
  const groupedSpecialTeachingLoad = useMemo(() => {
    const map = new Map<string, TLItem[]>();

    const normalizeDisplayParts = (value: unknown) =>
      String(value ?? "")
        .split(/\n|,(?=\s*[A-Z])/)
        .map((part) => part.trim())
        .filter((part) => part && part !== "—");

    const normalizeStudentReasonPairs = (it: TLItem): TLItemStudentReasonPair[] => {
      const explicitPairs = Array.isArray((it as any)?.student_reason_pairs)
        ? (((it as any).student_reason_pairs as unknown[])
            .filter((pair): pair is Record<string, unknown> => Boolean(pair) && typeof pair === "object")
            .map((pair) => ({
              special_id: String(pair.special_id || (it as any)?.special_id || "").trim() || undefined,
              student: String(pair.student || "—").trim() || "—",
              reason: String(pair.reason || "—").trim() || "—",
            })))
        : [];
      if (explicitPairs.length) return explicitPairs;

      const students = Array.isArray((it as any)?.students)
        ? (((it as any).students as unknown[]).flatMap((value) => normalizeDisplayParts(value)))
        : normalizeDisplayParts((it as any)?.student);
      const reasons = Array.isArray((it as any)?.reasons)
        ? (((it as any).reasons as unknown[]).flatMap((value) => normalizeDisplayParts(value)))
        : normalizeDisplayParts((it as any)?.reason);
      const maxLen = Math.max(students.length, reasons.length, 1);
      return Array.from({ length: maxLen }, (_, index) => ({
        special_id: String((it as any)?.special_id || "").trim() || undefined,
        student: students[index] || students[0] || "—",
        reason: reasons[index] || reasons[0] || "—",
      }));
    };

    (specialTeachingLoad || []).forEach((it) => {
      const key = [
        String((it as any)?.course_id || "").trim().toUpperCase(),
        String(it.course_code || "").trim().toUpperCase(),
        String(it.course_title || "").trim().toUpperCase(),
      ].join("|");
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    });

    return Array.from(map.entries())
      .map(([groupKey, items]) => {
        const base = { ...(items[0] || {}) } as TLItem;
        const pairByKey = new Map<string, TLItemStudentReasonPair>();
        items.forEach((it) => {
          normalizeStudentReasonPairs(it).forEach((pair, pairIndex) => {
            const dedupeKey = `${String(pair.special_id || (it as any)?.special_id || "").trim() || `ROW-${pairIndex}`}|${pair.student}|${pair.reason}`;
            if (!pairByKey.has(dedupeKey)) pairByKey.set(dedupeKey, pair);
          });
        });
        const studentReasonPairs = Array.from(pairByKey.values()).sort((a, b) =>
          `${a.student}|${a.special_id || ""}`.localeCompare(`${b.student}|${b.special_id || ""}`)
        );
        const students = studentReasonPairs.map((pair) => pair.student || "—");
        const reasons = studentReasonPairs.map((pair) => pair.reason || "—");
        const specialIds = Array.from(new Set(items.flatMap((it) => collectSpecialIds(it))));
        const backendStudentCount = Math.max(
          0,
          ...items.map((it) => {
            const raw = Number((it as any)?.student_count ?? 0);
            return Number.isFinite(raw) ? raw : 0;
          })
        );
        const finalStudentCount = Math.max(students.length, backendStudentCount);
        const overriddenStatus = specialActionOverrides[groupKey];
        const allAccepted = items.every(
          (it) => String((it as any)?.special_faculty_status || "PENDING").toUpperCase() === "ACCEPTED"
        );
        return {
          ...base,
          special_group_key: groupKey,
          special_id: specialIds[0] || String((base as any)?.special_id || ""),
          special_ids: specialIds,
          student_reason_pairs: studentReasonPairs,
          students,
          reasons,
          student: students.join("\n") || "—",
          reason: reasons.join("\n") || "—",
          student_count: finalStudentCount,
          special_faculty_status: overriddenStatus || (allAccepted ? "ACCEPTED" : "PENDING"),
        } as TLItem;
      })
      .filter((it) => String((it as any)?.special_faculty_status || "PENDING").toUpperCase() !== "REJECTED");
  }, [specialTeachingLoad, specialActionOverrides]);
  const acceptedSpecialTeachingLoad = useMemo(
    () =>
      groupedSpecialTeachingLoad.filter(
        (it) => String((it as any)?.special_faculty_status || "PENDING").toUpperCase() === "ACCEPTED"
      ),
    [groupedSpecialTeachingLoad]
  );
  const selectedSpecialList = useMemo(
    () =>
      acceptedSpecialTeachingLoad.filter(
        (it) => Boolean(selectedSpecialIds[String((it as any)?.special_group_key || (it as any)?.special_id || "")])
      ),
    [acceptedSpecialTeachingLoad, selectedSpecialIds]
  );
  const selectedSpecialStudentCount = useMemo(
    () =>
      selectedSpecialList.reduce((total, it) => {
        const raw = Number((it as any)?.student_count ?? 0);
        if (Number.isFinite(raw) && raw > 0) return total + raw;

        const explicitPairs = Array.isArray((it as any)?.student_reason_pairs)
          ? (it as any).student_reason_pairs.filter((pair: any) => pair && typeof pair === "object")
          : [];
        if (explicitPairs.length > 0) return total + explicitPairs.length;

        const students = Array.isArray((it as any)?.students)
          ? (it as any).students.filter((value: any) => String(value ?? "").trim() && String(value ?? "").trim() !== "—")
          : [];
        if (students.length > 0) return total + students.length;

        return total + 1;
      }, 0),
    [selectedSpecialList]
  );
  const allSpecialSelected =
    acceptedSpecialTeachingLoad.length > 0 && selectedSpecialList.length === acceptedSpecialTeachingLoad.length;



  // --- *** MODIFIED: Remove TLData, pass teachingLoad to placeItems *** ---
  const placed = useMemo(() => placeItems(regularTeachingLoad || []), [regularTeachingLoad]);
  const groups = useMemo(() => groupPlacedByCell(placed), [placed]);

  const [showSyllabus, setShowSyllabus] = useState(false);
  const [syllabusUrl, setSyllabusUrl] = useState<string>("");

  const isDrive = (u?: string) => !!u && /(?:drive|docs)\.google\.com/i.test(u || "");
  const toPreview = (u: string) =>
    u.includes("/view") ? u.replace("/view", "/preview")
    : u.includes("?usp=sharing") ? u.replace("?usp=sharing", "/preview")
    : u;

  // --- *** MODIFIED: openSyllabus now takes TLItem *** ---
  const openSyllabus = (it: TLItem) => {
    setSyllabusUrl(it.syllabus || "");
    setShowSyllabus(true);
  };

  const hasTBA = regularTeachingLoad.some((item) => item.day1 === 'TBA' || item.time1 === 'TBA');

  // Special class reject confirmation (custom dialog)
  const [rejectSpecialOpen, setRejectSpecialOpen] = useState(false);
  const [rejectSpecialBusy, setRejectSpecialBusy] = useState(false);
  const [rejectSpecialItem, setRejectSpecialItem] = useState<any | null>(null);

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
	      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex w-full flex-col gap-3">
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 xl:justify-start">
              <h3 className="text-lg font-bold text-neutral-900">Teaching Load Summary</h3>
              <p className="text-sm text-neutral-500">{term?.term_label || ""}</p>
            </div>

            {view === "Calendar" ? (
              <div className="flex w-full justify-start">
                <div className="inline-flex max-w-full flex-wrap items-center gap-4 rounded-xl border border-neutral-200 bg-white px-4 py-2 text-xs text-neutral-700 shadow-sm">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: CAMPUS_COLORS.manila }} />
                    <span>Manila</span>
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: CAMPUS_COLORS.laguna }} />
                    <span>Laguna</span>
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: CAMPUS_COLORS.serviced }} />
                    <span>Serviced</span>
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex w-full flex-col gap-3 xl:max-w-[620px] xl:items-end">
            <div className="inline-flex w-full rounded-xl border border-neutral-200 bg-neutral-50 p-1 xl:w-auto xl:self-end">
              {["Calendar", "List", "Special"].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v as any)}
                  aria-pressed={view === v}
                  className={cls(
                    "inline-flex flex-1 h-9 items-center justify-center rounded-lg px-4 text-sm font-semibold transition xl:flex-none",
                    view === v
                      ? "bg-emerald-700 text-white shadow-sm"
                      : "text-neutral-700 hover:bg-white"
                  )}
                  title={v === "Special" ? "Special Class" : undefined}
                >
                  {v === "Special" ? "Special Class" : v}
                </button>
              ))}
            </div>

            {view !== "Special" ? (
              
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    
                  </div>

                  <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-stretch sm:justify-end lg:w-auto">


                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          if (isAccepting) return;
                          setIsAccepting(true);

                          const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
                          const userId = raw.userId || raw.user_id || raw.id || "";
                          const termId = (term as any)?.term_id || (term as any)?._id || (term as any)?.id;

                          const resp: any = await acceptFacultyLoadAssignment(
                            userId,
                            { ...(termId ? { term_id: termId } : {}), send_to_gcal: sendToGcal }
                          );

                          console.log("ACCEPT resp:", resp);

                          if (sendToGcal) {
                            if (resp?.calendar_ok === false) {
                              onToast?.("warning", resp?.calendar_error || "Calendar was not created.", "Accepted (calendar issue)");
                            } else if (resp?.calendar_ok === true) {
                              onToast?.("success", "Schedule accepted and calendar scheduled by term dates.", "Success");
                            } else {
                              onToast?.("success", "Schedule accepted.", "Success");
                            }
                          } else {
                            onToast?.("success", "Schedule accepted.", "Success");
                          }

                          await onRefresh?.();
                        } catch (e: any) {
                          const msg = e?.response?.data?.detail || e?.message || "Failed to accept schedule.";
                          onToast?.("error", msg, "Action failed");
                          console.error(e);
                        } finally {
                          setIsAccepting(false);
                        }
                      }}
                      disabled={isAccepting || scheduleFinalEffective || isAlreadyApproved}
                      className={cls(
                        "inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-normal shadow-sm sm:min-w-[172px] sm:flex-none",
                        "focus:outline-none focus:ring-2 focus:ring-blue-600/30",
                        (isAccepting || scheduleFinalEffective || isAlreadyApproved)
                          ? "bg-neutral-300 text-neutral-600 cursor-not-allowed"
                          : "bg-blue-600 text-white hover:bg-blue-700 active:translate-y-[0.5px]"
                      )}
                    >
                      {scheduleFinalEffective
                        ? "Finalized"
                        : isAlreadyApproved
                        ? "Approved"
                        : isAccepting
                        ? "Accepting…"
                        : "Accept Schedule"}
                    </button>

                     <label
                      className={cls(
                        "inline-flex h-10 items-center justify-center gap-2 rounded-xl border bg-white px-3 text-sm font-medium shadow-sm sm:min-w-[172px] sm:flex-none",
                        isAccepting || scheduleFinalEffective || isAlreadyApproved
                          ? "border-neutral-200 text-neutral-400 opacity-70"
                          : "border-[#e17100] text-[#e17100]"
                      )}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-orange-300 accent-orange-500 focus:ring-orange-500/30"
                        checked={sendToGcal}
                        onChange={(e) => setSendToGcal(e.target.checked)}
                        disabled={isAccepting || scheduleFinalEffective || isAlreadyApproved}
                      />
                      <span className="whitespace-nowrap">Sync to GCalendar</span>
                    </label>
                  </div>
                </div>
              
            ) : (
              
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    
                  </div>

                  <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-stretch sm:justify-end lg:w-auto">
                    <button
                      type="button"
                      onClick={() => {
                        if (!selectedSpecialStudentCount) {
                          onToast?.("warning", "Select at least one special class.", "Nothing selected");
                          return;
                        }
                        setBulkSpecialOpen(true);
                      }}
                      disabled={bulkSpecialSending || selectedSpecialStudentCount === 0}
                      className={cls(
                        "inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-normal shadow-sm whitespace-nowrap sm:min-w-[172px] sm:flex-none",
                        "focus:outline-none focus:ring-2 focus:ring-blue-600/30",
                        bulkSpecialSending || selectedSpecialList.length === 0
                          ? "bg-neutral-300 text-neutral-600 cursor-not-allowed"
                          : "bg-blue-600 text-white hover:bg-blue-700 active:translate-y-[0.5px]"
                      )}
                      title="Send one grouped inbox message per accepted student"
                    >
                      Send to ({selectedSpecialStudentCount}) Student
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          if (isSyncingSpecial) return;
                          setIsSyncingSpecial(true);

                          const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
                          const userId = raw.userId || raw.user_id || raw.id || "";
                          const termId = (term as any)?.term_id || (term as any)?._id || (term as any)?.id;

                          const resp: any = await acceptFacultyLoadAssignment(
                            userId,
                            ({
                              ...(termId ? { term_id: termId } : {}),
                              send_to_gcal: true,
                              sync_special_only: true,
                              overwrite_gcal: true,
                            } as any)
                          );

                          if (resp?.calendar_ok === false) {
                            onToast?.("warning", resp?.calendar_error || "Calendar was not created.", "Sync issue");
                          } else {
                            onToast?.(
                              "success",
                              resp?.calendar_events_created
                                ? `Synced ${resp.calendar_events_created} special-class event(s) to Google Calendar.`
                                : "No special classes to sync.",
                              "Synced"
                            );
                          }
                        } catch (e: any) {
                          const msg = e?.response?.data?.detail || e?.message || "Failed to sync special classes.";
                          onToast?.("error", msg, "Action failed");
                          console.error(e);
                        } finally {
                          setIsSyncingSpecial(false);
                        }
                      }}
                      disabled={isSyncingSpecial}
                      className={cls(
                        "inline-flex h-11 w-full items-center justify-center rounded-xl border bg-white px-4 text-sm font-medium shadow-sm whitespace-nowrap",
                        "focus:outline-none focus:ring-2 focus:ring-orange-500/30",
                        isSyncingSpecial
                          ? "border-neutral-200 text-neutral-400 opacity-70 cursor-not-allowed"
                          : "border-[#e17100] text-[#e17100] hover:bg-orange-50 active:translate-y-[0.5px]"
                      )}
                      title="Sync Special Classes to Google Calendar"
                    >
                      {isSyncingSpecial ? "Syncing…" : "Sync to Google Calendar"}
                  </button>
                  </div>
                </div>
              
            )}
          </div>
        </div>
      </div>

      <BulkSpecialMessageDialog
        open={bulkSpecialOpen}
        selectedCount={selectedSpecialStudentCount}
        message={bulkSpecialMessage}
        sending={bulkSpecialSending}
        onChangeMessage={setBulkSpecialMessage}
        onClose={() => {
          if (bulkSpecialSending) return;
          setBulkSpecialOpen(false);
        }}
        onSend={async () => {
          try {
            if (bulkSpecialSending) return;
            const ids = Array.from(
              new Set(
                selectedSpecialList
                  .flatMap((it) => collectSpecialIds(it as TLItem))
                  .map((v) => String(v || "").trim())
                  .filter(Boolean)
              )
            );
            if (ids.length === 0) {
              onToast?.("warning", "Select at least one special class.", "Nothing selected");
              return;
            }

            setBulkSpecialSending(true);
            const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
            const userId = raw.userId || raw.user_id || raw.id || "";
            if (!userId) throw new Error("User is not logged in");

            const resp = await apiPost("/api/faculty/special-class/bulk-message", {
              user_id: userId,
              special_ids: ids,
              message: bulkSpecialMessage.trim(),
            });

            const sentCount = Number(resp?.sent_count || 0);
            const skippedCount = Array.isArray(resp?.skipped) ? resp.skipped.length : 0;
            if (sentCount > 0) {
              onToast?.(
                "success",
                skippedCount > 0
                  ? `Sent ${sentCount} message(s). ${skippedCount} item(s) were skipped.`
                  : `Sent ${sentCount} message(s) to selected students.`,
                "Messages sent"
              );
            } else {
              onToast?.("warning", "No messages were sent.", "Nothing sent");
            }

            setSelectedSpecialIds({});
            setBulkSpecialMessage("");
            setBulkSpecialOpen(false);
          } catch (e: any) {
            onToast?.("error", e?.message || "Failed to send bulk messages.", "Action failed");
          } finally {
            setBulkSpecialSending(false);
          }
        }}
      />

      {/* Custom reject confirmation (Special Class tab) */}
      <ConfirmDialog
        open={rejectSpecialOpen}
        tone="danger"
        title="Reject this special class request?"
        description={
          rejectSpecialItem ? (
            <div className="space-y-2">
              <div className="text-sm">
                This will remove the request from your Special Class list and notify the OM/Chair.
              </div>
              <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-800">
                <div className="font-semibold">
                  {rejectSpecialItem.course_code || "—"}{" "}
                  <span className="font-normal text-neutral-600">({rejectSpecialItem.section || "—"})</span>
                </div>
                <div className="text-[13px] text-neutral-600">{rejectSpecialItem.course_title || "—"}</div>
              </div>
            </div>
          ) : null
        }
        confirmText={rejectSpecialBusy ? "Rejecting…" : "Reject"}
        cancelText="Cancel"
        onCancel={() => {
          if (rejectSpecialBusy) return;
          setRejectSpecialOpen(false);
          setRejectSpecialItem(null);
        }}
        onConfirm={async () => {
          if (rejectSpecialBusy) return;
          try {
            setRejectSpecialBusy(true);

            const it = rejectSpecialItem;
            const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
            const userId = raw.userId || raw.user_id || raw.id;
            if (!userId) throw new Error("User is not logged in");
            if (!it?.special_id) throw new Error("Missing special class id");

            const groupKey = String((it as any)?.special_group_key || it.special_id || "").trim();
            await apiPost("/api/faculty/special-class/respond", {
              user_id: userId,
              special_id: it.special_id,
              special_ids: (() => {
                const specialIds = collectSpecialIds(it as TLItem);
                return specialIds.length ? specialIds : [it.special_id];
              })(),
              action: "reject",
            });

            if (groupKey) {
              setSpecialActionOverrides((prev) => ({ ...prev, [groupKey]: "REJECTED" }));
            }
            onToast?.("info", "Special class rejected. Notifications sent to OM, Chair, and student(s).");
            setRejectSpecialOpen(false);
            setRejectSpecialItem(null);
            await Promise.resolve(onRefresh?.());
          } catch (err: any) {
            onToast?.("error", err?.message || "Failed to reject special class.");
          } finally {
            setRejectSpecialBusy(false);
          }
        }}
      />

      {/*
        IMPORTANT:
        "Schedule Locked" applies only to regular/serviced load assignment.
        It must NOT appear in the Special Class tab.
      */}
      {scheduleFinalEffective && view !== "Special" && (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <span className="font-semibold">Schedule Locked:</span> {scheduleFinalLabel}. You can no longer submit RFCs.
        </div>
      )}

        {view === "Calendar" ? (
          <div className="overflow-x-auto">
            <div className="min-w-[860px] rounded-xl border border-neutral-300">
              <div className="grid grid-cols-[140px_repeat(6,1fr)] bg-emerald-800 text-white">
                <div className={cls(TABLE_HEADER_CENTER, "flex items-center justify-center")}>
                  Time
                </div>
                {/* --- MODIFIED: Do not render "TBA" column header --- */}
                {DAY_ORDER.filter(d => d !== "TBA").map((d) => (
                  <div
                    key={d}
                    className={cls(TABLE_HEADER_CENTER, "flex items-center justify-center")}
                  >
                    {d}
                  </div>
                ))}
              </div>

              {view === "Calendar" && hasTBA && (
                <div className="mb-4 rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800 border border-yellow-200">
                    <strong>Note:</strong> You have courses with <strong>TBA</strong> schedules. Switch to <strong>List View</strong> to see them.
                </div>
              )}

              <div
                className="relative grid grid-cols-[140px_repeat(6,1fr)]"
                style={{ gridAutoRows: `minmax(${CALENDAR_ROW_MIN_PX}px, max-content)` }}
              >
                {TIME_BANDS_LABEL.map((band, r) => (
                  <React.Fragment key={band}>
                    <div
                      className="flex h-full items-center justify-center border-r border-neutral-300 bg-neutral-50 px-2 text-center text-[13px]"
                      style={{ gridColumn: 1, gridRow: r + 1 }}
                    >
                      {band}
                    </div>
                     {/* --- MODIFIED: Do not render "TBA" column cells --- */}
                    {DAY_ORDER.filter(d => d !== "TBA").map((_, c) => (
                      <div
                        key={`${c}-${r}`}
                        className="h-full border border-neutral-300"
                        style={{ gridColumn: c + 2, gridRow: r + 1 }}
                      />
                    ))}
                  </React.Fragment>
                ))}

                {groups.map((g, i) => (
                  <div
                    key={`cell-${i}`}
                    className="p-2"
                    style={{
                      gridColumn: DAY_ORDER.indexOf(g.day) + 2,
                      gridRow: g.row + 1,
                    }}
                  >
                    <div className="flex flex-col gap-1.5">
                      {g.items.map((it, j) => (
                        <ClassBlock
                          key={j}
                          it={it}
                          onClick={() => {
                            if (scheduleFinalEffective) return;
                            // Reflected Special Classes must NOT allow RFC.
                            if (it.is_special_class) return;
                            setModal({ day: g.day, item: it });
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
) : view === "Special" ? (
  <>
    {/* Special Class Tab (List-style) */}
  <div className="overflow-x-auto">
    <div className="min-w-[1160px] rounded-xl border border-neutral-300 bg-white">


      <div className="w-full">

        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          
          <colgroup>
            <col className="w-[4%]" />
            <col className="w-[12%]" />
            <col className="w-[16%]" />
            {/* Evenly distribute the remaining columns (do not adjust Student/Reason) */}
            <col className="w-[15%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead className="bg-emerald-800 text-white">
            <tr className="[&>th]:border-b [&>th]:border-gray-200">
              <th className={TABLE_HEADER_CENTER}>
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 accent-emerald-600"
                  checked={allSpecialSelected}
                  disabled={acceptedSpecialTeachingLoad.length === 0}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setSelectedSpecialIds(() => {
                      if (!checked) return {};
                      const next: Record<string, boolean> = {};
                      acceptedSpecialTeachingLoad.forEach((row) => {
                        const sid = String((row as any)?.special_group_key || (row as any)?.special_id || "").trim();
                        if (sid) next[sid] = true;
                      });
                      return next;
                    });
                  }}
                  aria-label="Select all accepted special classes"
                />
              </th>
              {SPECIAL_TABLE_HEADERS.map((h) => (
                <th
                  key={h}
                  className={cls(
                    (h === "Course Code & Title" || h === "Student" || h === "Reason") ? TABLE_HEADER_LEFT : TABLE_HEADER_CENTER,
                    "whitespace-normal break-words"
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-gray-900">
            {groupedSpecialTeachingLoad.length === 0 ? (
              <tr>
                <td colSpan={SPECIAL_TABLE_HEADERS.length + 1} className="px-4 py-6 text-center text-sm text-neutral-500">
                  No special classes.
                </td>
              </tr>
            ) : (
              groupedSpecialTeachingLoad.map((it, idx) => {
                const t1 = splitBeginEnd(it.time1);
                const t2 = splitBeginEnd(it.time2);

                const d1Raw = it.day1 && it.day1 !== "TBA" ? it.day1 : "";
                const d2Raw = it.day2 && it.day2 !== "TBA" ? it.day2 : "";
                const d1 = d1Raw ? dayInitial(d1Raw) : "—";
                const d2 = d2Raw ? dayInitial(d2Raw) : "—";

                const room1Display = normalizeRoomDisplayForSpecial((it as any).room1);
                const room2Display = normalizeRoomDisplayForSpecial((it as any).room2);

                const modeDisplay = specialModeFromRooms((it as any).room1, (it as any).room2);

                const facStatus = String((it as any)?.special_faculty_status || "PENDING").toUpperCase();
                const isPending = facStatus !== "ACCEPTED";

                const onAcceptSpecial = async (e: React.MouseEvent) => {
                  e.stopPropagation();
                  try {
                    const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
                    const userId = raw.userId || raw.user_id || raw.id;
                    if (!userId) throw new Error("User is not logged in");

                    const groupKey = String((it as any)?.special_group_key || (it as any)?.special_id || "").trim();
                    const specialIds = collectSpecialIds(it as TLItem);
                    await apiPost("/api/faculty/special-class/respond", {
                      user_id: userId,
                      special_id: (it as any)?.special_id,
                      special_ids: specialIds.length ? specialIds : [(it as any)?.special_id],
                      action: "accept",
                    });

                    if (groupKey) {
                      setSpecialActionOverrides((prev) => ({ ...prev, [groupKey]: "ACCEPTED" }));
                    }
                    onToast?.("success", "Special class accepted. Notifications sent to OM, Chair, and student(s).");
                    await Promise.resolve(onRefresh?.());
                  } catch (err: any) {
                    onToast?.("error", err?.message || "Failed to accept special class.");
                  }
                };

                const onRejectSpecial = async (e: React.MouseEvent) => {
                  e.stopPropagation();
                  const specialIds = collectSpecialIds(it as TLItem);
                  setRejectSpecialItem({
                    ...it,
                    special_id: (it as any)?.special_id,
                    special_ids: specialIds.length ? specialIds : [(it as any)?.special_id],
                  });
                  setRejectSpecialOpen(true);
                };

                // Allow opening the RFC modal from special classes (Conversation-only mode is handled inside the modal).
                const onOpen = () => {
                  const day = normalizeDay(it.day1) || normalizeDay(it.day2) || "TBA";
                  setModal({
                    day,
                    item: {
                      code: it.course_code,
                      title: it.course_title,
                      sec: it.section,
                      units: it.units,
                      mode: it.mode,
                      room: room1Display || "TBA",
                      time: it.time1 || "TBA",
                      syllabus: it.syllabus,
                      is_special_class: true,
                      special_id: (it as any)?.special_id,
                      special_ids: (() => {
                        const specialIds = collectSpecialIds(it as TLItem);
                        return specialIds.length ? specialIds : [(it as any)?.special_id];
                      })(),
                      forceConversationOnly: true,
                      allowStartConversation: true,
                      originalItem: it,
                    },
                  });
                };

                return (
                  <tr
                    key={idx}
                    className={cls(
                      "bg-white hover:bg-emerald-50 cursor-pointer",
                      "[&>td]:border-t [&>td]:border-gray-100"
                    )}
                    onClick={onOpen}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpen();
                      }
                    }}
                    title="Open Proposed Schedule"
                  >
                    <td
                      className="px-3 py-3 align-top text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-gray-300 accent-emerald-600"
                        disabled={isPending}
                        checked={Boolean(selectedSpecialIds[String((it as any)?.special_group_key || (it as any)?.special_id || "")])}
                        onChange={(e) => {
                          const sid = String((it as any)?.special_group_key || (it as any)?.special_id || "").trim();
                          if (!sid || isPending) return;
                          const checked = e.target.checked;
                          setSelectedSpecialIds((prev) => {
                            const next = { ...prev };
                            if (checked) next[sid] = true;
                            else delete next[sid];
                            return next;
                          });
                        }}
                        aria-label={`Select accepted special class ${it.course_code || ""} ${it.section || ""}`}
                      />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="leading-tight">
                        <div className="text-sm font-semibold text-gray-900 break-words whitespace-normal">
                          {(it as any)?.student_count ? `${(it as any).student_count} student${(it as any).student_count === 1 ? "" : "s"}` : "—"}
                        </div>
                        <div className="mt-1 space-y-1 text-[12px] text-gray-700">
                          {(((it as any)?.student_reason_pairs || []) as TLItemStudentReasonPair[]).length ? (((it as any)?.student_reason_pairs || []) as TLItemStudentReasonPair[]).map((pair, studentIdx) => (
                            <div key={`${pair.special_id || pair.student}-${studentIdx}`} className="break-words whitespace-normal">{pair.student || "—"}</div>
                          )) : <div>—</div>}
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top">
                      <div className="space-y-1 text-[12px] text-gray-800 break-words whitespace-normal">
                        {(((it as any)?.student_reason_pairs || []) as TLItemStudentReasonPair[]).length ? (((it as any)?.student_reason_pairs || []) as TLItemStudentReasonPair[]).map((pair, reasonIdx) => (
                          <div key={`${pair.special_id || pair.reason}-${reasonIdx}`}>{pair.reason || "—"}</div>
                        )) : <div>—</div>}
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top">
                      <div className="leading-tight break-words whitespace-normal">
                        <div className="text-sm font-semibold text-gray-900">{it.course_code || "—"}</div>
                        <div className="mt-0.5 text-[12px] text-gray-600">{it.course_title || "—"}</div>
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top text-center text-sm">{it.section || "—"}</td>

                    
<td className="px-3 py-3 align-top text-center">
                      <div className="flex flex-col items-center gap-1 text-[12px] text-gray-800 leading-tight">
                        <div className="font-semibold">{d1 || "—"}</div>
                        {(d2 || t2.begin || t2.end || room2Display) && <div className="font-semibold">{d2 || "—"}</div>}
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top text-center">
                      <div className="flex flex-col items-center gap-1 text-[12px] text-gray-800 leading-tight whitespace-nowrap">
                        <div>{(t1.begin && t1.end) ? `${t1.begin}–${t1.end}` : "TBA"}</div>
                        {(d2 || t2.begin || t2.end || room2Display) && (
                          <div>{(t2.begin && t2.end) ? `${t2.begin}–${t2.end}` : "TBA"}</div>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top text-center">
                      <div className="flex flex-col items-center gap-1 text-[12px] text-gray-800 leading-tight break-words whitespace-normal">
                        <div>{room1Display || "TBA"}</div>
                        {(d2 || t2.begin || t2.end || room2Display) && (
                          <div>{room2Display || "TBA"}</div>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-3 align-top text-center text-sm text-gray-800">{modeDisplay}</td>

                    <td className="px-3 py-3 align-top text-center">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openSyllabus(it);
                        }}
                        className={cls(
                          "inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs",
                          "border-emerald-200 bg-emerald-50 hover:bg-emerald-100 active:translate-y-[0.5px]",
                          !it.syllabus && "opacity-60"
                        )}
                        title={it.syllabus ? "View syllabus" : "No syllabus uploaded"}
                        aria-label="View syllabus"
                      >
                        <SyllabusIcon className="h-4 w-4" />
                      </button>
                    </td>

                    <td className="px-3 py-3 align-top text-center">
                      {isPending ? (
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            onClick={onAcceptSpecial}
                            className={cls(
                              "inline-flex h-8 w-8 items-center justify-center rounded-lg border",
                              "border-emerald-200 bg-emerald-50 hover:bg-emerald-100 active:translate-y-[0.5px]"
                            )}
                            title="Accept"
                            aria-label="Accept"
                          >
                            <Check className="h-4 w-4 text-emerald-700" />
                          </button>
                          <button
                            type="button"
                            onClick={onRejectSpecial}
                            className={cls(
                              "inline-flex h-8 w-8 items-center justify-center rounded-lg border",
                              "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 active:translate-y-[0.5px]"
                            )}
                            title="Reject"
                            aria-label="Reject"
                          >
                            <X className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpen();
                            }}
                            className={cls(
                              "inline-flex h-8 w-8 items-center justify-center rounded-lg border",
                              "border-slate-200 bg-white hover:bg-slate-50 active:translate-y-[0.5px]"
                            )}
                            title="Message OM/Chair"
                            aria-label="Message OM/Chair"
                          >
                            <MessageSquareText className="h-4 w-4 text-slate-700" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1.5">

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditSpecial(it);
                            }}
                            className={cls(
                              "inline-flex h-8 w-8 items-center justify-center rounded-lg border",
                              "border-emerald-200 bg-emerald-50 hover:bg-emerald-100 active:translate-y-[0.5px]"
                            )}
                            title="Edit Special Class Schedule"
                            aria-label="Edit Special Class Schedule"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  </div>
  </>
) : (
  <>
    {/* New List View */}
          <div className="space-y-6">
            <div className="overflow-x-auto">
              <div className=" border border-gray-200 overflow-hidden bg-white">
                <table className="w-full table-fixed text-[13px]">
                <colgroup>
                  <col className="w-[34%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                </colgroup>
                  <thead className="bg-emerald-800 text-white">
                    <tr className="[&>th]:border-b [&>th]:border-emerald-700">
                      {LIST_HEADERS.map((h) => (
                        <th key={h} className={h === "Course Code & Title" ? TABLE_HEADER_LEFT : TABLE_HEADER_CENTER}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-gray-900">
                    {regularTeachingLoad.length === 0 ? (
                      <tr>
                        <td colSpan={LIST_HEADERS.length} className="px-4 py-6 text-center text-sm text-neutral-500">
                          No records.
                        </td>
                      </tr>
                    ) : (
                      regularTeachingLoad.map((it, idx) => {
                        const t1 = splitBeginEnd(it.time1);
                        const t2 = splitBeginEnd(it.time2);
                        const isSpecial = Boolean((it as any)?.is_special_class);
                        const isConvertedFromSpecial = Boolean((it as any)?.converted_from_special);
                        const isServiced = !isSpecial && Boolean((it as any)?.is_serviced);

                        // Days: converted Special Classes should also use initials in List view.
                        const d1Raw = it.day1 && it.day1 !== "TBA" ? it.day1 : "";
                        const d2Raw = it.day2 && it.day2 !== "TBA" ? it.day2 : "";
                        const d1 = d1Raw ? ((isSpecial || isConvertedFromSpecial || isServiced) ? dayInitial(d1Raw) : d1Raw) : "—";
                        const d2 = d2Raw ? ((isSpecial || isConvertedFromSpecial || isServiced) ? dayInitial(d2Raw) : d2Raw) : "—";

                        // Rooms: converted Special Classes should also keep TBA instead of ONLINE.
                        const room1Display = (isSpecial || isConvertedFromSpecial)
                          ? normalizeRoomDisplayForSpecial((it as any).room1)
                          : (isServiced ? ((it as any).room1 || "TBA") : ((it as any).room1 || "—"));
                        const room2Display = (isSpecial || isConvertedFromSpecial)
                          ? normalizeRoomDisplayForSpecial((it as any).room2)
                          : (isServiced ? ((it as any).room2 || "TBA") : ((it as any).room2 || "—"));

                        // Mode: for special classes auto-derive from rooms (FOL if both rooms unassigned/TBA/ONLINE, else HYB).
                        // In List view: Special Classes should NOT show "Special Class" in the Mode column.
                        const modeRaw = String(it.mode || "").trim();
                        const modeDisplay = isSpecial
                          ? specialModeFromRooms((it as any).room1, (it as any).room2)
                          : (modeRaw || "—");

                        const hasSecondMeeting = Boolean(
                          d2Raw ||
                            (t2.begin && t2.begin !== "—") ||
                            (t2.end && t2.end !== "—") ||
                            (room2Display && room2Display !== "—")
                        );

                        return (
                          <tr
                            key={idx}
                            className={cls(
                              //isSpecial ? "bg-emerald-50" : (isServiced ? "bg-[#CBD5C0]" : "bg-white"),
                              "[&>td]:border-t [&>td]:border-gray-100"
                            )}
                          >
                            <td className="px-4 py-3 align-middle">
                              <div className="leading-tight">
                                <div className="font-semibold text-gray-900">{it.course_code || "—"}</div>
                                <div className="mt-0.5 text-[12px] text-gray-600">{it.course_title || "—"}</div>
                              </div>
                            </td>
                            <td className="px-4 py-3 align-middle text-center">{it.section || "—"}</td>
                            <td className="px-4 py-3 align-top text-center">
                              <div className="flex flex-col items-center gap-1 text-[12px] text-gray-800 leading-tight">
                                <div className="font-normal">{d1 || "—"}</div>
                                {hasSecondMeeting && <div className="font-normal">{d2 || "—"}</div>}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top text-center">
                              <div className="flex flex-col items-center gap-1 text-[12px] text-gray-800 leading-tight whitespace-nowrap">
                                <div>
                                  {t1.begin && t1.end && t1.begin !== "—" ? `${t1.begin}–${t1.end}` : "TBA"}
                                </div>
                                {hasSecondMeeting && (
                                  <div>
                                    {t2.begin && t2.end && t2.begin !== "—" ? `${t2.begin}–${t2.end}` : "TBA"}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-top text-center">
                              <div className="flex flex-col items-center gap-1 text-[12px] text-gray-800 leading-tight break-words whitespace-normal">
                                <div>{room1Display || "—"}</div>
                                {hasSecondMeeting && <div>{room2Display || "—"}</div>}
                              </div>
                            </td>
                            <td className="px-4 py-3 align-middle text-center text-gray-800">{modeDisplay}</td>
                            <td className="px-4 py-3 align-middle text-center">
                              <button
                                type="button"
                                onClick={() => openSyllabus(it)}
                                className={cls(
                                  "inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs",
                                  "border-emerald-200 bg-emerald-50 hover:bg-emerald-100 active:translate-y-[0.5px]",
                                  // allow clicking even if no syllabus
                                  !it.syllabus && "opacity-60"
                                )}
                                title={it.syllabus ? "View syllabus" : "No syllabus uploaded"}
                                aria-label="View syllabus"
                              >
                                <SyllabusIcon className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
  </>
        )}

       {/* Syllabus modal — add it here */}
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
                  <a
                    href={syllabusUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-700 underline ml-2"
                  >
                    Open in New Tab
                  </a>
                </p>
                {isDrive(syllabusUrl) && (
                  <iframe
                    className="w-full h-[500px] border rounded-xl"
                    title="Syllabus"
                    src={toPreview(syllabusUrl)}
                  />
                )}
              </>
            )}
            <div className="flex justify-end mt-6">
              <button
                onClick={() => setShowSyllabus(false)}
                className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Special Class Schedule modal */}
      {specialEdit && (
        <div className="fixed inset-0 z-[110] grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl overflow-hidden">
            <div className="flex items-start justify-between gap-4 border-b border-neutral-200 p-5">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-emerald-800">Edit Special Class Schedule</h2>
                <div className="mt-1 text-xs text-neutral-600">
                  This change does not require approval. OM/Chair will be notified automatically.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (specialEditBusy) return;
                  setSpecialEdit(null);
                  setSpecialRooms1([]);
                  setSpecialRooms2([]);
                }}
                className="rounded-full p-1 hover:bg-neutral-100"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[80vh] overflow-y-auto p-5">
              {(() => {
	                // NOTE: specialEdit is guarded by `{specialEdit && (...)}` above,
	                // but TS doesn't always narrow across the IIFE boundary.
	                const oi = (specialEdit?.original ?? {}) as any;
                const t1 = splitBeginEnd(oi?.time1);
                const t2 = splitBeginEnd(oi?.time2);
                const orig1 = `${dayInitial(oi?.day1 || "TBA") || "TBA"} ${(t1.begin && t1.end && t1.begin !== "—") ? `${t1.begin}–${t1.end}` : "TBA"} (${normalizeRoomDisplayForSpecial((oi as any)?.room1) || "TBA"})`;
                const orig2 = `${dayInitial(oi?.day2 || "TBA") || "TBA"} ${(t2.begin && t2.end && t2.begin !== "—") ? `${t2.begin}–${t2.end}` : "TBA"} (${normalizeRoomDisplayForSpecial((oi as any)?.room2) || "TBA"})`;

                return (
                  <>
                    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2">
                          <div className="text-sm font-semibold text-neutral-800">Meeting 1</div>
                          <div className="text-xs text-neutral-600">Original: {orig1}</div>
                        </div>
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2">
                          <div className="text-sm font-semibold text-neutral-800">Meeting 2</div>
                          <div className="text-xs text-neutral-600">Original: {orig2}</div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-xl border border-neutral-200 bg-white">
                      <div className="border-b border-neutral-200 bg-gray-50 px-4 py-3">
                        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">

                            <div className="mt-1 hidden xl:grid grid-cols-4 text-center text-[12px] font-semibold text-emerald-800">
                              <div>Day 1</div>
                              <div>Begin 1</div>
                              <div>End 1</div>
                              <div>Room 1</div>
                            </div>

                            <div className="mt-1 hidden xl:grid grid-cols-4 text-center text-[12px] font-semibold text-emerald-800">
                              <div>Day 2</div>
                              <div>Begin 2</div>
                              <div>End 2</div>
                              <div>Room 2</div>
                            </div>
                        
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-3 px-4 py-4 xl:grid-cols-2">
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                        {/* Day 1 */}
                        <SpecialDropdown
                          value={specialEditDraft.day1}
                          onChange={(v) => {
                            const autoDay2 = DAY_PAIR[v] || "";
                            setSpecialEditDraft((p) => ({ ...p, day1: v, day2: autoDay2 }));
                          }}
                          options={ALL_DAYS.map((d) => ({ value: d, label: d }))}
                          placeholder="—"
                        />

                        {/* Begin 1 (auto-sets End 1) */}
                        <SpecialDropdown
                          value={specialEditDraft.begin1}
                          onChange={(v) => {
                            const autoEnd = v ? (TIME_PAIR[v] || "") : "";
                            setSpecialEditDraft((p) => ({ ...p, begin1: v, end1: autoEnd }));
                          }}
                          options={[
                            { value: "", label: "—" },
                            ...TIME_POINTS.map((t) => ({ value: t, label: t })),
                          ]}
                          placeholder="—"
                        />

                        {/* End 1 (editable) */}
                        <SpecialDropdown
                          value={specialEditDraft.end1}
                          onChange={(v) => setSpecialEditDraft((p) => ({ ...p, end1: v }))}
                          options={[
                            { value: "", label: "—" },
                            ...TIME_POINTS.map((t) => ({ value: t, label: t })),
                          ]}
                          placeholder="—"
                        />

                        {/* Room 1 */}
                        <SpecialDropdown
                          value={specialEditDraft.room1}
                          onChange={(v) => setSpecialEditDraft((p) => ({ ...p, room1: v }))}
                          options={[
                            { value: "", label: "TBA" },
                            ...specialRooms1.map((r: any) => ({
                              value: String(r?.room_id ?? ""),
                              label: String(r?.room_number || r?.room_name || r?.room_id || ""),
                            })),
                          ].filter((o) => o.value !== "")}
                          includeEmptyOption={{ value: "", label: "TBA" }}
                          disabled={specialRoomsLoading}
                        />

                        </div>

                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">

                        {/* Day 2 (auto-filled but editable) */}
                        <SpecialDropdown
                          value={specialEditDraft.day2}
                          onChange={(v) => setSpecialEditDraft((p) => ({ ...p, day2: v }))}
                          options={[
                            { value: "", label: "—" },
                            ...ALL_DAYS.map((d) => ({ value: d, label: d })),
                          ]}
                          placeholder="—"
                        />

                        {/* Begin 2 (auto-sets End 2) */}
                        <SpecialDropdown
                          value={specialEditDraft.begin2}
                          onChange={(v) => {
                            const autoEnd = v ? (TIME_PAIR[v] || "") : "";
                            setSpecialEditDraft((p) => ({ ...p, begin2: v, end2: autoEnd }));
                          }}
                          options={[
                            { value: "", label: "—" },
                            ...TIME_POINTS.map((t) => ({ value: t, label: t })),
                          ]}
                          placeholder="—"
                        />

                        {/* End 2 (editable) */}
                        <SpecialDropdown
                          value={specialEditDraft.end2}
                          onChange={(v) => setSpecialEditDraft((p) => ({ ...p, end2: v }))}
                          options={[
                            { value: "", label: "—" },
                            ...TIME_POINTS.map((t) => ({ value: t, label: t })),
                          ]}
                          placeholder="—"
                        />

                        {/* Room 2 */}
                        <SpecialDropdown
                          value={specialEditDraft.room2}
                          onChange={(v) => setSpecialEditDraft((p) => ({ ...p, room2: v }))}
                          options={[
                            { value: "", label: "TBA" },
                            ...specialRooms2.map((r: any) => ({
                              value: String(r?.room_id ?? ""),
                              label: String(r?.room_number || r?.room_name || r?.room_id || ""),
                            })),
                          ].filter((o) => o.value !== "")}
                          includeEmptyOption={{ value: "", label: "TBA" }}
                          disabled={specialRoomsLoading || !specialEditDraft.day2}
                        />
                        </div>
                    </div>
                    </div>

                    {specialRoomsLoading && (
                      <div className="mt-2 text-xs text-neutral-500">Loading available rooms…</div>
                    )}
                  </>
                );
              })()}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-neutral-200 p-4">
              <button
                type="button"
                onClick={() => {
                  if (specialEditBusy) return;
                  setSpecialEdit(null);
                  setSpecialRooms1([]);
                  setSpecialRooms2([]);
                }}
                className="rounded-xl border border-neutral-200 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveSpecialEdit}
                disabled={specialEditBusy || !specialEditDraft.day1 || !specialEditDraft.begin1 || !specialEditDraft.end1}
                className={cls(
                  "rounded-xl px-4 py-2 text-sm font-semibold text-white",
                  specialEditBusy
                    ? "bg-neutral-300 cursor-not-allowed"
                    : "bg-emerald-700 hover:bg-emerald-800"
                )}
              >
                {specialEditBusy ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ChangeRequestModal
        open={!!modal}
        onClose={() => setModal(null)}
        context={modal}
        term={term}
        scheduleFinal={scheduleFinalEffective}
        allTeachingLoad={teachingLoad}
        onToast={onToast}
        onRefresh={onRefresh}
      />
    </section>
  );
}

/* =========================================
   3) Change Request Modal (UI-only)
   ========================================= */
type ChangeKind = "Change class time" | "Change class day" | "Other";
const ALL_DAYS: DayLong[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(() => Math.max(0, options.findIndex((o) => o === value)));
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setHover(Math.max(0, options.findIndex((o) => o === value))), [value, options]);
  useEffect(() => {
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
          className="absolute z-20 mt-2 w-full max-h-80 overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg"
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
              className={cls("block w-full text-left px-4 py-3 text-sm", i === hover && "bg-emerald-50")}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ChangeRequestModal({
  open,
  onClose,
  context,
  term,
  scheduleFinal,
  allTeachingLoad,
  onToast,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  context: { day: DayLong; item: TLItemForCalendar } | null; // <-- MODIFIED
  term: any;
  scheduleFinal: boolean;
  allTeachingLoad: TLItem[];
  onToast?: (kind: ToastKind, message: string, title?: string) => void;
  onRefresh?: () => Promise<void> | void;
}) {
  const TIME_SLOTS = [
    "07:30 – 09:00",
    "09:15 – 10:45",
    "11:00 – 12:30",
    "12:30 – 14:15",
    "14:30 – 16:00",
    "16:15 – 17:45",
    "18:00 – 19:30",
    "19:45 – 21:00"
  ];

  const [choices, setChoices] = useState<ChangeKind[]>([]);
  // RFC is by pair (meeting 1 + meeting 2), not by individual day tile.
  const [selTime1, setSelTime1] = useState("");
  const [selTime2, setSelTime2] = useState("");
  const [selDay1, setSelDay1] = useState<DayLong | "">("");
  const [selDay2, setSelDay2] = useState<DayLong | "">("");
  const [remarks, setRemarks] = useState("");
  const [otherText, setOtherText] = useState("");
  const [panel, setPanel] = useState<"request" | "conversation">("request");

  // Custom confirmation dialog (replaces window.confirm)
  const conflictConfirmResolver = useRef<((v: boolean) => void) | null>(null);
  const [conflictConfirm, setConflictConfirm] = useState<{
    open: boolean;
    conflicts: Array<{
      day: DayLong;
      time: string;
      with: { code: string; section: string; is_serviced?: boolean };
    }>;
  }>({ open: false, conflicts: [] });

  const confirmPotentialConflict = useCallback(
    (conflicts: Array<{ day: DayLong; time: string; with: { code: string; section: string; is_serviced?: boolean } }>) => {
      return new Promise<boolean>((resolve) => {
        conflictConfirmResolver.current = resolve;
        setConflictConfirm({ open: true, conflicts });
      });
    },
    []
  );

  const closeConflictConfirm = useCallback((result: boolean) => {
    const r = conflictConfirmResolver.current;
    conflictConfirmResolver.current = null;
    setConflictConfirm({ open: false, conflicts: [] });
    r?.(result);
  }, []);

  // ================================
  // Schedule conflict detection (RFC)
  // - Warn before sending, but NEVER block submission.
  // - Compare requested schedule against faculty's current schedule overview
  //   (regular classes Manila/Laguna + serviced classes).
  // - Special rule:
  //   Mon/Tue/Wed = Online days: if overlap and SAME course -> NOT a conflict.
  //   Thu/Fri/Sat = F2F days: any overlap is a conflict, even if SAME course.
  // ================================
  const ONLINE_DAYS = useMemo(() => new Set<DayLong>(["Monday", "Tuesday", "Wednesday"]), []);

  const parseTimeRange = useCallback((raw?: string): { start: number; end: number } | null => {
    const s = String(raw ?? "").trim();
    if (!s || s.toUpperCase() === "TBA") return null;
    // Accept: "07:30 – 09:00" | "7:30-9:00" | "07:30 — 09:00"
    const parts = s
      .split(/\s*(?:–|—|-)\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) return null;
    const a = hmToMinutes(parts[0]);
    const b = hmToMinutes(parts[1]);
    if (a == null || b == null) return null;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end <= start) return null;
    return { start, end };
  }, []);

  const rangesOverlap = useCallback(
    (a: { start: number; end: number }, b: { start: number; end: number }) => {
      // Standard half-open interval overlap
      return a.start < b.end && b.start < a.end;
    },
    []
  );

  const detectConflicts = useCallback(
    (
      requested: Array<{ day: DayLong; time: string }>,
      currentCourseCode: string,
      currentSectionId: string
    ) => {
      const conflicts: Array<{
        day: DayLong;
        time: string;
        with: { code: string; section: string; is_serviced?: boolean };
      }> = [];

      const reqMeetings = requested
        .map((m) => ({ ...m, range: parseTimeRange(m.time) }))
        .filter((m) => m.day && m.day !== "TBA" && m.range);

      if (!reqMeetings.length) return conflicts;

      const normalizedCurrentSection = String(currentSectionId || "").trim();
      const normalizedCurrentCode = String(currentCourseCode || "").trim().toUpperCase();

      for (const it of allTeachingLoad || []) {
        const itSection = String(it.section_id || "").trim();
        // Ignore self (this course row)
        if (normalizedCurrentSection && itSection && itSection === normalizedCurrentSection) continue;

        const itCode = String(it.course_code || "").trim().toUpperCase();

        const meetings: Array<{ day: DayLong; time: string; range: { start: number; end: number } }> = [];
        const d1 = normalizeDay(it.day1 || "") || null;
        const r1 = parseTimeRange(it.time1);
        if (d1 && d1 !== "TBA" && r1) meetings.push({ day: d1, time: String(it.time1 || ""), range: r1 });
        const d2 = normalizeDay(it.day2 || "") || null;
        const r2 = parseTimeRange(it.time2);
        if (d2 && d2 !== "TBA" && r2) meetings.push({ day: d2, time: String(it.time2 || ""), range: r2 });

        if (!meetings.length) continue;

        for (const req of reqMeetings) {
          for (const cur of meetings) {
            if (req.day !== cur.day) continue;
            if (!rangesOverlap(req.range!, cur.range)) continue;

            const sameCourse = itCode && normalizedCurrentCode && itCode === normalizedCurrentCode;

            if (ONLINE_DAYS.has(req.day)) {
              // Online days: overlap is only a conflict if DIFFERENT course
              if (sameCourse) continue;
            }

            // F2F days: any overlap is a conflict (even same course)
            // If day is not in either set (shouldn't happen), default to conflict.

            conflicts.push({
              day: req.day,
              time: req.time,
              with: { code: it.course_code, section: it.section, is_serviced: it.is_serviced },
            });
          }
        }
      }

      // De-dupe (same course/day/time)
      const seen = new Set<string>();
      return conflicts.filter((c) => {
        const key = `${c.day}|${c.time}|${String(c.with.code)}|${String(c.with.section)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    [ONLINE_DAYS, allTeachingLoad, parseTimeRange, rangesOverlap]
  );

  const dayAbbrev = (d?: string) => {
    const s = String(d || "").trim();
    if (!s) return "";
    const norm = s.toLowerCase();
    if (norm.startsWith("mon")) return "M";
    if (norm.startsWith("tue")) return "T";
    if (norm.startsWith("wed")) return "W";
    // Common local abbreviation: Thursday = H
    if (norm.startsWith("thu")) return "H";
    if (norm.startsWith("fri")) return "F";
    if (norm.startsWith("sat")) return "S";
    if (norm.startsWith("sun")) return "U";
    // If the backend already provides a short code like "M" / "T" / "H" etc.
    if (s.length <= 2) return s.toUpperCase();
    return s.charAt(0).toUpperCase();
  };

  useEffect(() => {
    if (!open) {
      setChoices([]);
      setSelTime1("");
      setSelTime2("");
      setSelDay1("");
      setSelDay2("");
      setRemarks("");
      setOtherText("");
      setPanel("request");

      // If a confirmation is pending and the modal closes, resolve as cancelled.
      if (conflictConfirmResolver.current) {
        closeConflictConfirm(false);
      }
    }
  }, [open]);

  // Special Class Tab: force Conversation-only view.
  useEffect(() => {
    if (!open || !context) return;
    if ((context.item as any)?.forceConversationOnly) {
      setPanel("conversation");
    }
  }, [open, context]);

  if (!open || !context) return null;

  // IMPORTANT:
  // Special Classes use a synthetic section_id like "SPECIAL:<special_id>" for display.
  // The RFC thread key and backend routing for Special Classes expect the raw special_id.
  // Normalize here so Faculty can always message OM from the Conversation panel.
  const normalizeRfcKey = (rawId: string, isSpecial: boolean) => {
    const s = String(rawId || "").trim();
    if (!s) return "";
    if (!isSpecial) return s;
    return s.replace(/^SPECIAL:/i, "");
  };

  const forceConversationOnly = Boolean((context.item as any)?.forceConversationOnly);
  const effectivePanel: "request" | "conversation" = forceConversationOnly ? "conversation" : panel;

  const toggle = (label: ChangeKind) =>
    setChoices((prev) => (prev.includes(label) ? prev.filter((c) => c !== label) : [...prev, label]));

  const oi = context.item.originalItem;
  const hasSecond = Boolean(
    (oi?.day2 && String(oi.day2).trim() && String(oi.day2).trim() !== "TBA") ||
      (oi?.time2 && String(oi.time2).trim() && String(oi.time2).trim() !== "TBA")
  );

  // IMPORTANT: keep ALL options available in RFC dropdowns.
  // Do not omit the current schedule's day/time so faculty can explicitly re-select it if needed.
  const filteredTimeSlots1 = TIME_SLOTS;
  const filteredTimeSlots2 = TIME_SLOTS;
  const filteredDays1 = ALL_DAYS;
  const filteredDays2 = ALL_DAYS;

  const mustTime = choices.includes("Change class time");
  const mustDay = choices.includes("Change class day");
  const isFinalized = Boolean((context?.item as any)?.finalized);
  const disabled =
    scheduleFinal ||
    isFinalized ||
    choices.length === 0 ||
    (mustTime && (!selTime1 || (hasSecond && !selTime2))) ||
    (mustDay && (!selDay1 || (hasSecond && !selDay2))) ||
    // Remarks are required once an RFC is being submitted
    (effectivePanel === "request" && choices.length > 0 && !remarks.trim());

  return (
    <>
      <ConfirmDialog
        open={conflictConfirm.open}
        title="Potential Conflict"
        tone="warning"
        cancelText="Review changes"
        confirmText="Submit anyway"
        description={
          <div className="space-y-3">
            <div>
              A schedule overlap was detected with your current teaching load. You can still submit this RFC if you want.
            </div>
            <div className="max-h-56 overflow-auto rounded-xl border border-neutral-200 bg-neutral-50 p-3">
              <ul className="list-disc space-y-1 pl-5">
                {conflictConfirm.conflicts.slice(0, 10).map((c, idx) => {
                  const tag = c.with.is_serviced ? " (Serviced)" : "";
                  return (
                    <li key={`${c.day}|${c.time}|${c.with.code}|${c.with.section}|${idx}`}>
                      <span className="font-medium text-neutral-900">{c.day}</span> {c.time} overlaps with{" "}
                      <span className="font-medium text-neutral-900">
                        {c.with.code} {c.with.section}
                      </span>
                      {tag}
                    </li>
                  );
                })}
                {conflictConfirm.conflicts.length > 10 ? (
                  <li className="text-neutral-600">(+{conflictConfirm.conflicts.length - 10} more)</li>
                ) : null}
              </ul>
            </div>
          </div>
        }
        onCancel={() => closeConflictConfirm(false)}
        onConfirm={() => closeConflictConfirm(true)}
      />

      <div className="fixed inset-0 z-80 grid place-items-center bg-black/30 p-3">
	    <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl max-h-[92vh] flex flex-col overflow-hidden">
	      {/* Header */}
	      <div className="border-b border-neutral-200 p-5 sm:p-6">
	        <div className="flex items-start justify-between gap-4">
	          <div className="min-w-0">
	            <h3 className="text-xl font-semibold text-emerald-700">Proposed Schedule</h3>
	            <p className="mt-0.5 text-sm text-neutral-500">
	              {context.item.code} {context.item.sec}
	            </p>
	          </div>
	          <button
	            className="shrink-0 rounded-full p-1 hover:bg-neutral-100"
	            onClick={onClose}
	            aria-label="Close"
	            type="button"
	          >
	            <X className="h-5 w-5" />
	          </button>
	        </div>

	        {/* Panel switcher */}
	        <div className="mt-4 flex w-full items-center justify-between gap-3">
	          {(context.item as any)?.forceConversationOnly ? (
              <div className="inline-flex rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-900">
                Conversation
              </div>
            ) : (
	            <div className="inline-flex rounded-xl border border-neutral-200 bg-neutral-50 p-1">
	              <button
	                type="button"
	                onClick={() => setPanel("request")}
	                className={cls(
	                  "rounded-lg px-3 py-1.5 text-sm font-medium",
	                  panel === "request"
	                    ? "bg-white text-neutral-900 shadow-sm"
	                    : "text-neutral-600 hover:text-neutral-900"
	                )}
	                aria-pressed={panel === "request"}
	              >
	                Request
	              </button>
	              <button
	                type="button"
	                onClick={() => setPanel("conversation")}
	                className={cls(
	                  "rounded-lg px-3 py-1.5 text-sm font-medium",
	                  panel === "conversation"
	                    ? "bg-white text-neutral-900 shadow-sm"
	                    : "text-neutral-600 hover:text-neutral-900"
	                )}
	                aria-pressed={panel === "conversation"}
	              >
	                Conversation
	              </button>
	            </div>
	          )}
	        </div>
	      </div>

	      {/* Body (scrollable) */}
	      <div className="flex-1 min-h-0 overflow-y-auto p-5 sm:p-6">
	        {effectivePanel === "conversation" ? (
	          <RfcThreadView
	            term={term}
	            sectionId={(() => {
	              const oiAny: any = (context.item.originalItem as any) || {};
	              const isSpecial = Boolean(
	                (context.item as any)?.is_special_class ||
	                  (context.item as any)?.isSpecialClass ||
	                  oiAny?.is_special_class
	              );
	              const raw =
	                (isSpecial ? (oiAny?.special_id || (context.item as any)?.special_id) : "") ||
	                oiAny?.section_id ||
	                oiAny?.sectionId ||
	                "";
	              return normalizeRfcKey(raw, isSpecial);
	            })()}
	            allowStartConversation={Boolean((context.item as any)?.allowStartConversation)}
	            alwaysShowReply={Boolean((context.item as any)?.is_special_class)}
	          />
	        ) : (
	          <div className="space-y-4">
	            {/* Status banners */}
	            {scheduleFinal && (
	              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
	                The schedule is already finalized and locked. RFC is disabled.
	              </div>
	            )}
	
	            {isFinalized && (
	              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
	                This course has already been finalized by the Office Manager. RFC is disabled for this course.
	              </div>
	            )}
	
	            {/* Current schedule summary */}
	            <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
	              <div className="flex items-center justify-between gap-3">
	                <div className="text-sm font-semibold text-neutral-800">Current schedule</div>
	                <button
	                  type="button"
	                  onClick={() => setPanel("conversation")}
	                  className="text-sm font-medium text-emerald-700 hover:underline"
	                >
	                  View conversation
	                </button>
	              </div>
	              {/* Compact meeting layout (Day / Time / Room columns) */}
	              <div className="mt-3 overflow-hidden rounded-xl border border-neutral-200 bg-white">
	                <div className="grid grid-cols-3 gap-0 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-xs font-semibold text-neutral-600">
	                  <div>Day</div>
	                  <div>Time</div>
	                  <div className="text-right">Room</div>
	                </div>
	
	                <div className="grid grid-cols-3 gap-0 px-3 py-2 text-sm">
	                  <div className="font-medium text-neutral-800">{dayAbbrev(oi?.day1) || "TBA"}</div>
	                  <div className="font-medium text-neutral-800">{String(oi?.time1 || "TBA")}</div>
	                  <div className="text-right text-neutral-700">{normalizeRoomDisplayForSpecial(oi?.room1) || "TBA"}</div>
	                </div>

	                {hasSecond ? (
	                  <div className="grid grid-cols-3 gap-0 border-t border-neutral-100 px-3 py-2 text-sm">
	                    <div className="font-medium text-neutral-800">{dayAbbrev(oi?.day2) || "TBA"}</div>
	                    <div className="font-medium text-neutral-800">{String(oi?.time2 || "TBA")}</div>
	                    <div className="text-right text-neutral-700">{normalizeRoomDisplayForSpecial(oi?.room2) || "TBA"}</div>
	                  </div>
	                ) : (
	                  <div className="grid grid-cols-3 border-t border-neutral-100 px-3 py-2 text-sm text-neutral-500">
	                    <div className="col-span-3">No second meeting</div>
	                  </div>
	                )}
	              </div>
	            </div>
	
	            {/* Step 1: choose what to change */}
	            <div className="rounded-2xl border border-neutral-200 bg-white p-4">
	              <div className="flex items-start justify-between gap-3">
	                <div>
	                  <div className="text-sm font-semibold text-neutral-800">1) What would you like to change?</div>
	                  <div className="mt-0.5 text-sm text-neutral-500">Select one or more options.</div>
	                </div>
	              </div>
	              <div className="mt-3 flex flex-wrap gap-2">
	                {(["Change class time", "Change class day", "Other"] as ChangeKind[]).map((opt) => (
	                  <button
	                    key={opt}
	                    type="button"
	                    onClick={() => toggle(opt)}
	                    className={cls(
	                      "rounded-xl border px-3 py-2 text-sm",
	                      "transition-colors",
	                      choices.includes(opt)
	                        ? "border-emerald-600 bg-emerald-50 text-emerald-800"
	                        : "border-neutral-300 bg-white hover:bg-neutral-50"
	                    )}
	                  >
	                    {opt}
	                  </button>
	                ))}
	              </div>
	            </div>
	
	            {/* Step 2: details */}
	            {(mustTime || mustDay || choices.includes("Other")) && (
	              <div className="rounded-2xl border border-neutral-200 bg-white p-4">
	                <div className="text-sm font-semibold text-neutral-800">2) Provide the new schedule/details</div>
	                <div className="mt-0.5 text-sm text-neutral-500">
	                  For paired schedules, Meeting 1 and Meeting 2 are submitted together.
	                </div>
	
	                {mustTime && (
	                  <div className="mt-4">
	                    <div className="mb-2 text-sm font-medium text-neutral-700">New time slot</div>
	                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
	                      <div>
	                        <div className="mb-1 text-xs font-semibold text-neutral-600">Meeting 1</div>
	                        <Dropdown
	                          value={selTime1}
	                          onChange={setSelTime1}
	                          options={filteredTimeSlots1}
	                          placeholder="— Select a time —"
	                        />
	                      </div>
	                      {hasSecond && (
	                        <div>
	                          <div className="mb-1 text-xs font-semibold text-neutral-600">Meeting 2</div>
	                          <Dropdown
	                            value={selTime2}
	                            onChange={setSelTime2}
	                            options={filteredTimeSlots2}
	                            placeholder="— Select a time —"
	                          />
	                        </div>
	                      )}
	                    </div>
	                  </div>
	                )}
	
	                {mustDay && (
	                  <div className="mt-4">
	                    <div className="mb-2 text-sm font-medium text-neutral-700">New class day</div>
	                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
	                      <div>
	                        <div className="mb-1 text-xs font-semibold text-neutral-600">Meeting 1</div>
	                        <Dropdown
	                          value={selDay1}
	                          onChange={(v) => setSelDay1(v as DayLong)}
	                          options={filteredDays1}
	                          placeholder="— Select a day —"
	                        />
	                      </div>
	                      {hasSecond && (
	                        <div>
	                          <div className="mb-1 text-xs font-semibold text-neutral-600">Meeting 2</div>
	                          <Dropdown
	                            value={selDay2}
	                            onChange={(v) => setSelDay2(v as DayLong)}
	                            options={filteredDays2}
	                            placeholder="— Select a day —"
	                          />
	                        </div>
	                      )}
	                    </div>
	                  </div>
	                )}
	
	                {choices.includes("Other") && (
	                  <div className="mt-4">
	                    <label className="mb-1 block text-sm font-medium text-neutral-700">
	                      Specify change <span className="text-red-500">*</span>
	                    </label>
	                    <input
	                      type="text"
	                      className="w-full rounded-xl border border-neutral-300 p-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-600/20"
	                      placeholder="Type your custom change…"
	                      value={otherText}
	                      onChange={(e) => setOtherText(e.target.value)}
	                    />
	                  </div>
	                )}
	              </div>
	            )}
	
	            {/* Step 3: remarks */}
	            {!!choices.length && (
	              <div className="rounded-2xl border border-neutral-200 bg-white p-4">
	                <div className="text-sm font-semibold text-neutral-800">3) Special remarks <span className="text-red-500">*</span></div>
	                <textarea
	                  rows={4}
	                  className="mt-3 w-full resize-y rounded-xl border border-neutral-300 p-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-600/20"
	                  placeholder="Include brief context so OM can review faster..."
	                  value={remarks}
	                  onChange={(e) => setRemarks(e.target.value)}
	                />
                {!remarks.trim() && (
                  <div className="mt-1 text-xs text-red-600">Remarks are required to send this RFC.</div>
                )}
	              </div>
	            )}
	          </div>
	        )}
	      </div>

	      {/* Footer */}
	      {forceConversationOnly ? (
	        <div className="p-6 pt-0 flex items-center justify-end">
	          <button
	            onClick={onClose}
	            className="inline-flex h-9 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
	          >
	            Close
	          </button>
	        </div>
	      ) : (
	        <div className="p-6 pt-0 flex items-center justify-end gap-2.5">
            <button
              onClick={onClose}
              className="inline-flex h-9 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
            >
              Cancel
            </button>
            <button
              disabled={disabled}
              onClick={async () => {
            try {
              const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
              const userId = raw.userId || raw.user_id || raw.id || "";

              const requestedDay1 = mustDay ? (selDay1 || oi?.day1 || "TBA") : (oi?.day1 || "TBA");
              const requestedTime1 = mustTime ? (selTime1 || oi?.time1 || "TBA") : (oi?.time1 || "TBA");
              const requestedDay2 = hasSecond
                ? mustDay
                  ? (selDay2 || oi?.day2 || "TBA")
                  : (oi?.day2 || "TBA")
                : "";
              const requestedTime2 = hasSecond
                ? mustTime
                  ? (selTime2 || oi?.time2 || "TBA")
                  : (oi?.time2 || "TBA")
                : "";

              // ===== Conflict check (warn only; do not block) =====
              const oiAny: any = (context?.item?.originalItem ?? context?.item ?? {});
              const sectionIdForSend =
                oiAny.section_id ||
                oiAny.special_id ||
                oiAny.id ||
                oiAny.sectionId ||
                oiAny.section?.section_id ||
                oiAny.section?.id ||
                "";

              const requestedMeetings: Array<{ day: DayLong; time: string }> = [];
              const rDay1 = normalizeDay(String(requestedDay1 || "")) || "TBA";
              if (rDay1 !== "TBA" && requestedTime1 && String(requestedTime1).toUpperCase() !== "TBA") {
                requestedMeetings.push({ day: rDay1, time: requestedTime1 });
              }
              const rDay2 = hasSecond ? (normalizeDay(String(requestedDay2 || "")) || "TBA") : "TBA";
              if (hasSecond && rDay2 !== "TBA" && requestedTime2 && String(requestedTime2).toUpperCase() !== "TBA") {
                requestedMeetings.push({ day: rDay2, time: requestedTime2 });
              }

              const conflicts = detectConflicts(
                requestedMeetings,
                String(context.item.code || ""),
                String(sectionIdForSend || "")
              );
              if (conflicts.length) {
                const proceed = await confirmPotentialConflict(conflicts);
                if (!proceed) return;

                // Still show a visible warning toast after confirmation (non-blocking)
                const preview = conflicts
                  .slice(0, 3)
                  .map((c) => {
                    const tag = c.with.is_serviced ? " (Serviced)" : "";
                    return `${c.day} ${c.time} overlaps with ${c.with.code} ${c.with.section}${tag}`;
                  })
                  .join(" • ");
                const more = conflicts.length > 3 ? ` (+${conflicts.length - 3} more)` : "";
                onToast?.(
                  "warning",
                  `Potential schedule conflict detected: ${preview}${more}. You chose to submit anyway.`,
                  "Schedule Conflict"
                );
              }

              // Build a clear, paired summary for OM (avoids confusion between Day 1/2 and Meeting 1/2)
              const msgLines: string[] = [];
              msgLines.push(`RFC: ${context.item.code} ${context.item.sec}`);
              msgLines.push("");
              msgLines.push("CURRENT SCHEDULE");
              msgLines.push(
                `Meeting 1: Day ${oi?.day1 || "TBA"} | Time ${oi?.time1 || "TBA"}`
              );
              msgLines.push(
                hasSecond
                  ? `Meeting 2: Day ${oi?.day2 || "TBA"} | Time ${oi?.time2 || "TBA"}`
                  : "Meeting 2: —"
              );
              msgLines.push("");
              msgLines.push("REQUESTED SCHEDULE");
              msgLines.push(
                `Meeting 1: Day ${requestedDay1} | Time ${requestedTime1}`
              );
              msgLines.push(
                hasSecond
                  ? `Meeting 2: Day ${requestedDay2 || "TBA"} | Time ${requestedTime2 || "TBA"}`
                  : "Meeting 2: —"
              );

              msgLines.push("");
              msgLines.push("REMARKS");
              msgLines.push(remarks.trim());

              const msg = msgLines.join("\n");

              const sectionId = sectionIdForSend;

              if (!sectionId) {
                console.error("RFC send blocked: missing section_id on row", oiAny);
                onToast?.("error", "Cannot send RFC: missing section_id for this assigned course row.", "RFC not sent");
                return;
              }

              const resp = await sendFacultyLoadAssignmentRfcMessage(userId, {
                term_id: (term as any)?.term_id || (term as any)?._id || (term as any)?.id,
                section_id: sectionId,
                message: msg,
                // Structured schedule request so OM approval can auto-apply
                requested: {
                  day1: requestedDay1,
                  time1: requestedTime1,
                  day2: requestedDay2,
                  time2: requestedTime2,
                },
              });

              // Optional: show a useful message if Gmail isn't connected
              if (resp && resp.email_sent === false && resp.email_error) {
                console.warn("RFC saved but email was not sent:", resp.email_error);
                onToast?.("info", "RFC saved, but email was not sent. Please connect Gmail in your profile if you want email notifications.", "Email not sent");
              }

              onToast?.("success", "RFC sent successfully.", "Success");
              await onRefresh?.();
            } catch (e: any) {
              const msg =
                e?.response?.data?.detail ||
                e?.message ||
                "Failed to send RFC.";
              onToast?.("error", msg, "RFC not sent");
              console.error(e);
            } finally {
              onClose();
            }
	          }}

              className={cls(
                "inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm text-white shadow",
                "bg-[#1F7A49] hover:brightness-[1.06] active:translate-y-[0.5px] focus:outline-none focus:ring-2 focus:ring-emerald-600/40",
                disabled && "opacity-60 cursor-not-allowed"
              )}
              aria-disabled={disabled}
            >
              <SendIcon className="h-4 w-4" strokeWidth={2.2} />
              Send
            </button>
	        </div>
	      )}
      </div>
      </div>
    </>
  );
}

function RfcThreadView({
  term,
  sectionId,
  allowStartConversation,
  alwaysShowReply,
}: {
  term: any;
  sectionId: string;
  allowStartConversation?: boolean;
  alwaysShowReply?: boolean;
}) {
  const [thread, setThread] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
        const userId = raw.userId || raw.user_id || raw.id || "";
        const resp = await getFacultyLoadAssignmentRfc(userId, {
          term_id: term?.term_id || term?._id || term?.id,
          section_id: sectionId,
        });
        if (!alive) return;
        setThread(resp?.rfc || null);
      } catch (e) {
        console.error(e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [term?.term_id, term?._id, term?.id, sectionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [thread]);

  if (loading && !thread) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
        Loading RFC thread…
      </div>
    );
  }

  const msgs = thread?.messages || thread?.thread || [];
  const hasMsgs = Array.isArray(msgs) && msgs.length > 0;
  const locked = Boolean(thread?.locked);

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-neutral-800">RFC Conversation</div>
      </div>

      {hasMsgs ? (
        <div ref={scrollRef} className="max-h-[60vh] space-y-2 overflow-y-auto rounded-lg bg-neutral-50 p-2">
          {msgs.map((m: any, i: number) => {
            const role = String(m.sender_role || "").toLowerCase();
            const isMe = role === "faculty";
            const ts = m.created_at ? new Date(m.created_at) : null;
            const time = ts && !isNaN(ts.getTime()) ? ts.toLocaleString() : "";
            return (
              <div key={i} className={cls("flex", isMe ? "justify-end" : "justify-start")}> 
                <div
                  className={cls(
                    "max-w-[85%] rounded-xl px-3 py-2 text-sm shadow-sm",
                    isMe ? "bg-emerald-700 text-white" : "bg-white text-neutral-800 border border-neutral-200"
                  )}
                >
                  <div className="whitespace-pre-wrap">{m.message}</div>
                  {!!time && <div className={cls("mt-1 text-[11px]", isMe ? "text-emerald-100" : "text-neutral-500")}>{time}</div>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
          {allowStartConversation ? "No conversation yet. You can start one below." : "No RFC thread yet. You may send a request below."}
        </div>
      )}

      {/* Quick reply: allow faculty to respond in-thread even without creating a new RFC request */}
      {(!locked && !!sectionId && (Boolean(alwaysShowReply) || hasMsgs || Boolean(allowStartConversation))) ? (
        <div className="mt-3 flex items-end gap-2">
          <textarea
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply to Office Manager…"
            className="flex-1 resize-none rounded-xl border border-neutral-300 bg-white p-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-600/20"
          />
          <button
            type="button"
            disabled={sending || !reply.trim() || !sectionId}
            onClick={async () => {
              if (!reply.trim() || !sectionId) return;
              try {
                setSending(true);
                const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
                const userId = raw.userId || raw.user_id || raw.id || "";
                await sendFacultyLoadAssignmentRfcMessage(userId, {
                  term_id: (term as any)?.term_id || (term as any)?._id || (term as any)?.id,
                  section_id: sectionId,
                  message: reply.trim(),
                });
                setReply("");
                const refreshed = await getFacultyLoadAssignmentRfc(userId, {
                  term_id: (term as any)?.term_id || (term as any)?._id || (term as any)?.id,
                  section_id: sectionId,
                });
                setThread(refreshed?.rfc || null);
              } catch (e) {
                console.error(e);
              } finally {
                setSending(false);
              }
            }}
            className={cls(
              "inline-flex h-9 w-10 items-center justify-center rounded-xl text-white shadow",
              "bg-[#1F7A49] hover:brightness-[1.06] active:translate-y-[0.5px]",
              (sending || !reply.trim() || !sectionId) && "opacity-60 cursor-not-allowed"
            )}
          >
            <SendIcon className={cls("h-4 w-4", sending && "animate-pulse")} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
