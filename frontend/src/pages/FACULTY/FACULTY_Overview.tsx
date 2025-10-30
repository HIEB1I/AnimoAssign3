// frontend/src/pages/FACULTY/FAC_Overview.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Send as SendIcon,
  Calendar as CalIcon,
  X,
} from "lucide-react";

import { getFacultyOverviewList, getFacultyOverviewProfile } from "../../api";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import HistoryMain from "./FACULTY_History";
import PreferencesContent from "./FACULTY_Preferences";
import { InboxContent } from "./FACULTY_Inbox";

/* =========================================
   0) Page
   ========================================= */
export default function FAC_Overview() {
  const [tab, setTab] = useState<"Overview" | "History" | "Preferences">("Overview");
  const [showInbox, setShowInbox] = useState(false); // NEW
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

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

      {/* Hide Overview/History/Preferences when Inbox is open */}
      {!showInbox && (
        <Tabs
          mode="state"
          activeTab={tab}
          onTabChange={(newTab) => setTab(newTab as typeof tab)}
          items={[{ label: "Overview" }, { label: "History" }, { label: "Preferences" }]}
        />
      )}

      <main className="w-full p-6">
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
          </>
        )}
      </main>
    </div>
  );
}
/* =========================================
   1) Stat Cards (unchanged)
   ========================================= */
function StatCards({ summary }: { summary: any }) {
  const cards = [
    { title: "Teaching Units", value: summary?.teaching_units ?? "0/0", progress: summary?.percent ?? 0 },
    { title: "Course Prep", value: summary?.course_preps ?? "0/0", progress: 100 },
    { title: "Load Status", value: summary?.load_status ?? "Pending", progress: 100 },
  ];

  return (
    <div className="mx-auto grid w-full max-w-screen-2xl grid-cols-1 gap-3 px-4 sm:grid-cols-3">
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

type DayLong =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday";

const DAY_ORDER: DayLong[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type TLItem = {
  code: string;
  title: string;
  sec: string;
  units: number;
  campus: string;
  mode: "Online" | "Onsite" | "Hybrid" | "Classroom" | string;
  room: string | "Online";
  time: string; // e.g., "11:00 – 12:30"
};

type TL = { day: DayLong; items: TLItem[] };

function makeTeachingLoad(dataArray: any[]): TL[] {
  const byDay: Record<DayLong, TLItem[]> = {
    Monday: [],
    Tuesday: [],
    Wednesday: [],
    Thursday: [],
    Friday: [],
    Saturday: [],
  };

  (dataArray || []).forEach((c: any) => {
    const day = (c.day || "") as DayLong;
    if (!DAY_ORDER.includes(day)) return;

    byDay[day].push({
      code: c.course_code ?? "",
      title: c.course_title ?? "",
      sec: c.section ?? "",
      units: Number(c.units) || 0,
      campus: c.campus || "—",
      mode: c.mode || "Online",
      room: c.room || "Online",
      time: c.time || "",
    });
  });

  return DAY_ORDER.map((d) => ({ day: d, items: byDay[d] }));
}

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

type Placed = { day: DayLong; row: number; data: TLItem };

function placeItems(data: TL[]): Placed[] {
  const out: Placed[] = [];
  data.forEach((d) =>
    d.items.forEach((it) => {
      const start = String(it.time || "").split("–")[0].trim(); // "11:00"
      const idx = BANDS_STARTS.findIndex((b) => start.includes(b));
      out.push({ day: d.day, row: Math.max(0, idx), data: it });
    })
  );
  return out;
}

type CellGroup = { day: DayLong; row: number; items: TLItem[] };
function groupPlacedByCell(placed: Placed[]): CellGroup[] {
  const map = new Map<string, CellGroup>();
  for (const p of placed) {
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

const ClassBlock = ({ onClick, it }: { onClick?: () => void; it: TLItem }) => (
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
  teachingLoad: any[];
  term: any;
};

function TeachingLoadEnhanced({ teachingLoad, term }: TeachingLoadEnhancedProps) {
  const [view, setView] = useState<"Calendar" | "List">("Calendar");
  const [modal, setModal] = useState<{ day: DayLong; item: TLItem } | null>(null);

  const TLData = useMemo(() => makeTeachingLoad(teachingLoad || []), [teachingLoad]);
  const placed = useMemo(() => placeItems(TLData), [TLData]);
  const groups = useMemo(() => groupPlacedByCell(placed), [placed]);

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-neutral-900">Teaching Load Summary</h3>
            <p className="text-sm text-neutral-500">{term?.term_label || ""}</p>
          </div>
          <div className="inline-flex gap-2">
            {(["Calendar", "List"] as const).map((label) => {
              const active = view === label;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setView(label)}
                  aria-pressed={active}
                  className={cls(
                    "inline-flex h-9 min-w-[120px] items-center justify-center rounded-lg px-4 text-sm font-medium",
                    active
                      ? "bg-emerald-600 text-white"
                      : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {view === "Calendar" ? (
          <div className="overflow-x-auto">
            <div className="min-w-[860px] rounded-xl border border-neutral-300">
              <div className="grid grid-cols-[140px_repeat(6,1fr)] bg-emerald-800 text-white">
                <div className="flex items-center justify-center px-3 py-2 text-sm font-semibold">
                  Time
                </div>
                {DAY_ORDER.map((d) => (
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
                    {DAY_ORDER.map((_, c) => (
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
          <div className="space-y-6">
            {TLData.map((day) => (
              <div key={day.day}>
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                  <CalIcon className="h-4 w-4" /> {day.day}
                </div>
                <div className="overflow-x-auto rounded-xl border border-neutral-200">
                  <table className="min-w-full">
                    <thead>
                      <tr className="text-xs text-neutral-500">
                        {[
                          "Course Code",
                          "Course Title",
                          "Section",
                          "Units",
                          "Campus",
                          "Mode",
                          "Day",
                          "Room",
                          "Time",
                        ].map((h) => (
                          <th key={h} className="px-4 py-2 font-medium text-center">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {day.items.length === 0 ? (
                        <tr>
                          <td
                            colSpan={9}
                            className="px-4 py-6 text-center text-sm text-neutral-500"
                          >
                            No records.
                          </td>
                        </tr>
                      ) : (
                        day.items.map((it, idx) => (
                          <tr
                            key={idx}
                            className={cls(
                              "text-sm text-neutral-800",
                              idx % 2 === 0 ? "bg-white" : "bg-neutral-50"
                            )}
                          >
                            <td className="px-4 py-2 text-center">{it.code}</td>
                            <td className="px-4 py-2 text-center">{it.title}</td>
                            <td className="px-4 py-2 text-center">{it.sec}</td>
                            <td className="px-4 py-2 text-center">{it.units}</td>
                            <td className="px-4 py-2 text-center">{it.campus}</td>
                            <td className="px-4 py-2 text-center">{it.mode}</td>
                            <td className="px-4 py-2 text-center">
                              {day.day[0]}
                            </td>
                            <td className="px-4 py-2 text-center">{it.room}</td>
                            <td className="px-4 py-2 text-center">{it.time}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ChangeRequestModal open={!!modal} onClose={() => setModal(null)} context={modal} />
    </section>
  );
}

/* =========================================
   3) Change Request Modal (UI-only)
      — mirrors the older file’s UX, no backend change
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
  context: { day: DayLong; item: TLItem } | null;
}) {
  const TIME_SLOTS = [
    "7:30 – 9:00 AM",
    "9:15 – 10:45 AM",
    "11:00 – 12:30 PM",
    "12:30 – 2:15 PM",
    "2:30 – 4:00 PM",
    "4:15 – 5:45 PM",
    "6:00 – 7:30 PM",
    "7:45 – 9:00 PM",
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
