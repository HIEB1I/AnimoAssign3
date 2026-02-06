// frontend/src/pages/FACULTY/FAC_Overview.tsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Send as SendIcon, X, BookOpen as SyllabusIcon } from "lucide-react";

import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import HistoryMain from "./FACULTY_History";
import PreferencesContent from "./FACULTY_Preferences";
import DeloadingsContent from "./FACULTY_Deloadings";
import { InboxContent } from "./FACULTY_Inbox";
import { acceptTeachingLoadToGcal } from "../../api"; 


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
type ToastKind = "success" | "error" | "info";
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
   0) Page
   ========================================= */
export default function FAC_Overview() {
  const [tab, setTab] = useState<"Overview" | "History" | "Preferences" | "Deloadings">("Overview");
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


  const navigate = useNavigate();

  // show only if: user is a chair AND they’re currently browsing as “faculty”
  const canReturnToChair = userIsChair() && getActiveRole() === "faculty";

  useEffect(() => {
  if (userIsChair() && !getActiveRole()) {
        setActiveRole("faculty");
      }
    }, []);


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

  const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = raw.userId || raw.user_id || raw.id;

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

    const teachingLoadNormalized = (list?.teaching_load || []).map((x: any) => ({
      ...x,
      // normalize section_id no matter what the backend sends
      section_id:
        x.section_id ||
        x.sectionId ||
        x.section?.section_id ||
        x.section?.id ||
        "",
    }));

    // Compose into the same shape the page already renders
    setData({
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
    });
    setError(null);
  } catch (e: any) {
    setError(e?.response?.data?.detail || e?.message || "Failed to load faculty overview.");
  }
}, [userId]);

useEffect(() => {
  loadOverview();
}, [loadOverview]);


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



      {/* Hide Overview/History/Preferences when Inbox is open */}
      {!showInbox && (
        <Tabs
          mode="state"
          activeTab={tab}
          onTabChange={(newTab) => setTab(newTab as typeof tab)}
          items={[{ label: "Overview" }, { label: "History" }, { label: "Preferences" }, { label: "Deloadings" }]}
        />
      )}

      <main className="w-full p-6 pb-24"> 
        {/* If Inbox was requested via the TopBar icon, render it "like a tab" */}
        {showInbox ? (
          <InboxContent />
        ) : (
          <>
            {tab === "Overview" && (
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
            {tab === "History" && <HistoryMain />}
            {tab === "Preferences" && <PreferencesContent />}
            {tab === "Deloadings" && <DeloadingsContent />}
          </>
        )}
      </main>
    </div>
  );
}
/* =========================================
   1) Stat Cards (MODIFIED)
   ========================================= */
function StatCards({ summary }: { summary: any }) {
  // --- *** FIX: Calculate progress for Course Prep *** ---
  const prepValue = summary?.course_preps ?? "0/0";
  const [prepCurrent, prepMax] = prepValue.split('/').map(Number);
  // Handle division by zero if max preps is 0
  const prepProgress = (prepMax > 0) ? Math.round((prepCurrent / prepMax) * 100) : 0;

  const cards = [
    { title: "Teaching Units", value: summary?.teaching_units ?? "0/0", progress: summary?.percent ?? 0 },
    { title: "Course Prep", value: prepValue, progress: prepProgress }, // <-- Use calculated progress
  ];

  return (
    <div className="mx-auto grid w-full max-w-screen-2xl grid-cols-1 gap-3 px-4 sm:grid-cols-2">
      {cards.map(({ title, value, progress }) => (
        <div
          key={title}
          className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm hover:shadow-md transition"
        >
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold tracking-tight">{value}</div>
            <div className="text-[13px] text-neutral-700">{title}</div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-600">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full bg-emerald-700 transition-all"
              style={{ width: `${progress}%` }}
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
type TLItem = {
  section_id: string;
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
  // Store original item for modal
  originalItem: TLItem;
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
          room: room || "Online",
          time: time,
          syllabus: it.syllabus,
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

const ClassBlock = ({ onClick, it }: { onClick?: () => void; it: TLItemForCalendar }) => (
  <button
    onClick={onClick}
    className={cls(
      "flex w-full flex-col items-center justify-center rounded-xl border shadow-sm",
      "border-emerald-200 bg-emerald-50/90 hover:bg-emerald-50"
    )}
    title={`${it.code} • ${it.sec} | ${it.room} • ${it.mode}`}
  >
    <div className="text-[13px] font-extrabold tracking-wide">{it.code}</div>
    <div className="text-[12px]">{it.sec} | {it.room}</div>
    {/* Removed mode display here as requested */}
  </button>
);

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
  "Day 1",
  "Begin 1",
  "End 1",
  "Room 1",
  "Day 2",
  "Begin 2",
  "End 2",
  "Room 2",
  "Mode",
  "Syllabus",
];

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
  const [view, setView] = useState<"Calendar" | "List">("Calendar");
  const [modal, setModal] = useState<{ day: DayLong; item: TLItemForCalendar } | null>(null);
  const [isAccepted, setIsAccepted] = useState(false);

  // Schedule is finalized once: Faculty accepted OR OM approved/rejected an RFC.
const scheduleFinal = Boolean(
  workflow?.schedule_final ||
    workflow?.proposal_status?.toString?.().toLowerCase?.() === "approved" ||
    workflow?.proposal_status?.toString?.().toLowerCase?.() === "accepted" ||
    (workflow?.rfc?.status &&
      ["ACCEPTED", "APPROVED", "REJECTED"].includes(String(workflow.rfc.status).toUpperCase()))
);


const scheduleFinalLabel = (() => {
  const st = String(workflow?.rfc?.status || "").toUpperCase();
  if (st === "REJECTED") return "Finalized (RFC Rejected)";
  if (st === "APPROVED") return "Finalized (RFC Approved)";
  if (st === "ACCEPTED") return "Finalized (Accepted)";

  const ps = String(workflow?.proposal_status || "").toLowerCase();
  if (ps === "approved") return "Finalized (Approved)";
  if (ps === "accepted") return "Finalized (Accepted)";
  return "Finalized";
})();


  // --- *** MODIFIED: Remove TLData, pass teachingLoad to placeItems *** ---
  const placed = useMemo(() => placeItems(teachingLoad || []), [teachingLoad]);
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

  const hasTBA = teachingLoad.some(item => item.day1 === 'TBA' || item.time1 === 'TBA');

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-neutral-900">Teaching Load Summary</h3>
            <p className="text-sm text-neutral-500">{term?.term_label || ""}</p>
          </div>
          <div className="flex gap-2">
          {["Calendar", "List"].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v as any)}
              className={cls(
                "inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium shadow",
                view === v
                  ? "bg-emerald-700 text-white shadow-inner"
                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 active:translate-y-[0.5px]"
              )}
            >
              {v}
            </button>
          ))}

          <button
            type="button"
            onClick={async () => {
            try {
              const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
              const userId = raw.userId || raw.user_id || raw.id || "";

              const termId = (term as any)?.term_id || (term as any)?._id || (term as any)?.id;

              // 1) Accept proposal in backend
              await acceptFacultyLoadAssignment(userId, { term_id: termId });

              // 2) Create Google Calendar events using items already computed for calendar view
              const itemsForGcal = (placed || []).map((p) => ({
                day: p.day, // "Monday".."Saturday"
                code: p.data.code,
                title: p.data.title,
                section: p.data.sec,
                mode: p.data.mode,
                room: p.data.room,
                time: p.data.time, // "7:30 – 9:00"
              }));

              // remove duplicates (same course/day/time/room)
              const seen = new Set<string>();
              const uniqueItems = itemsForGcal.filter((x) => {
                const key = `${x.code}|${x.section}|${x.day}|${x.time}|${x.room}|${x.mode}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });

              if (uniqueItems.length > 0) {
              try {
                // include userId in body too (works even if backend expects it in body)
                const resp = await acceptTeachingLoadToGcal(userId, { userId, items: uniqueItems, weeks: 5 });
                console.log("GCAL insert resp:", resp);
              } catch (e: any) {
                const msg =
                  e?.response?.data?.detail ||
                  e?.message ||
                  "Calendar insert failed. Check backend logs.";
                onToast?.("error", msg, "Calendar insert failed");
                console.error("Accepted schedule, but calendar insert failed:", e);
                return; // ✅ do NOT reload; let user retry
              }
            } else {
              onToast?.("info", "No sched items to add to calendar (all TBA / missing day-time).", "Nothing to add");
              return;
            }

            setIsAccepted(true);
            onToast?.("success", "Schedule accepted and added to your Google Calendar.", "Success");
            await onRefresh?.();

            } catch (e: any) {
              const msg =
                e?.response?.data?.detail ||
                e?.message ||
                "Failed to accept schedule.";
              onToast?.("error", msg, "Action failed");
              console.error(e);
            }
          }}

            disabled={isAccepted}
            className={cls(
              "inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium shadow",
              "focus:outline-none focus:ring-2 focus:ring-emerald-600/40",
              (isAccepted || scheduleFinal)
                ? "bg-neutral-300 text-neutral-600 cursor-not-allowed"
                : "bg-blue-700 text-white hover:bg-blue-800 active:translate-y-[0.5px]"
            )}
          >
            {(isAccepted || scheduleFinal) ? "Finalized" : "Accept Schedule"}
          </button>
        </div>
      </div>

      {scheduleFinal && (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <span className="font-semibold">Schedule Locked:</span> {scheduleFinalLabel}. You can no longer submit RFCs.
        </div>
      )}

        {view === "Calendar" ? (
          <div className="overflow-x-auto">
            <div className="min-w-[860px] rounded-xl border border-neutral-300">
              <div className="grid grid-cols-[140px_repeat(6,1fr)] bg-emerald-800 text-white">
                <div className="flex items-center justify-center px-3 py-2 text-sm font-semibold">
                  Time
                </div>
                {/* --- MODIFIED: Do not render "TBA" column header --- */}
                {DAY_ORDER.filter(d => d !== "TBA").map((d) => (
                  <div
                    key={d}
                    className="flex items-center justify-center px-3 py-2 text-sm font-semibold"
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
                style={{ gridAutoRows: "minmax(84px, auto)" }}
              >
                {TIME_BANDS_LABEL.map((band, r) => (
                  <React.Fragment key={band}>
                    <div
                      className="flex items-center justify-center border-r border-neutral-300 bg-neutral-50 px-2 text-center text-[13px]"
                      style={{ gridColumn: 1, gridRow: r + 1 }}
                    >
                      {band}
                    </div>
                     {/* --- MODIFIED: Do not render "TBA" column cells --- */}
                    {DAY_ORDER.filter(d => d !== "TBA").map((_, c) => (
                      <div
                        key={`${c}-${r}`}
                        className="border border-neutral-300"
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
                          onClick={() => { if (scheduleFinal) return; setModal({ day: g.day, item: it }); }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
           // --- *** MODIFIED: New List View *** ---
          <div className="space-y-6">
            <div className="overflow-x-auto">
              <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
                <table className="w-full table-fixed text-[13px]">
                  <colgroup>
                    <col className="w-[240px]" />
                    <col className="w-[92px]" />
                    <col className="w-[82px]" />
                    <col className="w-[92px]" />
                    <col className="w-[92px]" />
                    <col className="w-[110px]" />
                    <col className="w-[82px]" />
                    <col className="w-[92px]" />
                    <col className="w-[92px]" />
                    <col className="w-[110px]" />
                    <col className="w-[96px]" />
                    <col className="w-[76px]" />
                  </colgroup>
                  <thead className="bg-gray-50 text-gray-700">
                    <tr className="[&>th]:border-b [&>th]:border-gray-200">
                      {LIST_HEADERS.map((h) => (
                        <th key={h} className="px-4 py-3 text-left font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-gray-900">
                    {teachingLoad.length === 0 ? (
                      <tr>
                        <td colSpan={LIST_HEADERS.length} className="px-4 py-6 text-center text-sm text-neutral-500">
                          No records.
                        </td>
                      </tr>
                    ) : (
                      teachingLoad.map((it, idx) => {
                        const t1 = splitBeginEnd(it.time1);
                        const t2 = splitBeginEnd(it.time2);
                        const d1 = it.day1 && it.day1 !== "TBA" ? it.day1 : "—";
                        const d2 = it.day2 && it.day2 !== "TBA" ? it.day2 : "—";

                        return (
                          <tr
                            key={idx}
                            className={cls("bg-white", "[&>td]:border-t [&>td]:border-gray-100")}
                          >
                            <td className="px-4 py-3 align-middle">
                              <div className="leading-tight">
                                <div className="font-semibold text-gray-900">{it.course_code || "—"}</div>
                                <div className="mt-0.5 text-[12px] text-gray-600">{it.course_title || "—"}</div>
                              </div>
                            </td>
                            <td className="px-4 py-3 align-middle">{it.section || "—"}</td>
                            <td className="px-4 py-3 align-middle">{d1}</td>
                            <td className="px-4 py-3 align-middle">{t1.begin}</td>
                            <td className="px-4 py-3 align-middle">{t1.end}</td>
                            <td className="px-4 py-3 align-middle">{it.room1 || "—"}</td>
                            <td className="px-4 py-3 align-middle">{d2}</td>
                            <td className="px-4 py-3 align-middle">{t2.begin}</td>
                            <td className="px-4 py-3 align-middle">{t2.end}</td>
                            <td className="px-4 py-3 align-middle">{it.room2 || "—"}</td>
                            <td className="px-4 py-3 align-middle text-gray-800">{it.mode || "—"}</td>
                            <td className="px-4 py-3 align-middle">
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
        )}
      </div>

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

      <ChangeRequestModal open={!!modal} onClose={() => setModal(null)} context={modal} term={term} scheduleFinal={scheduleFinal} onToast={onToast} onRefresh={onRefresh} />
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
  onToast,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  context: { day: DayLong; item: TLItemForCalendar } | null; // <-- MODIFIED
  term: any;
  scheduleFinal: boolean;
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
    }
  }, [open]);

  if (!open || !context) return null;

  const toggle = (label: ChangeKind) =>
    setChoices((prev) => (prev.includes(label) ? prev.filter((c) => c !== label) : [...prev, label]));

  // Helpers to exclude the *current* slot and day
  const extractStartHM = (band: string) => band.split("–")[0].match(/\d{1,2}:\d{2}/)?.[0] ?? "";
  const toMinutes = (hm: string) => {
    if (!hm) return -1;
    const [h, m] = hm.split(":").map(Number);
    return h * 60 + m;
  };
  const oi = context.item.originalItem;
  const hasSecond = Boolean(
    (oi?.day2 && String(oi.day2).trim() && String(oi.day2).trim() !== "TBA") ||
      (oi?.time2 && String(oi.time2).trim() && String(oi.time2).trim() !== "TBA")
  );

  const currentDay1 = normalizeDay(oi?.day1) || "TBA";
  const currentDay2 = normalizeDay(oi?.day2) || "TBA";
  const currentStartMin1 = toMinutes(extractStartHM(String(oi?.time1 || "")));
  const currentStartMin2 = toMinutes(extractStartHM(String(oi?.time2 || "")));

  const filteredTimeSlots1 = TIME_SLOTS.filter(
    (band) => toMinutes(extractStartHM(band)) !== currentStartMin1
  );
  const filteredTimeSlots2 = TIME_SLOTS.filter(
    (band) => toMinutes(extractStartHM(band)) !== currentStartMin2
  );
  const filteredDays1 = ALL_DAYS.filter((d) => d !== currentDay1);
  const filteredDays2 = ALL_DAYS.filter((d) => d !== currentDay2);

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
    (panel === "request" && choices.length > 0 && !remarks.trim());

  return (
    <div className="fixed inset-0 z-80 grid place-items-center bg-black/30 p-3">
	    <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl max-h-[90vh] flex flex-col overflow-hidden">
	      {/* Header */}
	      <div className="border-b border-neutral-200 p-5 sm:p-6">
	        <div className="flex items-start justify-between gap-4">
	          <div className="min-w-0">
	            <h3 className="text-xl font-semibold text-emerald-700">Request for Change (RFC)</h3>
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
	         
	        </div>
	      </div>

	      {/* Body (scrollable) */}
	      <div className="flex-1 min-h-0 overflow-y-auto p-5 sm:p-6">
	        {panel === "conversation" ? (
	          <RfcThreadView
	            term={term}
	            sectionId={
	              (context.item.originalItem as any)?.section_id ||
	              (context.item.originalItem as any)?.sectionId ||
	              ""
	            }
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
	              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
	                <div className="rounded-xl border border-neutral-200 bg-white p-3">
	                  <div className="text-xs font-semibold text-neutral-600">Meeting 1</div>
	                  <div className="mt-1 text-sm text-neutral-800">
	                    <span className="font-medium">{oi?.day1 || "TBA"}</span>
	                    <span className="mx-2 text-neutral-300">•</span>
	                    <span>{oi?.time1 || "TBA"}</span>
	                  </div>
	                  <div className="mt-0.5 text-sm text-neutral-600">Room: {oi?.room1 || "—"}</div>
	                </div>
	                <div className="rounded-xl border border-neutral-200 bg-white p-3">
	                  <div className="text-xs font-semibold text-neutral-600">Meeting 2</div>
	                  {hasSecond ? (
	                    <>
	                      <div className="mt-1 text-sm text-neutral-800">
	                        <span className="font-medium">{oi?.day2 || "TBA"}</span>
	                        <span className="mx-2 text-neutral-300">•</span>
	                        <span>{oi?.time2 || "TBA"}</span>
	                      </div>
	                      <div className="mt-0.5 text-sm text-neutral-600">Room: {oi?.room2 || "—"}</div>
	                    </>
	                  ) : (
	                    <div className="mt-1 text-sm text-neutral-500">No second meeting</div>
	                  )}
	                </div>
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
	                <div className="text-sm font-semibold text-neutral-800">3) Add remarks <span className="text-red-500">*</span></div>
	                <div className="mt-0.5 text-sm text-neutral-500">Include brief context so OM can review faster.</div>
	                <textarea
	                  rows={4}
	                  className="mt-3 w-full resize-y rounded-xl border border-neutral-300 p-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-600/20"
	                  placeholder="Provide context for this request…"
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

	      {/* Footer (always visible) */}
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

              const oiAny: any = (context?.item?.originalItem ?? context?.item ?? {});
              const sectionId =
                oiAny.section_id ||
                oiAny.id ||
                oiAny.sectionId ||
                oiAny.section?.section_id ||
                oiAny.section?.id ||
                "";

              if (!sectionId) {
                console.error("RFC send blocked: missing section_id on row", oiAny);
                onToast?.("error", "Cannot send RFC: missing section_id for this assigned course row.", "RFC not sent");
                return;
              }

              const resp = await sendFacultyLoadAssignmentRfcMessage(userId, {
                term_id: (term as any)?.term_id || (term as any)?._id || (term as any)?.id,
                section_id: sectionId,
                message: msg,
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
      </div>
    </div>
  );
}

function RfcThreadView({ term, sectionId }: { term: any; sectionId: string }) {
  const [thread, setThread] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  const formatRfcStatus = useCallback(
    (rawStatus: string, isLocked: boolean) => {
      const key = String(rawStatus || "").toUpperCase();

      // Friendly, professional labels (avoid code-like statuses)
      const map: Record<string, string> = {
        OPEN: "Open",
        IN_PROGRESS: "In Progress",
        PENDING: "Pending",
        NEEDS_OM: "Pending OM Review",
        NEEDS_CHAIR: "Pending Chair Review",
        NEEDS_FACULTY: "Awaiting Faculty Response",
        APPROVED: "Approved",
        ACCEPTED: "Accepted",
        REJECTED: "Rejected",
        CLOSED: "Closed",
        LOCKED: "Closed",
      };

      if (map[key]) return map[key];
      if (isLocked) return "Closed";

      // Fallback: Title Case (e.g., NEEDS_OM -> Needs Om)
      return key
        ? key
            .toLowerCase()
            .split(/[_\s]+/)
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ")
        : "Open";
    },
    []
  );

  const statusTone = useCallback((rawStatus: string, isLocked: boolean) => {
    const key = String(rawStatus || "").toUpperCase();
    if (isLocked) return "bg-neutral-200 text-neutral-700";
    if (key === "NEEDS_OM" || key === "NEEDS_CHAIR" || key === "PENDING") {
      return "bg-yellow-100 text-yellow-800";
    }
    if (key === "REJECTED") return "bg-red-100 text-red-800";
    return "bg-emerald-100 text-emerald-800";
  }, []);

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

  if (loading && !thread) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
        Loading RFC thread…
      </div>
    );
  }

  const msgs = thread?.messages || thread?.thread || [];
  if (!thread || !Array.isArray(msgs) || msgs.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
        No RFC thread yet. You may send a request below.
      </div>
    );
  }

  const status = String(thread.status || "").toUpperCase();
  const locked = Boolean(thread.locked) || ["ACCEPTED", "APPROVED", "REJECTED"].includes(status);
  const statusLabel = formatRfcStatus(status, locked);

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-neutral-800">RFC Conversation</div>
        <div
          className={cls(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            statusTone(status, locked)
          )}
        >
          {statusLabel}
        </div>
      </div>

      <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg bg-neutral-50 p-2">
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
    </div>
  );
}
