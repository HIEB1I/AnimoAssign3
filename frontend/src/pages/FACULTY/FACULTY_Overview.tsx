// frontend/src/pages/FACULTY/FAC_Overview.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Send as SendIcon, X, BookOpen as SyllabusIcon } from "lucide-react";

import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import HistoryMain from "./FACULTY_History";
import PreferencesContent from "./FACULTY_Preferences";
import DeloadingsContent from "./FACULTY_Deloadings";
import { InboxContent } from "./FACULTY_Inbox";

import {
  getFacultyOverviewList,
  getFacultyOverviewProfile,
  getActiveRole,
  setActiveRole,
  userIsChair,
} from "../../api";
import { useNavigate } from "react-router-dom";


/* =========================================
   0) Page
   ========================================= */
export default function FAC_Overview() {
  const [tab, setTab] = useState<"Overview" | "History" | "Preferences" | "Deloadings">("Overview");
  const [showInbox, setShowInbox] = useState(false); // NEW
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!userId) {
      setError("Missing userId in local storage.");
      return;
    }
    (async () => {
      try {
        // Parallel loads (pattern parity with Student Petition)
        const [list, profile] = await Promise.all([
          getFacultyOverviewList(userId),
          getFacultyOverviewProfile(userId),
          // getFacultyOverviewOptions(userId) // not needed by this page; stub is available
        ]);

        if (!list?.ok) throw new Error(list?.detail || "Failed to load list.");
        if (!profile?.ok) throw new Error(profile?.detail || "Failed to load profile.");

        // Compose into the same shape the page already renders
        setData({
          ok: true,
          faculty: profile.faculty,
          term: list.term,
          summary: list.summary,
          teaching_load: list.teaching_load,
          notifications: profile.notifications || [],
        });
      } catch (e: any) {
        setError(e?.response?.data?.detail || e?.message || "Failed to load faculty overview.");
      }
    })();
  }, [userId]);


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
                <TeachingLoadEnhanced teachingLoad={data.teaching_load} term={data.term} />
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

// --- *** NEW: This type matches the backend (Python) output *** ---
type TLItem = {
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
      if (!day || day === "TBA" || !time || time === "TBA" || !DAY_ORDER.includes(day as DayLong)) {
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
        day: day as DayLong,
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
    <div className="text-[12px]">{it.mode}</div>
  </button>
);

type TeachingLoadEnhancedProps = {
  teachingLoad: TLItem[]; // <-- Use the new type
  term: any;
};

// --- *** NEW: Headers for the new list view *** ---
const LIST_HEADERS = [
  "Course Code",
  "Course Title",
  "Section",
  "Units",
  "Mode",
  "Day1 / Day2",
  "Room1 / Room2",
  "Time1 / Time2",
  "Syllabus",
];

function TeachingLoadEnhanced({ teachingLoad, term }: TeachingLoadEnhancedProps) {
  const [view, setView] = useState<"Calendar" | "List">("Calendar");
  const [modal, setModal] = useState<{ day: DayLong; item: TLItemForCalendar } | null>(null);
  const [isAccepted, setIsAccepted] = useState(false);

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
            onClick={() => {
              console.log("ACCEPT_SCHEDULE");
              setIsAccepted(true);
              // You would also call an API endpoint here
            }}
            disabled={isAccepted}
            className={cls(
              "inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium shadow",
              "focus:outline-none focus:ring-2 focus:ring-emerald-600/40",
              isAccepted
                ? "bg-neutral-300 text-neutral-600 cursor-not-allowed"
                : "bg-blue-700 text-white hover:bg-blue-800 active:translate-y-[0.5px]"
            )}
          >
            {isAccepted ? "Accepted" : "Accept"}
          </button>
        </div>
      </div>

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
                          onClick={() => setModal({ day: g.day, item: it })}
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
            <div className="overflow-x-auto rounded-xl border border-neutral-200">
              <table className="min-w-full">
                <thead>
                  <tr className="text-xs text-neutral-500">
                    {LIST_HEADERS.map((h) => (
                      <th key={h} className="px-4 py-2 font-medium text-center">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teachingLoad.length === 0 ? (
                    <tr>
                      <td
                        colSpan={LIST_HEADERS.length}
                        className="px-4 py-6 text-center text-sm text-neutral-500"
                      >
                        No records.
                      </td>
                    </tr>
                  ) : (
                    teachingLoad.map((it, idx) => (
                      <tr
                      key={idx}
                      className={cls(
                        "text-sm text-neutral-800",
                        idx % 2 === 0 ? "bg-white" : "bg-neutral-50"
                      )}
                    >
                      <td className="px-4 py-2 text-center">{it.course_code}</td>
                      <td className="px-4 py-2 text-center">{it.course_title}</td>
                      <td className="px-4 py-2 text-center">{it.section}</td>
                      <td className="px-4 py-2 text-center">{it.units}</td>
                      <td className="px-4 py-2 text-center">{it.mode}</td>
                      <td className="px-4 py-2 text-center">
                        {it.day1 && it.day1 !== "TBA" ? it.day1 : '—'}
                        {it.day2 && it.day2 !== "TBA" && ` / ${it.day2}`}
                      </td>
                      <td className="px-4 py-2 text-center">
                         {it.room1 || '—'}
                        {it.room2 && ` / ${it.room2}`}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {it.time1 && it.time1 !== "TBA" ? it.time1 : '—'}
                        {it.time2 && it.time2 !== "TBA" && ` / ${it.time2}`}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => openSyllabus(it)}
                          className={cls(
                            "inline-flex items-center justify-center rounded-md border px-2 py-1 text-xs",
                            "border-emerald-200 bg-emerald-50 hover:bg-emerald-100 active:translate-y-[0.5px]",
                            // --- *** FIX 3: Allow clicking even if no syllabus *** ---
                            !it.syllabus && "opacity-60" 
                          )}
                          title={it.syllabus ? "View syllabus" : "No syllabus uploaded"}
                          aria-label="View syllabus"
                        >
                          <SyllabusIcon className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                    ))
                  )}
                </tbody>
              </table>
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

      <ChangeRequestModal open={!!modal} onClose={() => setModal(null)} context={modal} />
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
}: {
  open: boolean;
  onClose: () => void;
  context: { day: DayLong; item: TLItemForCalendar } | null; // <-- MODIFIED
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
  const [selTime, setSelTime] = useState("");
  const [selDay, setSelDay] = useState<DayLong | "">("");
  const [remarks, setRemarks] = useState("");
  const [otherText, setOtherText] = useState("");

  useEffect(() => {
    if (!open) {
      setChoices([]);
      setSelTime("");
      setSelDay("");
      setRemarks("");
      setOtherText("");
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
  const currentDay = context.day;
  const currentStartMin = toMinutes(extractStartHM(context.item.time));

  const filteredTimeSlots = TIME_SLOTS.filter(
    (band) => toMinutes(extractStartHM(band)) !== currentStartMin
  );
  const filteredDays = ALL_DAYS.filter((d) => d !== currentDay);

  const mustTime = choices.includes("Change class time");
  const mustDay = choices.includes("Change class day");
  const disabled = choices.length === 0 || (mustTime && !selTime) || (mustDay && !selDay);

  return (
    <div className="fixed inset-0 z-80 grid place-items-center bg-black/30 p-3">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-xl font-semibold text-emerald-700">Request for Change</h3>
            <p className="text-sm text-neutral-500">
              {/* --- MODIFIED: Use calendar item data --- */}
              {context.item.code} {context.item.sec} • {context.day} • {context.item.time}
            </p>
          </div>
          <button className="rounded-full p-1 hover:bg-neutral-100" onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block text-sm font-medium text-neutral-700">Change</label>
          <div className="flex flex-wrap gap-2">
            {(["Change class time", "Change class day", "Other"] as ChangeKind[]).map((opt) => (
              <button
                key={opt}
                onClick={() => toggle(opt)}
                className={cls(
                  "rounded-lg border px-3 py-2 text-sm",
                  choices.includes(opt)
                    ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                    : "border-neutral-300 bg-white hover:bg-neutral-50"
                )}
              >
                {opt}
              </button>
            ))}
          </div>

          {mustTime && (
            <div className="mt-2">
              <label className="mb-1 block text-sm font-medium text-neutral-700">New time slot</label>
              <Dropdown value={selTime} onChange={setSelTime} options={filteredTimeSlots} placeholder="— Select a time —" />
            </div>
          )}

          {mustDay && (
            <div className="mt-2">
              <label className="mb-1 block text-sm font-medium text-neutral-700">New class day</label>
              <Dropdown
                value={selDay}
                onChange={(v) => setSelDay(v as DayLong)}
                options={filteredDays}
                placeholder="— Select a day —"
              />
            </div>
          )}

          {choices.includes("Other") && (
            <div className="mt-2">
              <label className="mb-1 block text-sm font-medium text-neutral-700">Specify change</label>
              <input
                type="text"
                className="w-full rounded-lg border border-neutral-300 p-2 text-sm"
                placeholder="Type your custom change…"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
              />
            </div>
          )}

          {!!choices.length && (
            <div className="mt-2">
              <label className="mb-1 block text-sm font-medium text-neutral-700">Remarks</label>
              <textarea
                rows={4}
                className="w-full resize-y rounded-lg border border-neutral-300 p-2 text-sm"
                placeholder="Provide context for this request…"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
          >
            Cancel
          </button>
          <button
            disabled={disabled}
            onClick={() => {
              // Hook into your backend here if needed
              console.log("SUBMIT_CHANGE_REQUEST", { choices, selTime, selDay, remarks, otherText, context });
              onClose();
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