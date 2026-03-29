import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Search as SearchIcon, Edit, Check, ChevronDown, X, Download, MessageSquareText, Send, AlertTriangle, CalendarClock, Info, Plus, Trash2 } from "lucide-react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import { getSessionUserId } from "../../lib/session";
import {
  getOMSC_Options,
  listOMSC,
  updateOMSC,
  getOMSC_Detail,
  exportOMSC_Pdf,
  createOMSC,
  getOMSC_EligibleStudents,
  assignOMSCStudent,
  unassignOMSCStudent,
  deleteOMSCClass,
  getChairSCOptions,
  listChairSC,
  updateChairSC,
  getChairSC_Detail,
  exportChairSC_Pdf,
  createChairSC,
  getChairSC_EligibleStudents,
  assignChairSCStudent,
  unassignChairSCStudent,
  deleteChairSCClass,
  getOmLoadAssignmentRfc,
  respondOmLoadAssignmentRfc,
  downloadBlob,
  startOMSCWindow,
  type OMSpecialClassRow,
  type OMSpecialClassOptions,
  type OMSpecialClassDetail,
  type OMSpecialClassCandidate,
} from "../../api";

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
  emptyMessage,
}: {
  deadlineISO: string;
  className?: string;
  emptyMessage?: string;
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
              {emptyMessage || "Set a deadline above. Until then, students will not be able to submit requests for this term."}
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nextMinuteFrom(date = new Date()) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  return d;
}

/* ---------------- RFC Conversation Modal (Special Class) ---------------- */
function SpecialConversationModal({
  open,
  onClose,
  userId,
  termId,
  facultyId,
  facultyName,
  sectionId,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  termId: string;
  facultyId?: string | null;
  facultyName?: string;
  sectionId?: string;
  onToast?: (message: string, kind?: "success" | "error") => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [locked, setLocked] = useState<boolean>(false);
  const [reply, setReply] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setError(null);
      setMessages([]);
      setLocked(false);
      setReply("");
      return;
    }

    (async () => {
      try {
        setLoading(true);
        setError(null);
        setMessages([]);
        setLocked(false);

        if (!facultyId) {
          setError("No faculty assigned yet.");
          return;
        }
        if (!sectionId) {
          setError("Missing special class id.");
          return;
        }

        const res = await getOmLoadAssignmentRfc(userId, {
          term_id: termId,
          faculty_id: String(facultyId),
          section_id: sectionId,
        });

        if (!res?.ok || !res?.rfc) {
          setMessages([]);
          return;
        }

        const rfc = res.rfc;
        setLocked(Boolean(rfc.locked));
        setMessages(rfc.messages || rfc.thread || []);
      } catch (e: any) {
        setError(e?.message || "Failed to load conversation.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  if (!open) return null;

  const canReply = !loading && !locked && !!facultyId && !!sectionId;

  const sendReply = async () => {
    if (!canReply) return;
    if (!reply.trim()) {
      onToast?.("Please type a message.", "error");
      return;
    }
    try {
      setLoading(true);
      await respondOmLoadAssignmentRfc(userId, {
        term_id: termId,
        faculty_id: String(facultyId),
        section_id: sectionId,
        action: "reply",
        message: reply.trim(),
      });
      setReply("");
      const res = await getOmLoadAssignmentRfc(userId, {
        term_id: termId,
        faculty_id: String(facultyId),
        section_id: sectionId,
      });
      setMessages(res?.rfc?.messages || res?.rfc?.thread || []);
      onToast?.("Message sent.", "success");
    } catch (e: any) {
      onToast?.(e?.message || "Failed to send message.", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-4xl rounded-2xl bg-white shadow-2xl relative max-h-[92vh] flex flex-col overflow-hidden">
        <button
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 hover:bg-gray-100"
          onClick={onClose}
        >
          <X className="h-5 w-5 text-gray-500" />
        </button>

        <div className="p-6 pb-4">
          <h3 className="text-lg font-semibold text-purple-700 mb-2">Conversation</h3>
          <div className="text-sm text-gray-600">
            Faculty: <span className="font-semibold">{facultyName || "UNASSIGNED"}</span>
          </div>

          {loading && <div className="mt-3 text-sm text-gray-600">Loading…</div>}
          {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

          {!loading && !error && !messages.length && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              No messages yet. The faculty can start the conversation from the Special Class modal.
            </div>
          )}
        </div>

        <div
          ref={scrollRef}
          className="mx-6 mb-4 flex-1 min-h-0 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3"
        >
          {messages.length ? (
            <div className="space-y-2">
              {messages.map((m: any, idx: number) => {
                const whoRaw = (m.sender_role || m.from || "").toString();
                const who = whoRaw.toUpperCase();
                const ts = m.created_at ? new Date(m.created_at).toLocaleString() : "";
                const isFaculty = /FACULTY/i.test(whoRaw) || who === "F";
                const bubble = m.message || m.text || "";
                return (
                  <div key={idx} className={cls("flex", isFaculty ? "justify-start" : "justify-end")}>
                    <div className={cls("max-w-[85%]", isFaculty ? "text-left" : "text-right")}>
                      <div className={cls("mb-1 text-[11px] text-gray-500", isFaculty ? "pl-1" : "pr-1")}>
                        {who || (isFaculty ? (facultyName || "FACULTY").toUpperCase() : "OM")}
                        {ts ? ` • ${ts}` : ""}
                      </div>
                      <div
                        className={cls(
                          "inline-block rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                          isFaculty
                            ? "bg-white text-gray-800 border border-gray-200"
                            : "bg-purple-600 text-white"
                        )}
                      >
                        {bubble}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-gray-600">No messages yet.</div>
          )}
        </div>

        <div className="mx-6 pb-6">
          <label className="block text-sm font-medium mb-1">Reply</label>
          <div className="flex items-end gap-2">
            <textarea
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-purple-500/30"
              rows={3}
              placeholder={locked ? "Conversation is locked." : "Type your message…"}
              value={reply}
              disabled={!canReply}
              onChange={(e) => setReply(e.target.value)}
            />
            <button
              type="button"
              disabled={!canReply || !reply.trim()}
              onClick={() => void sendReply()}
              className={cls(
                "inline-flex h-10 w-10 items-center justify-center rounded-xl text-white shadow",
                "bg-purple-600 hover:brightness-[1.06] active:translate-y-[0.5px]",
                (!canReply || !reply.trim()) && "opacity-60 cursor-not-allowed"
              )}
              title="Send"
              aria-label="Send"
            >
              <Send className={cls("h-4 w-4", loading && "animate-pulse")} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- helpers --------------------------------- */
type DayCode = "M" | "T" | "W" | "H" | "F" | "S";

const DAY_LABELS: Record<DayCode, string> = {
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  H: "Thursday",
  F: "Friday",
  S: "Saturday",
};

const DAY_OPTS_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
type DayLabel = (typeof DAY_OPTS_LABELS)[number];

const DAY_FROM_LABEL: Record<DayLabel, DayCode> = {
  Monday: "M",
  Tuesday: "T",
  Wednesday: "W",
  Thursday: "H",
  Friday: "F",
  Saturday: "S",
};

const DAY_PAIR: Record<DayCode, DayCode> = {
  M: "H",
  H: "M",
  T: "F",
  F: "T",
  W: "S",
  S: "W",
};

type FacultyBusySlot = {
  section_id?: string;
  day: string;
  begin: string;
  end: string;
};

type FacultyAvailabilityMap = Record<string, FacultyBusySlot[]>;

const normalizeBusyDay = (value?: string): DayCode | "" => {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw.startsWith("TH") || raw === "H") return "H";
  const c = raw[0] as DayCode;
  return ["M", "T", "W", "H", "F", "S"].includes(c) ? c : "";
};

const timeToMinutes = (value?: string): number | null => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const hhmm = raw.includes(":") ? raw : raw.length === 4 ? `${raw.slice(0, 2)}:${raw.slice(2)}` : raw;
  const parts = hhmm.split(":");
  if (parts.length !== 2) return null;
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
};

const rangesOverlap = (beginA: number, endA: number, beginB: number, endB: number) =>
  beginA < endB && beginB < endA;

const getMeetingEnd = (begin?: string, fallback?: string) => {
  const b = String(begin || "").trim();
  if (!b) return String(fallback || "").trim();
  const found = GE_TIME_SLOTS.find((slot) => slot.start === b);
  return found?.end || String(fallback || "").trim();
};

const buildMeetingSlots = (edit: {
  day1?: string;
  begin1?: string;
  end1?: string;
  day2?: string;
  begin2?: string;
  end2?: string;
}) => {
  const meetings: Array<{ slot: 1 | 2; day: DayCode; begin: string; end: string; beginMinutes: number; endMinutes: number }> = [];
  ([1, 2] as const).forEach((slot) => {
    const day = normalizeBusyDay(edit[`day${slot}` as const]) as DayCode | "";
    const begin = String(edit[`begin${slot}` as const] || "").trim();
    const end = getMeetingEnd(begin, String(edit[`end${slot}` as const] || "").trim());
    const b = timeToMinutes(begin);
    const e = timeToMinutes(end);
    if (!day || b == null || e == null || e <= b) return;
    meetings.push({ slot, day, begin, end, beginMinutes: b, endMinutes: e });
  });
  return meetings;
};

const facultyHasConflictForMeetings = ({
  facultyId,
  meetings,
  busySlots,
  excludeSectionId,
}: {
  facultyId?: string | null;
  meetings: ReturnType<typeof buildMeetingSlots>;
  busySlots: FacultyAvailabilityMap;
  excludeSectionId?: string;
}) => {
  const fid = String(facultyId || "").trim();
  if (!fid || meetings.length === 0) return false;
  const excluded = String(excludeSectionId || "").trim();
  return (busySlots[fid] || []).some((slot) => {
    if (excluded && String(slot.section_id || "").trim() === excluded) return false;
    const day = normalizeBusyDay(slot.day);
    const begin = timeToMinutes(slot.begin);
    const end = timeToMinutes(slot.end);
    if (!day || begin == null || end == null || end <= begin) return false;
    return meetings.some((meeting) => meeting.day === day && rangesOverlap(meeting.beginMinutes, meeting.endMinutes, begin, end));
  });
};

const slotOptionIsAvailable = ({
  facultyId,
  day,
  begin,
  peerMeetings,
  busySlots,
  excludeSectionId,
}: {
  facultyId?: string | null;
  day?: string;
  begin?: string;
  peerMeetings: ReturnType<typeof buildMeetingSlots>;
  busySlots: FacultyAvailabilityMap;
  excludeSectionId?: string;
}) => {
  const normDay = normalizeBusyDay(day);
  const cleanBegin = String(begin || "").trim();
  const end = getMeetingEnd(cleanBegin, "");
  const beginMinutes = timeToMinutes(cleanBegin);
  const endMinutes = timeToMinutes(end);
  if (!normDay || beginMinutes == null || endMinutes == null || endMinutes <= beginMinutes) return true;
  return !facultyHasConflictForMeetings({
    facultyId,
    meetings: [
      ...peerMeetings,
      { slot: 1, day: normDay as DayCode, begin: cleanBegin, end, beginMinutes, endMinutes },
    ],
    busySlots,
    excludeSectionId,
  });
};

const GE_TIME_SLOTS = [
  { label: "07:30 - 09:00", start: "0730", end: "0900" },
  { label: "08:00 - 10:00", start: "0800", end: "1000" },
  { label: "09:00 - 12:00", start: "0900", end: "1200" },
  { label: "09:15 - 10:45", start: "0915", end: "1045" },
  { label: "09:15 - 12:30", start: "0915", end: "1230" },
  { label: "10:00 - 12:00", start: "1000", end: "1200" },
  { label: "10:00 - 13:00", start: "1000", end: "1300" },
  { label: "11:00 - 12:30", start: "1100", end: "1230" },
  { label: "11:00 - 13:00", start: "1100", end: "1300" },
  { label: "12:45 - 14:15", start: "1245", end: "1415" },
  { label: "13:00 - 15:00", start: "1300", end: "1500" },
  { label: "13:00 - 16:00", start: "1300", end: "1600" },
  { label: "13:15 - 14:15", start: "1315", end: "1415" },
  { label: "14:00 - 16:00", start: "1400", end: "1600" },
  { label: "14:30 - 16:00", start: "1430", end: "1600" },
  { label: "14:40 - 16:00", start: "1440", end: "1600" },
  { label: "15:30 - 17:30", start: "1530", end: "1730" },
  { label: "16:15 - 17:45", start: "1615", end: "1745" },
  { label: "18:00 - 19:30", start: "1800", end: "1930" },
  { label: "18:00 - 20:00", start: "1800", end: "2000" },
  { label: "18:00 - 21:00", start: "1800", end: "2100" },
  { label: "19:45 - 21:00", start: "1945", end: "2100" },
  { label: "19:45 - 21:15", start: "1945", end: "2115" },
];

function prettyHHMM(hhmm?: string) {
  const s = (hhmm || "").trim();
  if (!/^\d{4}$/.test(s)) return "";
  return `${s.slice(0, 2)}:${s.slice(2)}`;
}


type ScheduleSlotView = {
  key: string;
  day: string;
  time: string;
};

function buildScheduleSlotViews(r: Partial<OMSpecialClassRow>) {
  const slots: ScheduleSlotView[] = [];

  const addSlot = (slot: 1 | 2) => {
    const day = String(slot === 1 ? r.day1 || "" : r.day2 || "").trim();
    const beginRaw = String(slot === 1 ? r.begin1 || "" : r.begin2 || "").trim();
    const endRaw = String(slot === 1 ? r.end1 || "" : r.end2 || "").trim();
    const begin = prettyHHMM(beginRaw);
    const end = prettyHHMM(endRaw);
    const hasAnyValue = day || beginRaw || endRaw;

    if (!hasAnyValue) return;

    slots.push({
      key: `slot-${slot}`,
      day: day || "—",
      time: begin && end ? `${begin}–${end}` : "—",
    });
  };

  addSlot(1);
  addSlot(2);

  if (slots.length) return slots;

  return [
    {
      key: "slot-empty",
      day: "—",
      time: "—",
    },
  ];
}

function formatDate(dt?: string) {
  if (!dt) return "—";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return dt;
  return d.toLocaleString();
}

const DAY_PLACEHOLDER = "Select day…";

/** SelectBox-styled combo input (type + dropdown in ONE box) */
function ComboSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(value);

  useEffect(() => setLocal(value), [value]);

  const filtered = useMemo(() => {
    const t = (local || "").trim().toUpperCase();
    if (!t) return options;
    return options.filter((o) => o.toUpperCase().includes(t));
  }, [local, options]);

  return (
    <div className={cls("relative", disabled && "opacity-70")}>
      <div
        className={cls(
          "flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm",
          "focus-within:ring-2 focus-within:ring-emerald-500/30 focus-within:border-emerald-500 transition",
          disabled && "cursor-not-allowed bg-gray-100"
        )}
      >
        <input
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          disabled={disabled}
          className={cls("w-full outline-none bg-transparent", disabled && "cursor-not-allowed")}
          style={{ minWidth: "190px" }}
        />
        <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
      </div>

      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-full max-h-[calc(100vh-300px)] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="overflow-auto max-h-[300px]">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500">No matches</div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setLocal(opt);
                    onChange(opt);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                >
                  {opt}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_PILL: Record<string, string> = {
  Submitted: "bg-gray-100 text-gray-700",
  "Under Review": "bg-yellow-100 text-yellow-800",
  "Forwarded To Department": "bg-yellow-100 text-yellow-800",
  Approved: "bg-green-100 text-green-800",
  Rejected: "bg-red-100 text-red-800",
  "Convert to Regular Class": "bg-blue-100 text-blue-800",
  Mixed: "bg-slate-100 text-slate-700",
};
function pillClass(status?: string) {
  if (!status) return "bg-gray-100 text-gray-600";
  return STATUS_PILL[status] || "bg-gray-100 text-gray-600";
}

function DetailRow({ label, value }: { label: string; value: any }) {
  const shown =
    value === null || value === undefined || value === ""
      ? "—"
      : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : String(value);

  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 py-2 border-b border-gray-100">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-sm text-gray-800 whitespace-pre-wrap break-words">{shown}</div>
    </div>
  );
}



type SpecialClassGroupStudent = {
  special_id: string;
  student_name: string;
  student_number?: string | number;
  faculty_id?: string | null;
  faculty_name?: string;
  rfc_needs_om?: boolean;
  term_id: string;
  status?: string;
  course_id?: string;
};

type SpecialClassGroupRow = Partial<OMSpecialClassRow> & {
  group_key: string;
  primary_special_id: string;
  special_ids: string[];
  count: number;
  students: SpecialClassGroupStudent[];
};

function buildGroupedRows(input: OMSpecialClassRow[]): SpecialClassGroupRow[] {
  const groups = new Map<string, OMSpecialClassRow[]>();
  input.forEach((row) => {
    const sectionId = String(row.section_id || '').trim();
    const pendingAnchorId = String((row as any).pending_anchor_special_id || '').trim();
    const generated = Boolean(row.generated_from_class_retention);
    const manual = Boolean(row.manual_special_class);
    const courseId = String(row.course_id || '').trim();
    const key = sectionId
      ? `SEC:${sectionId}`
      : pendingAnchorId
      ? `PENDANCHOR:${pendingAnchorId}`
      : generated
      ? `RET:${String(row.retention_id || row.special_id || row.course_id || '').trim()}`
      : manual
      ? `MAN:${String(row.special_id || row.course_id || '').trim()}`
      : `PENDING:${courseId || String(row.special_id || '').trim()}`;
    if (!key) return;
    const arr = groups.get(key) || [];
    arr.push(row);
    groups.set(key, arr);
  });

  const uniq = (vals: Array<any>) => Array.from(new Set(vals.map((v) => String(v ?? '').trim()).filter(Boolean)));
  const preferredApprovedRow = (rows: OMSpecialClassRow[]) => rows.find((r) => String(r.status || '').trim() === 'Approved' && String(r.section_id || '').trim()) || rows.find((r) => String(r.section_id || '').trim()) || rows[0];
  const consensusText = (rows: OMSpecialClassRow[], pick: (r: OMSpecialClassRow) => any, mixedLabel = 'Multiple') => {
    const vals = uniq(rows.map(pick));
    if (vals.length <= 1) return vals[0] || '';
    const approvedValue = String(pick(preferredApprovedRow(rows)) ?? '').trim();
    if (approvedValue) return approvedValue;
    return mixedLabel;
  };
  const consensusNullable = (rows: OMSpecialClassRow[], pick: (r: OMSpecialClassRow) => any) => {
    const vals = uniq(rows.map(pick));
    if (vals.length <= 1) return vals[0] || null;
    const approvedValue = String(pick(preferredApprovedRow(rows)) ?? '').trim();
    return approvedValue || null;
  };
  const consensusSchedule = (rows: OMSpecialClassRow[], key: keyof OMSpecialClassRow) => {
    const vals = uniq(rows.map((r) => (r as any)[key]));
    if (vals.length <= 1) return vals[0] || '';
    return String((preferredApprovedRow(rows) as any)?.[key] || '').trim();
  };

  return Array.from(groups.entries())
    .map(([groupKey, items]) => {
      const rows = [...items].sort((a, b) => String(a.student_name || '').localeCompare(String(b.student_name || '')));
      const first = preferredApprovedRow(rows) || rows[0];
      const approvedRow = preferredApprovedRow(rows);
      const statuses = uniq(rows.map((r) => r.status));
      const status = statuses.length <= 1 ? (statuses[0] || '') : (String(approvedRow?.status || '').trim() || 'Mixed');
      const remarks = consensusText(rows, (r) => r.remarks, '');
      const facultyId = consensusNullable(rows, (r) => r.faculty_id) as string | null;
      const applicantRows = rows.filter((r) => !r.generated_from_class_retention && !r.manual_special_class && !!String(r.user_id || '').trim());
      return {
        ...first,
        group_key: groupKey,
        primary_special_id: String(first.special_id || ''),
        special_ids: rows.map((r) => String(r.special_id || '')).filter(Boolean),
        count: applicantRows.length,
        students: applicantRows.map((r) => ({
          special_id: String(r.special_id || ''),
          student_name: String(r.student_name || ''),
          student_number: r.student_number,
          faculty_id: r.faculty_id ?? null,
          faculty_name: r.faculty_name,
          rfc_needs_om: Boolean((r as any).rfc_needs_om),
          term_id: String(r.term_id || ''),
          status: r.status,
          course_id: String(r.course_id || ''),
        })),
        status,
        remarks,
        faculty_id: facultyId,
        faculty_name: facultyId ? consensusText(rows, (r) => r.faculty_name, 'Multiple') : (consensusText(rows, (r) => r.faculty_name, '') || 'UNASSIGNED'),
        section_id: consensusNullable(rows, (r) => r.section_id) as string | null,
        section_code: consensusText(rows, (r) => r.section_code, 'Multiple'),
        day1: consensusSchedule(rows, 'day1') as any,
        begin1: consensusSchedule(rows, 'begin1'),
        end1: consensusSchedule(rows, 'end1'),
        day2: consensusSchedule(rows, 'day2') as any,
        begin2: consensusSchedule(rows, 'begin2'),
        end2: consensusSchedule(rows, 'end2'),
        room_id1: consensusNullable(rows, (r) => r.room_id1),
        room1: consensusText(rows, (r) => r.room1, 'Multiple'),
        room_id2: consensusNullable(rows, (r) => r.room_id2),
        room2: consensusText(rows, (r) => r.room2, 'Multiple'),
        rfc_needs_om: rows.some((r) => Boolean((r as any).rfc_needs_om)),
        manual_special_class: rows.some((r) => Boolean(r.manual_special_class)),
        pending_anchor_special_id: consensusNullable(rows, (r) => (r as any).pending_anchor_special_id),
      } as SpecialClassGroupRow;
    })
    .sort((a, b) => String(a.course_code || '').localeCompare(String(b.course_code || '')) || String(a.section_code || '').localeCompare(String(b.section_code || '')) || String(a.course_title || '').localeCompare(String(b.course_title || '')));
}

export default function OM_SpecialClass({
  hideMessageIcon = false,
  deadlineReadOnly = false,
  role = "om",
}: {
  hideMessageIcon?: boolean;
  deadlineReadOnly?: boolean;
  role?: "om" | "chair";
} = {}) {
  const [status, setStatus] = useState("All Status");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");

  const [exportOpen, setExportOpen] = useState(false);

  const [statuses, setStatuses] = useState<string[]>(["All Status"]);
  const [activeTermLabel, setActiveTermLabel] = useState<string>("");
  const [activeTerm, setActiveTerm] = useState<OMSpecialClassOptions["activeTerm"] | null>(null);
  const [submissionWindow, setSubmissionWindow] = useState<{ openISO: string; deadlineISO: string }>({ openISO: "", deadlineISO: "" });
  const [deadlineDraft, setDeadlineDraft] = useState("");
  const [startingWindow, setStartingWindow] = useState(false);

  // Faculty
  const [facultyNames, setFacultyNames] = useState<string[]>(["UNASSIGNED"]);
  const [facultyNameToIdUpper, setFacultyNameToIdUpper] = useState<Record<string, string>>({});
  const [facultyAvailability, setFacultyAvailability] = useState<FacultyAvailabilityMap>({});
  const [courseOptions, setCourseOptions] = useState<Array<{ course_id: string; course_code: string; course_title?: string }>>([]);

  // Rooms (read-only display)
  const [roomIdToInfo, setRoomIdToInfo] = useState<
    Record<
      string,
      { room_number: string; building?: string; capacity?: number; room_type?: string; campus_id?: string }
    >
  >({});

  // table
  const [rows, setRows] = useState<OMSpecialClassRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [errKind, setErrKind] = useState<"success" | "error">("error");

  // selection
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // edit
  const [editId, setEditId] = useState<string | null>(null);
  const [editTargetIds, setEditTargetIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<Partial<OMSpecialClassRow>>({});
  const [facultyInput, setFacultyInput] = useState<string>("");

  const [didClearAll, setDidClearAll] = useState(false);

  // add class
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<Partial<OMSpecialClassRow>>({ status: "Forwarded To Department" });
  const [addFacultyInput, setAddFacultyInput] = useState<string>("");

  // student movement
  const [pendingMove, setPendingMove] = useState<null | {
    student: SpecialClassGroupStudent;
    sourceGroupKey: string;
    sourceSpecialId: string;
    courseId: string;
    courseLabel: string;
    sourceSectionLabel: string;
  }>(null);
  const [inlineAssignState, setInlineAssignState] = useState<null | {
    targetGroupKey: string;
    targetSpecialId: string;
    courseLabel: string;
    sectionLabel: string;
    candidates: OMSpecialClassCandidate[];
    selectedStudentId: string;
    loading: boolean;
    mode: "add";
  }>(null);

  // view modal
  const [viewOpen, setViewOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewErr, setViewErr] = useState("");
  const [viewData, setViewData] = useState<OMSpecialClassDetail | null>(null);

  const confirmResolverRef = useRef<((v: boolean) => void) | null>(null);
  const [confirmState, setConfirmState] = useState<
    | { title: string; message: string; accent: "emerald" | "amber"; confirmText: string; note?: string }
    | null
  >(null);

  // RFC / conversation modal (Special Class)
  const [conv, setConv] = useState<{
    open: boolean;
    termId: string;
    facultyId?: string | null;
    facultyName?: string;
    sectionId: string;
  } | null>(null);

  const userId = useMemo(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
      return String(raw.userId || raw.user_id || raw.id || "");
    } catch {
      return "";
    }
  }, []);

  const isChair = role === "chair";

  const apiFns = useMemo(() => ({
    getOptions: isChair ? getChairSCOptions : getOMSC_Options,
    list: isChair ? listChairSC : listOMSC,
    update: isChair ? updateChairSC : updateOMSC,
    detail: isChair ? getChairSC_Detail : getOMSC_Detail,
    exportPdf: isChair ? exportChairSC_Pdf : exportOMSC_Pdf,
    create: isChair ? createChairSC : createOMSC,
    eligibleStudents: isChair ? getChairSC_EligibleStudents : getOMSC_EligibleStudents,
    assignStudent: isChair ? assignChairSCStudent : assignOMSCStudent,
    unassignStudent: isChair ? unassignChairSCStudent : unassignOMSCStudent,
    deleteClass: isChair ? deleteChairSCClass : deleteOMSCClass,
  }), [isChair]);

  const modalCourseOptions = useMemo(() => {
    const map = new Map<string, { course_id: string; course_code: string; course_title?: string }>();
    (courseOptions || []).forEach((opt) => {
      if (!opt?.course_id) return;
      map.set(String(opt.course_id), opt);
    });
    (rows || []).forEach((row) => {
      const cid = String(row.course_id || "").trim();
      if (!cid || map.has(cid)) return;
      map.set(cid, {
        course_id: cid,
        course_code: String(row.course_code || ""),
        course_title: String(row.course_title || ""),
      });
    });
    return Array.from(map.values()).sort((a, b) => `${a.course_code} ${a.course_title || ""}`.localeCompare(`${b.course_code} ${b.course_title || ""}`));
  }, [courseOptions, rows]);

  const modalCourseLabelToId = useMemo(() => Object.fromEntries(
    modalCourseOptions.map((opt) => [
      `${opt.course_code}${opt.course_title ? ` — ${opt.course_title}` : ""}`,
      opt.course_id,
    ])
  ) as Record<string, string>, [modalCourseOptions]);

  const modalCourseIdToLabel = useMemo(() => Object.fromEntries(
    modalCourseOptions.map((opt) => [
      opt.course_id,
      `${opt.course_code}${opt.course_title ? ` — ${opt.course_title}` : ""}`,
    ])
  ) as Record<string, string>, [modalCourseOptions]);

  const toast = (message: string, kind?: "success" | "error") => {
    setErrKind(kind === "success" ? "success" : "error");
    setErr(message);
    if (kind === "success") window.setTimeout(() => setErr(""), 2500);
  };

  const candidateLabel = (candidate: Pick<OMSpecialClassCandidate, "student_name" | "student_number">) =>
    `${candidate.student_name || ""}${candidate.student_number ? ` (${candidate.student_number})` : ""}`;

  const visibleStudentsForRow = (row: SpecialClassGroupRow) => {
    if (!pendingMove || pendingMove.sourceGroupKey !== row.group_key) return row.students;
    return row.students.filter((student) => student.special_id !== pendingMove.student.special_id);
  };

  const visibleCountForRow = (row: SpecialClassGroupRow) => {
    const baseCount = typeof row.count === "number" ? row.count : row.students.length;
    if (!pendingMove || pendingMove.sourceGroupKey !== row.group_key) return baseCount;
    return Math.max(0, baseCount - 1);
  };

  const canReceiveMovedStudent = (row: SpecialClassGroupRow) => {
    if (!pendingMove) return false;
    if (row.group_key === pendingMove.sourceGroupKey) return false;
    if (String(row.course_id || "") !== pendingMove.courseId) return false;
    if (!row.primary_special_id) return false;
    return !!String(row.section_id || (row as any).assignment_id || (row as any).pending_anchor_special_id || "").trim();
  };

  const openConfirm = (payload: {
    title: string;
    message: string;
    accent: "emerald" | "amber";
    confirmText: string;
    note?: string;
  }) => new Promise<boolean>((resolve) => {
    confirmResolverRef.current = resolve;
    setConfirmState(payload);
  });

  const closeConfirm = (result: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState(null);
    resolver?.(result);
  };

  const roomLabel = (r: Partial<OMSpecialClassRow>, slot: 1 | 2) => {
    const direct = (slot === 1 ? r.room1 : r.room2) || "";
    const directTrim = direct.trim();
    if (directTrim) {
      if (directTrim.toUpperCase() === "ONLINE") return "TBA";
      return directTrim;
    }

    const rid = (slot === 1 ? r.room_id1 : r.room_id2) || "";
    const ridTrim = rid.trim();
    if (!ridTrim) return "TBA";
    const info = roomIdToInfo[ridTrim];
    if (!info?.room_number) return "TBA";
    if (String(info.room_number).trim().toUpperCase() === "ONLINE") return "TBA";
    return info.room_number;
  };

  const roomTitle = (r: Partial<OMSpecialClassRow>, slot: 1 | 2) => {
    const rid = (slot === 1 ? r.room_id1 : r.room_id2) || "";
    const info = rid ? roomIdToInfo[String(rid).trim()] : null;
    if (!info) return undefined;
    const parts = [
      info.building ? info.building : null,
      typeof info.capacity === "number" ? `Cap: ${info.capacity}` : null,
      info.room_type ? info.room_type : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" • ") : undefined;
  };

  type RoomCellItem = {
    key: string;
    label: string;
    title?: string;
  };

  const roomCellItems = (r: Partial<OMSpecialClassRow>): RoomCellItem[] => {
    const items: RoomCellItem[] = [];

    const addSlot = (slot: 1 | 2) => {
      const day = String(slot === 1 ? r.day1 || "" : r.day2 || "").trim();
      const beginRaw = String(slot === 1 ? r.begin1 || "" : r.begin2 || "").trim();
      const endRaw = String(slot === 1 ? r.end1 || "" : r.end2 || "").trim();
      const roomRaw = String(slot === 1 ? r.room1 || "" : r.room2 || "").trim();
      const roomId = String(slot === 1 ? r.room_id1 || "" : r.room_id2 || "").trim();
      const hasAnyValue = day || beginRaw || endRaw || roomRaw || roomId;

      if (!hasAnyValue) return;

      items.push({
        key: `room-${slot}`,
        label: roomLabel(r, slot),
        title: roomTitle(r, slot),
      });
    };

    addSlot(1);
    addSlot(2);

    if (items.length) return items;

    return [
      {
        key: 'room-empty',
        label: 'TBA',
      },
    ];
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
      const data = await startOMSCWindow({
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

  const loadOptions = async () => {
    try {
      const opt: OMSpecialClassOptions = await apiFns.getOptions();
      if (!opt.ok) throw new Error("Failed to load options");
      setStatuses(["All Status", ...(opt.statuses || [])]);

      setActiveTerm(opt.activeTerm || null);
      const ay = opt.activeTerm?.acad_year_start;
      const tn = opt.activeTerm?.term_number;
      setActiveTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");
      const win = opt.submission_window || {};
      const nextWindow = { openISO: win.openISO || "", deadlineISO: win.deadlineISO || "" };
      setSubmissionWindow(nextWindow);
      if (nextWindow.deadlineISO) {
        setDeadlineDraft(toLocalInput(nextWindow.deadlineISO));
      } else {
        const base = nextMinuteFrom();
        const plus7 = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
        setDeadlineDraft(toLocalInput(plus7.toISOString()));
      }

      const names = (opt.facultyOptions || [])
        .map((f) => (f.faculty_name || "").trim())
        .filter(Boolean);

      const mapUpper: Record<string, string> = {};
      (opt.facultyOptions || []).forEach((f) => {
        const nm = (f.faculty_name || "").trim();
        if (!nm) return;
        mapUpper[nm.toUpperCase()] = f.faculty_id;
      });

      setFacultyNames(["UNASSIGNED", ...names]);
      setFacultyNameToIdUpper(mapUpper);
      setFacultyAvailability(((opt as any).facultyAvailability || {}) as FacultyAvailabilityMap);
      setCourseOptions((((opt as any).courseOptions || []) as Array<{ course_id: string; course_code: string; course_title?: string }>));

      const rm: Record<string, any> = {};
      (opt.roomOptions || []).forEach((x: any) => {
        const rid = String(x?.room_id || "").trim();
        const rn = String(x?.room_number || "").trim();
        if (!rid) return;
        rm[rid] = {
          room_number: rn,
          building: x?.building,
          capacity: x?.capacity,
          room_type: x?.room_type,
          campus_id: x?.campus_id,
        };
      });
      setRoomIdToInfo(rm);
    } catch (e: any) {
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
    }
  };

  // load options
  useEffect(() => {
    void loadOptions();
  }, [apiFns]);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = async () => {
    try {
      setLoading(true);
      setErr("");
      setErrKind("error");
      setErrKind("error");
      const res = await apiFns.list({ status, q });
      if (!res.ok) throw new Error("Failed to load special class applications");
      const incoming = res.rows || [];
      setRows(incoming);
    } catch (e: any) {
      setRows([]);
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to load special class.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q]);

  const groupedRows = useMemo(() => buildGroupedRows(rows), [rows]);

  const selectedList = useMemo(
    () => groupedRows.filter((r) => !!selectedIds[r.group_key]).flatMap((r) => r.special_ids),
    [groupedRows, selectedIds]
  );

  const toggleAllVisible = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = { ...prev };
      groupedRows.forEach((r) => {
        if (checked) next[r.group_key] = true;
        else delete next[r.group_key];
      });
      return next;
    });
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = { ...prev };
      if (checked) next[id] = true;
      else delete next[id];
      return next;
    });
  };

  const exportSelectedPdf = async () => {
    // Export each selected application as its own PDF file (separate downloads)
    const safe = (s: string) =>
      (s || "")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    const makeFileName = (id: string) => {
      const r = rows.find((x) => x.special_id === id);
      const date = new Date().toISOString().slice(0, 10);
      const course = safe(r?.course_code || "Course");
      const sec = safe(r?.section_code || "Section");
      const stud = safe(String(r?.student_number || r?.student_name || ""));
      const parts = ["SpecialClass", course, sec, stud, safe(id), date].filter(Boolean);
      return `${parts.join("_")}.pdf`;
    };

    try {
      setErr("");
      setErrKind("error");
      if (selectedList.length === 0) {
        setErrKind("error");
        setErr("Select at least one application to export.");
        return;
      }

      setLoading(true);

      // Always export as separate files when multiple are selected.
      for (const id of selectedList) {
        const blob = await apiFns.exportPdf({ special_ids: [id] });
        downloadBlob(blob, makeFileName(id));
      }
    } catch (e: any) {
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to export selected PDF.");
    } finally {
      setLoading(false);
    }
  };

  // CHAIR Plantilla-style Excel export (HTML -> .xls), but with a Special Class form header.
  // NOTE: This intentionally keeps "Name of Faculty" blank, matching the user's template requirement.
  const exportTableExcel = () => {
    if (!rows || rows.length === 0) {
      setErrKind("error");
      setErr("No rows to export.");
      return;
    }

    const normalizeForExcel = (value: string) => {
      let v = value ?? "";
      if (v === "—") v = "";
      v = v
        .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u00A0/g, " ")
        .replace(/[\r\n\t]/g, " ");
      v = v.replace(/\s+/g, " ").trim();
      return v;
    };

    const esc = (v: string) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const scheduleForRow = (r: OMSpecialClassRow) => {
      const parts: string[] = [];
      if (r.day1 && r.begin1 && r.end1) parts.push(`${r.day1} ${prettyHHMM(r.begin1)}-${prettyHHMM(r.end1)}`);
      if (r.day2 && r.begin2 && r.end2) parts.push(`${r.day2} ${prettyHHMM(r.begin2)}-${prettyHHMM(r.end2)}`);
      return parts.join("; ");
    };

    const roomForRow = (r: OMSpecialClassRow) => {
      const parts: string[] = [];
      if (r.room1) parts.push(r.room1);
      if (r.room2) parts.push(r.room2);
      return parts.join(" / ");
    };

    const termLine = activeTermLabel ? activeTermLabel : "";
    const COLS = 8;

    const headerRows = `
      <tr><td colspan="${COLS}" style="text-align:center;font-weight:bold;font-size:14pt;">De La Salle University</td></tr>
      <tr><td colspan="${COLS}" style="text-align:center;font-weight:bold;">OFFICE OF THE PROVOST</td></tr>
      <tr><td colspan="${COLS}" style="text-align:center;font-weight:bold;">APPLICATION FOR SPECIAL CLASS</td></tr>
      <tr><td colspan="${COLS}" style="text-align:center;">${esc(termLine)}</td></tr>
      <tr><td colspan="${COLS}" style="height:12px;"></td></tr>

      <tr>
        <td style="font-weight:bold;">DATE:</td>
        <td colspan="3"></td>
        <td style="font-weight:bold;">For:</td>
        <td colspan="3"></td>
      </tr>
      <tr>
        <td style="font-weight:bold;">From:</td>
        <td colspan="3"></td>
        <td style="font-weight:bold;">Endorsed by:</td>
        <td colspan="3"></td>
      </tr>
      <tr><td colspan="${COLS}" style="height:12px;"></td></tr>
      <tr><td colspan="${COLS}">This is to request for the opening of the following classes as <b>SPECIAL CLASS</b>.</td></tr>
      <tr><td colspan="${COLS}" style="height:12px;"></td></tr>
    `;

    const tableHeader = `
      <tr>
        <th style="border:1px solid #000;background:#f3f4f6;padding:6px;text-align:center;">No.</th>
        <th style="border:1px solid #000;background:#f3f4f6;padding:6px;text-align:center;">Course Code</th>
        <th style="border:1px solid #000;background:#f3f4f6;padding:6px;text-align:center;">Section</th>
        <th style="border:1px solid #000;background:#f3f4f6;padding:6px;text-align:center;">Student / Reason</th>
        <th style="border:1px solid #000;background:#f3f4f6;padding:6px;text-align:center;">Schedule</th>
        <th style="border:1px solid #000;background:#f3f4f6;padding:6px;text-align:center;">Room</th>
        <th style="border:1px solid #000;background:#f3f4f6;padding:6px;text-align:center;">Name of Faculty</th>
        <th style="border:1px solid #000;background:#f3f4f6;padding:6px;text-align:center;">Provost Approval</th>
      </tr>
    `;

    const bodyRows = rows
      .map((r, i) => {
        const student = r.student_name ? String(r.student_name) : "";
        const reason = r.reason_other ? String(r.reason_other) : r.reason ? String(r.reason) : "";
        const studentReason = [student, reason].filter(Boolean).join(" — ");
        const cells = [
          String(i + 1),
          r.course_code || "",
          r.section_code || "",
          studentReason,
          scheduleForRow(r),
          roomForRow(r),
          "", // Name of Faculty left blank
          "", // Provost Approval blank
        ].map((c) => esc(normalizeForExcel(String(c ?? ""))));

        return `
          <tr>
            <td style="border:1px solid #000;padding:6px;text-align:center;">${cells[0]}</td>
            <td style="border:1px solid #000;padding:6px;">${cells[1]}</td>
            <td style="border:1px solid #000;padding:6px;text-align:center;">${cells[2]}</td>
            <td style="border:1px solid #000;padding:6px;">${cells[3]}</td>
            <td style="border:1px solid #000;padding:6px;">${cells[4]}</td>
            <td style="border:1px solid #000;padding:6px;">${cells[5]}</td>
            <td style="border:1px solid #000;padding:6px;"></td>
            <td style="border:1px solid #000;padding:6px;"></td>
          </tr>
        `;
      })
      .join("");

    const safeTerm = (activeTermLabel || "").replace(/[^a-z0-9\-\s_]/gi, "").trim();
    const filename = safeTerm ? `Special_Class_${safeTerm}.xls` : "Special_Class.xls";

    const html = `
      <html>
        <head><meta charset="utf-8" /></head>
        <body>
          <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Calibri;font-size:11pt;">
            ${headerRows}
            ${tableHeader}
            ${bodyRows}
          </table>
        </body>
      </html>
    `;

    const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };


  const beginEdit = async (row: SpecialClassGroupRow) => {
    setEditId(row.group_key);
    setEditTargetIds(row.special_ids || []);
    setDidClearAll(false);

    setDraft({
      course_id: row.course_id,
      status: row.status === "Mixed" ? "" : row.status,
      remarks: row.remarks || "",
      faculty_id: row.faculty_id || null,
      section_id: row.section_id || null,
      section_code: row.section_code === "Multiple" ? "" : row.section_code || "",
      day1: (row.day1 || "") as any,
      begin1: row.begin1 || "",
      end1: row.end1 || "",
      day2: (row.day2 || "") as any,
      begin2: row.begin2 || "",
      end2: row.end2 || "",
    });

    const facName = (row.faculty_name || "").toString().trim();
    setFacultyInput(facName === "UNASSIGNED" || facName === "Multiple" ? "" : facName);
  };

  const setSlotFromBand = (slot: 1 | 2, bandLabel: string) => {
    const found = GE_TIME_SLOTS.find((x) => x.label === bandLabel);
    if (!found) {
      setDraft((d) => ({
        ...d,
        ...(slot === 1 ? { begin1: "", end1: "" } : { begin2: "", end2: "" }),
      }));
      return;
    }
    setDraft((d) => ({
      ...d,
      ...(slot === 1
        ? { begin1: found.start, end1: found.end }
        : { begin2: found.start, end2: found.end }),
    }));
  };

  const setAddSlotFromBand = (slot: 1 | 2, bandLabel: string) => {
    const found = GE_TIME_SLOTS.find((x) => x.label === bandLabel);
    if (!found) {
      setAddDraft((d) => ({
        ...d,
        ...(slot === 1 ? { begin1: "", end1: "" } : { begin2: "", end2: "" }),
      }));
      return;
    }
    setAddDraft((d) => ({
      ...d,
      ...(slot === 1
        ? { begin1: found.start, end1: found.end }
        : { begin2: found.start, end2: found.end }),
    }));
  };



  const cancelEdit = () => {
    setEditId(null);
    setEditTargetIds([]);
    setDraft({});
    setFacultyInput("");
    setDidClearAll(false);
  };

  const openAddClass = () => {
    setAdding(true);
    setAddFacultyInput("");
    setAddDraft({
      status: "Forwarded To Department",
      remarks: "",
      course_id: modalCourseOptions[0]?.course_id || "",
      section_code: "",
      faculty_id: null,
      day1: "" as any,
      begin1: "",
      end1: "",
      day2: "" as any,
      begin2: "",
      end2: "",
    });
  };

  const closeAddClass = () => {
    setAdding(false);
    setAddDraft({ status: "Forwarded To Department" });
    setAddFacultyInput("");
  };

  const saveAddClass = async () => {
    try {
      const courseId = String(addDraft.course_id || "").trim();
      if (!courseId) throw new Error("Please select a course.");

      const typedName = (addFacultyInput || "").trim();
      const payloadFacultyId =
        typedName && typedName.toUpperCase() !== "UNASSIGNED"
          ? facultyNameToIdUpper[typedName.toUpperCase()] || ""
          : "";

      const hasMeeting1 = !!addDraft.day1 && !!addDraft.begin1 && !!addDraft.end1;
      const hasAnyMeeting2 = !!addDraft.day2 || !!addDraft.begin2 || !!addDraft.end2;
      const hasMeeting2 = !!addDraft.day2 && !!addDraft.begin2 && !!addDraft.end2;
      const attemptedBundleEdit = !!(
        (addFacultyInput || "").trim() || addDraft.day1 || addDraft.begin1 || addDraft.end1 || addDraft.day2 || addDraft.begin2 || addDraft.end2
      );

      const payload: any = {
        course_id: courseId,
        status: addDraft.status || "Forwarded To Department",
        remarks: addDraft.remarks || "",
      };

      setLoading(true);
      setErr("");
      const created = await apiFns.create(payload, getSessionUserId() || userId || undefined);

      if (attemptedBundleEdit) {
        if (!payloadFacultyId) throw new Error("Please select an available faculty.");
        if (!hasMeeting1) throw new Error("Meeting 1 must include day, begin time, and end time.");
        if (hasAnyMeeting2 && !hasMeeting2) throw new Error("Meeting 2 must include day, begin time, and end time.");

        await apiFns.update(created.special_id, ({
          special_ids: [created.special_id],
          status: addDraft.status || "Forwarded To Department",
          remarks: addDraft.remarks || "",
          faculty_id: payloadFacultyId,
          day1: (addDraft.day1 || "") as any,
          begin1: addDraft.begin1 || "",
          end1: addDraft.end1 || "",
          day2: hasMeeting2 ? ((addDraft.day2 || "") as any) : "",
          begin2: hasMeeting2 ? (addDraft.begin2 || "") : "",
          end2: hasMeeting2 ? (addDraft.end2 || "") : "",
        } as any), getSessionUserId() || userId || undefined);
      }

      closeAddClass();
      toast(attemptedBundleEdit ? "Special class added with faculty and schedule. APO can assign the section later." : "Special class added. APO can assign the section later.", "success");
      await Promise.all([load(), loadOptions()]);
    } catch (e: any) {
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to add special class.");
    } finally {
      setLoading(false);
    }
  };

  const closeInlineAssign = () => setInlineAssignState(null);

  const openInlineAssign = async (row: SpecialClassGroupRow) => {
    if (!row.primary_special_id) return;

    const courseLabel = String(row.course_code || row.course_title || "Course");
    const sectionLabel = String(row.section_code || "—");

    try {
      setInlineAssignState({
        targetGroupKey: row.group_key,
        targetSpecialId: row.primary_special_id,
        courseLabel,
        sectionLabel,
        candidates: [],
        selectedStudentId: "",
        loading: true,
        mode: "add",
      });
      const res = await apiFns.eligibleStudents(row.primary_special_id);
      const firstId = String((res.rows || [])[0]?.special_id || "");
      setInlineAssignState({
        targetGroupKey: row.group_key,
        targetSpecialId: row.primary_special_id,
        courseLabel,
        sectionLabel,
        candidates: res.rows || [],
        selectedStudentId: firstId,
        loading: false,
        mode: "add",
      });
    } catch (e: any) {
      setInlineAssignState(null);
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to load eligible students.");
    }
  };

  const confirmInlineAssign = async () => {
    if (!inlineAssignState?.targetSpecialId || !inlineAssignState.selectedStudentId) return;
    try {
      setLoading(true);
      await apiFns.assignStudent(inlineAssignState.targetSpecialId, inlineAssignState.selectedStudentId, getSessionUserId() || userId || undefined);
      setInlineAssignState(null);
      toast("Student added to class.", "success");
      await Promise.all([load(), loadOptions()]);
    } catch (e: any) {
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to add student to class.");
    } finally {
      setLoading(false);
    }
  };

  const startStudentMove = (student: SpecialClassGroupStudent, row: SpecialClassGroupRow) => {
    if (loading || editId === row.group_key) return;

    const sameStudentSelected = pendingMove?.student.special_id === student.special_id;
    if (sameStudentSelected) {
      setPendingMove(null);
      toast("Student move canceled.", "success");
      return;
    }

    const nextMove = {
      student,
      sourceGroupKey: row.group_key,
      sourceSpecialId: row.primary_special_id,
      courseId: String(row.course_id || student.course_id || ""),
      courseLabel: String(row.course_code || row.course_title || "Course"),
      sourceSectionLabel: String(row.section_code || "—"),
    };

    setPendingMove(nextMove);
    setInlineAssignState(null);

    const availableTargets = groupedRows.some((candidate) => {
      if (candidate.group_key === row.group_key) return false;
      if (String(candidate.course_id || "") !== nextMove.courseId) return false;
      if (!candidate.primary_special_id) return false;
      return !!String(candidate.section_id || (candidate as any).assignment_id || "").trim();
    });

    if (availableTargets) toast("Choose another same-course class, then click Move Here.", "success");
    else toast("No other ready class is available. You can unassign this student instead.", "success");
  };

  const cancelPendingMove = () => {
    setPendingMove(null);
  };

  const moveStudentHere = async (row: SpecialClassGroupRow) => {
    if (!pendingMove || !canReceiveMovedStudent(row)) return;
    try {
      setLoading(true);
      await apiFns.assignStudent(row.primary_special_id, pendingMove.student.special_id, getSessionUserId() || userId || undefined);
      const movedStudentName = pendingMove.student.student_name || "Student";
      setPendingMove(null);
      setInlineAssignState(null);
      toast(`${movedStudentName} moved successfully.`, "success");
      await Promise.all([load(), loadOptions()]);
    } catch (e: any) {
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to move student.");
    } finally {
      setLoading(false);
    }
  };

  const unassignPendingStudent = async () => {
    if (!pendingMove?.student?.special_id) return;
    try {
      setLoading(true);
      await apiFns.unassignStudent(pendingMove.student.special_id, getSessionUserId() || userId || undefined);
      const movedStudentName = pendingMove.student.student_name || "Student";
      setPendingMove(null);
      setInlineAssignState(null);
      toast(`${movedStudentName} unassigned successfully.`, "success");
      await Promise.all([load(), loadOptions()]);
    } catch (e: any) {
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to unassign student.");
    } finally {
      setLoading(false);
    }
  };

  const deleteSpecialClassRow = async (row: SpecialClassGroupRow) => {
    if (loading || editId === row.group_key || !row.primary_special_id) return;

    const applicantCount = row.students.length;
    const generatedRow = Boolean(row.generated_from_class_retention);
    const message = applicantCount > 0
      ? `Delete this special class for ${row.course_code || row.course_title || "this course"}? The students will stay in the same course, but their section/faculty assignment will be cleared so you can reassign them.`
      : generatedRow
      ? `Clear this reflected special class for ${row.course_code || row.course_title || "this course"}? It will stay visible from Class Retention, but the section/faculty schedule will be removed.`
      : `Delete this special class for ${row.course_code || row.course_title || "this course"}? This removes the class row.`;

    const ok = await openConfirm({
      title: applicantCount > 0 || generatedRow ? "Clear Special Class?" : "Delete Special Class?",
      message,
      accent: "amber",
      confirmText: applicantCount > 0 || generatedRow ? "Clear" : "Delete",
      note: applicantCount > 0
        ? "Students will remain available under the same course so you can place them into another special class later."
        : generatedRow
        ? "Because this row is reflected from Class Retention, the course stays visible even after clearing its section/faculty schedule."
        : undefined,
    });
    if (!ok) return;

    try {
      setLoading(true);
      setErr("");
      const res = await apiFns.deleteClass(row.primary_special_id, getSessionUserId() || userId || undefined);
      closeInlineAssign();
      cancelPendingMove();
      toast(res?.message || (res?.kept_row ? "Special class cleared." : "Special class deleted."), "success");
      await Promise.all([load(), loadOptions()]);
    } catch (e: any) {
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to delete special class.");
    } finally {
      setLoading(false);
    }
  };

  const saveEdit = async () => {
    if (!editId || editTargetIds.length === 0) return;

    try {
      setLoading(true);
      setErr("");

      const typedName = (facultyInput || "").trim();
      const payloadFacultyId =
        typedName && typedName.toUpperCase() !== "UNASSIGNED"
          ? facultyNameToIdUpper[typedName.toUpperCase()] || ""
          : "";

      const payload: any = {
        status: draft.status,
        remarks: draft.remarks,
      };

      const currentSectionId = String((draft.section_id || "") as string).trim();
      const hasAssignedSection = !!currentSectionId;
      const hasMeeting1 = !!draft.day1 && !!draft.begin1 && !!draft.end1;
      const hasAnyMeeting2 = !!draft.day2 || !!draft.begin2 || !!draft.end2;
      const hasMeeting2 = !!draft.day2 && !!draft.begin2 && !!draft.end2;
      const attemptedBundleEdit = !!(
        (facultyInput || "").trim() || draft.day1 || draft.begin1 || draft.end1 || draft.day2 || draft.begin2 || draft.end2
      );

      if (didClearAll) {
        payload.section_id = "";
        payload.faculty_id = null;
        payload.day1 = "";
        payload.begin1 = "";
        payload.end1 = "";
        payload.day2 = "";
        payload.begin2 = "";
        payload.end2 = "";
      } else if (attemptedBundleEdit || hasAssignedSection) {
        if (!payloadFacultyId) throw new Error("Please select an available faculty.");
        if (!hasMeeting1) throw new Error("Meeting 1 must include day, begin time, and end time.");
        if (hasAnyMeeting2 && !hasMeeting2) throw new Error("Meeting 2 must include day, begin time, and end time.");

        if (hasAssignedSection) payload.section_id = currentSectionId;
        payload.faculty_id = payloadFacultyId;
        payload.day1 = (draft.day1 || "") as any;
        payload.begin1 = draft.begin1 || "";
        payload.end1 = draft.end1 || "";
        payload.day2 = hasMeeting2 ? ((draft.day2 || "") as any) : "";
        payload.begin2 = hasMeeting2 ? (draft.begin2 || "") : "";
        payload.end2 = hasMeeting2 ? (draft.end2 || "") : "";
      }

      await apiFns.update(editTargetIds[0], {
        ...payload,
        special_ids: editTargetIds,
      }, getSessionUserId());

      setEditId(null);
      setDraft({});
      setFacultyInput("");
      setDidClearAll(false);
      await Promise.all([load(), loadOptions()]);
    } catch (e: any) {
      setErrKind("error");
      setErr(e?.response?.data?.detail || e?.message || "Failed to update special class.");
    } finally {
      setLoading(false);
    }
  };

  const openView = async (specialId: string) => {
    setViewOpen(true);
    setViewLoading(true);
    setViewErr("");
    setViewData(null);

    try {
      const res = await apiFns.detail(specialId);
      if (!res.ok) throw new Error("Failed to load application detail.");
      setViewData(res.row);
    } catch (e: any) {
      setViewErr(e?.response?.data?.detail || e?.message || "Failed to load application detail.");
    } finally {
      setViewLoading(false);
    }
  };

  const closeView = () => {
    setViewOpen(false);
    setViewErr("");
    setViewData(null);
    setViewLoading(false);
  };

  const openEaf = (url?: string) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const allVisibleSelected = groupedRows.length > 0 && groupedRows.every((r) => !!selectedIds[r.group_key]);
  const addSelectedFacultyId = String((
    (addFacultyInput.trim() && addFacultyInput.toUpperCase() !== "UNASSIGNED"
      ? (facultyNameToIdUpper[addFacultyInput.trim().toUpperCase()] || "")
      : "")
    || addDraft.faculty_id
    || ""
  )).trim();
  const addPeerMeetings = buildMeetingSlots({
    day1: addDraft.day1 as string | undefined,
    begin1: addDraft.begin1 as string | undefined,
    end1: addDraft.end1 as string | undefined,
    day2: addDraft.day2 as string | undefined,
    begin2: addDraft.begin2 as string | undefined,
    end2: addDraft.end2 as string | undefined,
  });
  const addSlot1PeerMeetings = addPeerMeetings.filter((m) => m.slot !== 1);
  const addSlot2PeerMeetings = addPeerMeetings.filter((m) => m.slot !== 2);
  const availableAddFacultyNames = facultyNames.filter((name) => {
    if (name === "UNASSIGNED") return true;
    const fid = facultyNameToIdUpper[name.toUpperCase()] || "";
    if (!fid) return false;
    return !facultyHasConflictForMeetings({
      facultyId: fid,
      meetings: addPeerMeetings,
      busySlots: facultyAvailability,
    });
  });
  const availableAddDay1Options = DAY_OPTS_LABELS.filter((label) =>
    slotOptionIsAvailable({
      facultyId: addSelectedFacultyId,
      day: DAY_FROM_LABEL[label],
      begin: String(addDraft.begin1 || ""),
      peerMeetings: addSlot1PeerMeetings,
      busySlots: facultyAvailability,
    })
  );
  const availableAddBegin1Options = GE_TIME_SLOTS.filter((slot) =>
    slotOptionIsAvailable({
      facultyId: addSelectedFacultyId,
      day: String(addDraft.day1 || ""),
      begin: slot.start,
      peerMeetings: addSlot1PeerMeetings,
      busySlots: facultyAvailability,
    })
  );
  const availableAddDay2Options = DAY_OPTS_LABELS.filter((label) =>
    slotOptionIsAvailable({
      facultyId: addSelectedFacultyId,
      day: DAY_FROM_LABEL[label],
      begin: String(addDraft.begin2 || ""),
      peerMeetings: addSlot2PeerMeetings,
      busySlots: facultyAvailability,
    })
  );
  const availableAddBegin2Options = GE_TIME_SLOTS.filter((slot) =>
    slotOptionIsAvailable({
      facultyId: addSelectedFacultyId,
      day: String(addDraft.day2 || ""),
      begin: slot.start,
      peerMeetings: addSlot2PeerMeetings,
      busySlots: facultyAvailability,
    })
  );
  const minDeadlineLocal = toLocalInput(nextMinuteFrom().toISOString());

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Special Class</h1>
          <p className="text-sm text-gray-600">
            Review Special Class applications {activeTermLabel && `for ${activeTermLabel}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {deadlineReadOnly ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              
            </div>
          ) : (
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
          )}
        </div>
      </header>

      <DeadlineBanner
        deadlineISO={submissionWindow.deadlineISO}
        className="mb-6"
        emptyMessage={
          deadlineReadOnly
            ? "The Operations Manager has not set a submission deadline for this term yet."
            : undefined
        }
      />

      {err && (
        <div
          className={cls(
            "mb-4 rounded-lg px-3 py-2 text-sm",
            errKind === "success"
              ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border border-red-200 bg-red-50 text-red-700"
          )}
        >
          {err}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
        <div className="relative flex-1 min-w-[240px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search student name, course code, title, or section…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>

        <SelectBox value={status} onChange={setStatus} options={statuses} />

        <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={openAddClass}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          title="Add Class"
        >
          <Plus className="h-4 w-4" />
          Add Class
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setExportOpen((v) => !v)}
            disabled={loading}
            title="Export"
            className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Export
            <ChevronDown className="h-4 w-4" />
          </button>

          {exportOpen && (
            <div
              className="absolute right-0 mt-2 w-64 rounded-lg border border-gray-200 bg-white shadow-lg z-50"
              onMouseLeave={() => setExportOpen(false)}
            >
              <button
                type="button"
                onClick={() => {
                  setExportOpen(false);
                  exportSelectedPdf();
                }}
                disabled={selectedList.length === 0 || loading}
                className={cls(
                  "w-full text-left px-3 py-2 text-sm hover:bg-gray-50",
                  (selectedList.length === 0 || loading) && "opacity-60 cursor-not-allowed"
                )}
                title={selectedList.length === 0 ? "Select at least one application" : "Export selected applications to PDF"}
              >
                Export selected (PDF)
              </button>
              <button
                type="button"
                onClick={() => {
                  setExportOpen(false);
                  exportTableExcel();
                }}
                disabled={rows.length === 0 || loading}
                className={cls(
                  "w-full text-left px-3 py-2 text-sm hover:bg-gray-50",
                  (rows.length === 0 || loading) && "opacity-60 cursor-not-allowed"
                )}
                title={rows.length === 0 ? "No rows to export" : "Export the current table to Excel"}
              >
                Export table (Excel)
              </button>
            </div>
          )}
        </div>
        </div>
      </div>


      <div className="table-wrapper w-full overflow-hidden">
        <div className="border border-gray-200 bg-white shadow-sm overflow-x-auto rounded-xl">
          <table className="w-full min-w-[1800px] text-sm table-auto">
            <thead className="bg-gray-50 border-b text-gray-900">
              <tr>
                <th className="text-left px-3 py-2 whitespace-nowrap w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(e) => toggleAllVisible(e.target.checked)}
                    className="h-4 w-4 accent-emerald-600"
                    title="Select all visible"
                  />
                </th>

                <th className="w-[280px] min-w-[280px] text-left px-4 py-3 whitespace-nowrap">Course Code &amp; Title</th>
                <th className="w-[90px] min-w-[90px] text-center px-4 py-3 whitespace-nowrap">Count</th>
                <th className="w-[260px] min-w-[260px] text-left px-4 py-3 whitespace-nowrap">Students</th>
                <th className="w-[120px] min-w-[120px] text-center px-4 py-3 whitespace-nowrap">Section</th>
                <th className="w-[240px] min-w-[240px] text-left px-4 py-3 whitespace-nowrap">Faculty</th>

                <th className="w-[150px] min-w-[150px] text-center px-4 py-3 whitespace-nowrap">Day</th>
                <th className="w-[180px] min-w-[180px] text-center px-4 py-3 whitespace-nowrap">Time</th>
                <th className="w-[120px] min-w-[120px] text-center px-4 py-3 whitespace-nowrap">Room</th>

                <th className="w-[160px] min-w-[160px] text-center px-4 py-3 whitespace-nowrap">Status</th>
                <th className="w-[260px] min-w-[260px] text-left px-4 py-3 whitespace-nowrap">Remarks</th>
                <th className="w-12 px-2 py-2 text-center whitespace-nowrap"></th>
                <th className="w-[88px] px-2 py-2 text-center whitespace-nowrap">Actions</th>
              </tr>
            </thead>

            <tbody className="divide-y">
              {adding && (
                <tr className="bg-white align-top">
                  <td className="px-3 py-3"></td>

                  <td className="px-4 py-3 min-w-[280px] align-top">
                    <ComboSelect
                      value={modalCourseIdToLabel[String(addDraft.course_id || "")] || ""}
                      onChange={(v) => {
                        const nextId = modalCourseLabelToId[v] || modalCourseLabelToId[(v || "").trim()] || "";
                        setAddDraft((d) => ({ ...d, course_id: nextId }));
                      }}
                      options={Object.keys(modalCourseLabelToId)}
                      placeholder="Type or select course"
                    />
                    <div className="mt-1 text-xs leading-5 text-gray-500 whitespace-normal break-words">
                      {modalCourseOptions.find((opt) => String(opt.course_id) === String(addDraft.course_id || ""))?.course_title || " "}
                    </div>
                  </td>

                  <td className="px-4 py-3 text-center align-top">
                    <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">0</span>
                  </td>

                  <td className="px-4 py-3 align-top">
                    <div className="min-w-[260px] rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      No student application yet. You can add same-course applicants after saving this class.
                    </div>
                  </td>

                  <td className="px-4 py-3 text-center align-top">
                    <div className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700">—</div>
                  </td>

                  <td className="px-4 py-3 min-w-[240px] align-top">
                    <ComboSelect
                      value={addFacultyInput?.trim() ? addFacultyInput : ""}
                      onChange={(v) => {
                        const t = (v || "").trim();
                        if (t === "" || t.toUpperCase() === "UNASSIGNED") {
                          setAddFacultyInput("");
                          setAddDraft((d) => ({ ...d, faculty_id: null }));
                          return;
                        }
                        setAddFacultyInput(t);
                        const fid = facultyNameToIdUpper[t.toUpperCase()] || "";
                        setAddDraft((d) => ({ ...d, faculty_id: fid ? fid : null }));
                      }}
                      options={["", "UNASSIGNED", ...availableAddFacultyNames.filter((n) => n !== "UNASSIGNED")]}
                      placeholder={facultyNames.length > 1 ? (availableAddFacultyNames.length > 1 ? "Select Faculty" : "No available faculty") : "Loading…"}
                    />
                  </td>

                  <td className="px-4 py-3 align-top min-w-[620px]" colSpan={2}>
                    <div className="rounded-xl border border-neutral-200 bg-white px-4 py-4">
                      <div className="space-y-5">
                        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                          Section stays blank here until APO assigns the section and room. OM/CHAIR can already save faculty, schedule, status, and remarks.
                        </div>
                        <div className="space-y-2">
                          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                            <div className="space-y-1.5">
                              <div className="text-[12px] font-semibold text-emerald-800">Day 1</div>
                              <SelectBox
                                value={addDraft.day1 ? DAY_LABELS[addDraft.day1 as DayCode] : DAY_PLACEHOLDER}
                                onChange={(lbl) => {
                                  const nextDay1 = lbl === DAY_PLACEHOLDER ? "" : (DAY_FROM_LABEL[lbl as DayLabel] || "M");
                                  const autoDay2 = nextDay1 ? (DAY_PAIR[nextDay1] || "") : "";
                                  setAddDraft((d) => {
                                    const next = { ...d, day1: nextDay1 as any, day2: autoDay2 as any };
                                    if (addSelectedFacultyId && String(next.begin1 || "") && nextDay1 && !slotOptionIsAvailable({ facultyId: addSelectedFacultyId, day: nextDay1, begin: String(next.begin1 || ""), peerMeetings: addSlot1PeerMeetings, busySlots: facultyAvailability })) {
                                      next.begin1 = "";
                                      next.end1 = "";
                                    }
                                    if (addSelectedFacultyId && String(next.begin2 || "") && autoDay2 && !slotOptionIsAvailable({ facultyId: addSelectedFacultyId, day: autoDay2, begin: String(next.begin2 || ""), peerMeetings: addSlot2PeerMeetings, busySlots: facultyAvailability })) {
                                      next.begin2 = "";
                                      next.end2 = "";
                                    }
                                    return next;
                                  });
                                }}
                                options={[DAY_PLACEHOLDER, ...(addSelectedFacultyId ? availableAddDay1Options : DAY_OPTS_LABELS)]}
                              />
                            </div>

                            <div className="space-y-1.5">
                              <div className="text-[12px] font-semibold text-emerald-800">Begin 1</div>
                              <SelectBox
                                value={prettyHHMM(addDraft.begin1 || "") || "Select time…"}
                                onChange={(band) => {
                                  if (band === "Select time…") {
                                    setAddSlotFromBand(1, "");
                                    return;
                                  }
                                  setAddSlotFromBand(1, band);
                                }}
                                options={["Select time…", ...(addSelectedFacultyId ? availableAddBegin1Options : GE_TIME_SLOTS).map((x) => x.label)]}
                              />
                            </div>

                            <div className="space-y-1.5">
                              <div className="text-[12px] font-semibold text-emerald-800">End 1</div>
                              <input
                                value={prettyHHMM(addDraft.end1 || "")}
                                disabled
                                className={cls(
                                  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                  "bg-gray-100 text-gray-700 cursor-not-allowed"
                                )}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2 border-t border-neutral-200 pt-5">
                          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                            <div className="space-y-1.5">
                              <div className="text-[12px] font-semibold text-emerald-800">Day 2</div>
                              <SelectBox
                                value={addDraft.day2 ? DAY_LABELS[addDraft.day2 as DayCode] : DAY_PLACEHOLDER}
                                onChange={(lbl) => {
                                  const nextDay2 = lbl === DAY_PLACEHOLDER ? "" : (DAY_FROM_LABEL[lbl as DayLabel] || "M");
                                  setAddDraft((d) => {
                                    const next = { ...d, day2: nextDay2 as any };
                                    if (addSelectedFacultyId && String(next.begin2 || "") && nextDay2 && !slotOptionIsAvailable({ facultyId: addSelectedFacultyId, day: nextDay2, begin: String(next.begin2 || ""), peerMeetings: addSlot2PeerMeetings, busySlots: facultyAvailability })) {
                                      next.begin2 = "";
                                      next.end2 = "";
                                    }
                                    return next;
                                  });
                                }}
                                options={[DAY_PLACEHOLDER, ...(addSelectedFacultyId ? availableAddDay2Options : DAY_OPTS_LABELS)]}
                              />
                            </div>

                            <div className="space-y-1.5">
                              <div className="text-[12px] font-semibold text-emerald-800">Begin 2</div>
                              <SelectBox
                                value={prettyHHMM(addDraft.begin2 || "") || "Select time…"}
                                onChange={(band) => {
                                  if (band === "Select time…") {
                                    setAddSlotFromBand(2, "");
                                    return;
                                  }
                                  setAddSlotFromBand(2, band);
                                }}
                                options={["Select time…", ...(addSelectedFacultyId ? availableAddBegin2Options : GE_TIME_SLOTS).map((x) => x.label)]}
                              />
                            </div>

                            <div className="space-y-1.5">
                              <div className="text-[12px] font-semibold text-emerald-800">End 2</div>
                              <input
                                value={prettyHHMM(addDraft.end2 || "")}
                                disabled
                                className={cls(
                                  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                  "bg-gray-100 text-gray-700 cursor-not-allowed"
                                )}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className="px-4 py-3 text-center align-top">
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">TBA</div>
                  </td>

                  <td className="px-4 py-3 text-center align-top">
                    <SelectBox
                      value={String(addDraft.status || "Forwarded To Department")}
                      onChange={(v) => setAddDraft((d) => ({ ...d, status: v }))}
                      options={statuses.filter((s) => s !== "All Status")}
                    />
                  </td>

                  <td className="px-4 py-3 align-top">
                    <textarea
                      value={String(addDraft.remarks || "")}
                      onChange={(e) => setAddDraft((d) => ({ ...d, remarks: e.target.value }))}
                      rows={3}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm resize-none focus:ring-2 focus:ring-emerald-500/30"
                      placeholder="Optional remarks"
                    />
                  </td>

                  <td className="px-2 py-3 text-center align-top">
                    <div className="flex items-center justify-center">
                      <button
                        type="button"
                        onClick={saveAddClass}
                        disabled={loading}
                        className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50 disabled:cursor-not-allowed disabled:opacity-50"
                        title="Save"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </div>
                  </td>

                  <td className="px-2 py-3 text-center align-top">
                    <div className="flex items-center justify-center">
                      <button
                        type="button"
                        onClick={closeAddClass}
                        disabled={loading}
                        className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-400 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                        title="Cancel"
                      >
                        <X className="h-4 w-4" strokeWidth={2.5} />
                      </button>
                    </div>
                  </td>
                </tr>
              )}

              {loading ? (
                <tr>
                  <td className="px-4 py-6 text-center text-gray-500" colSpan={13}>
                    Loading…
                  </td>
                </tr>
              ) : groupedRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-gray-500" colSpan={13}>
                    No results
                  </td>
                </tr>
              ) : (
                groupedRows.map((r) => {
                  const editing = editId === r.group_key;
                  const canEditFacultySchedule = true;
                  const visibleStudents = visibleStudentsForRow(r);
                  const displayCount = visibleCountForRow(r);
                  const moveSourceRow = pendingMove?.sourceGroupKey === r.group_key;
                  const assignInlineOpen = inlineAssignState?.targetGroupKey === r.group_key;
                  return (
                    <Fragment key={r.group_key}>
                    <tr className="hover:bg-gray-50 align-top">
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={!!selectedIds[r.group_key]}
                          onChange={(e) => toggleOne(r.group_key, e.target.checked)}
                          className="h-4 w-4 accent-emerald-600"
                          disabled={loading}
                        />
                      </td>

                      <td className="px-4 py-3 min-w-[280px] align-top">
                        <div className="font-semibold text-emerald-700">{r.course_code || "—"}</div>
                        <div className="mt-1 text-xs leading-5 text-gray-500 whitespace-normal break-words">{r.course_title || ""}</div>
                      </td>

                      <td className="px-4 py-3 text-center align-top">
                        <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                          {displayCount}
                        </span>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="space-y-2 min-w-[260px]">
                          {moveSourceRow && pendingMove ? (
                            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                              <div className="font-medium">{pendingMove.student.student_name || "Student"} is selected.</div>
                              <div className="text-xs text-amber-800">Choose another same-course class and click Move Here, or unassign the student from this section.</div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={unassignPendingStudent}
                                  disabled={loading}
                                  className="inline-flex items-center rounded-md border border-amber-400 bg-amber-100 px-3 py-2 text-sm font-medium text-amber-950 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Unassign Student
                                </button>
                                <button
                                  type="button"
                                  onClick={cancelPendingMove}
                                  disabled={loading}
                                  className="inline-flex items-center rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : null}

                          {visibleStudents.length > 0 ? (
                            visibleStudents.map((student) => {
                              const selectedForMove = pendingMove?.student.special_id === student.special_id;
                              return (
                              <div key={student.special_id} className="flex items-center justify-between gap-2 rounded-lg border border-emerald-100 bg-emerald-50/40 px-3 py-2">
                                <button
                                  type="button"
                                  onClick={() => openView(student.special_id)}
                                  className="min-w-0 flex-1 text-left text-sm font-medium text-emerald-700 hover:text-emerald-800 hover:underline"
                                  title="View application"
                                >
                                  <div className="truncate">{student.student_name || "—"}</div>
                                  {student.student_number ? (
                                    <div className="text-xs text-emerald-900/70">{student.student_number}</div>
                                  ) : null}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => startStudentMove(student, r)}
                                  disabled={editing || loading}
                                  className={cls(
                                    "inline-flex h-8 w-8 items-center justify-center rounded-full border text-red-600 disabled:cursor-not-allowed disabled:opacity-50",
                                    selectedForMove ? "border-amber-300 bg-amber-100 text-amber-900" : "border-red-200 hover:bg-red-50"
                                  )}
                                  title={selectedForMove ? "Cancel move" : "Move student to another special class"}
                                  aria-label={selectedForMove ? "Cancel move" : "Move student to another special class"}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            )})
                          ) : (
                            <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                              {moveSourceRow && pendingMove
                                ? "Student is waiting to be placed in another class of this same course."
                                : r.generated_from_class_retention
                                ? "No student application. Reflected from Class Retention."
                                : r.manual_special_class
                                ? "No student application yet. You can add eligible students for this same course."
                                : "No unassigned student application in this class yet."}
                            </div>
                          )}

                          {pendingMove ? (
                            canReceiveMovedStudent(r) ? (
                              <button
                                type="button"
                                onClick={() => moveStudentHere(r)}
                                disabled={editing || loading}
                                className="inline-flex items-center gap-2 rounded-md border border-amber-500 bg-amber-200 px-3 py-2 text-sm font-semibold text-amber-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
                                title="Move the selected student into this class"
                              >
                                Move Here
                              </button>
                            ) : String(r.course_id || "") === pendingMove.courseId && !moveSourceRow ? (
                              <button
                                type="button"
                                disabled
                                className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-medium text-slate-400 disabled:cursor-not-allowed"
                                title="This class needs a section/faculty assignment first"
                              >
                                Unavailable
                              </button>
                            ) : null
                          ) : (
                            <button
                              type="button"
                              onClick={() => openInlineAssign(r)}
                              disabled={editing || loading || !r.primary_special_id}
                              className="inline-flex items-center gap-2 rounded-md border border-emerald-200 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                              title="Add a same-course student who already applied"
                            >
                              <Plus className="h-4 w-4" />
                              Add Student
                            </button>
                          )}
                        </div>
                      </td>

                      {(() => {
                        const currentSectionId = String((draft.section_id || r.section_id || "") as string).trim();
                        const selectedFacultyId = String((draft.faculty_id || "") as string).trim();
                        const peerMeetings = buildMeetingSlots({
                          day1: draft.day1 as string | undefined,
                          begin1: draft.begin1 as string | undefined,
                          end1: draft.end1 as string | undefined,
                          day2: draft.day2 as string | undefined,
                          begin2: draft.begin2 as string | undefined,
                          end2: draft.end2 as string | undefined,
                        });
                        const slot1PeerMeetings = peerMeetings.filter((m) => m.slot !== 1);
                        const slot2PeerMeetings = peerMeetings.filter((m) => m.slot !== 2);
                        const availableFacultyNames = facultyNames.filter((name) => {
                          if (name === "UNASSIGNED") return true;
                          const fid = facultyNameToIdUpper[name.toUpperCase()] || "";
                          if (!fid) return false;
                          return !facultyHasConflictForMeetings({
                            facultyId: fid,
                            meetings: peerMeetings,
                            busySlots: facultyAvailability,
                            excludeSectionId: currentSectionId,
                          });
                        });
                        const availableDay1Options = DAY_OPTS_LABELS.filter((label) =>
                          slotOptionIsAvailable({
                            facultyId: selectedFacultyId,
                            day: DAY_FROM_LABEL[label],
                            begin: String(draft.begin1 || ""),
                            peerMeetings: slot1PeerMeetings,
                            busySlots: facultyAvailability,
                            excludeSectionId: currentSectionId,
                          })
                        );
                        const availableBegin1Options = GE_TIME_SLOTS.filter((slot) =>
                          slotOptionIsAvailable({
                            facultyId: selectedFacultyId,
                            day: String(draft.day1 || ""),
                            begin: slot.start,
                            peerMeetings: slot1PeerMeetings,
                            busySlots: facultyAvailability,
                            excludeSectionId: currentSectionId,
                          })
                        );
                        const availableDay2Options = DAY_OPTS_LABELS.filter((label) =>
                          slotOptionIsAvailable({
                            facultyId: selectedFacultyId,
                            day: DAY_FROM_LABEL[label],
                            begin: String(draft.begin2 || ""),
                            peerMeetings: slot2PeerMeetings,
                            busySlots: facultyAvailability,
                            excludeSectionId: currentSectionId,
                          })
                        );
                        const availableBegin2Options = GE_TIME_SLOTS.filter((slot) =>
                          slotOptionIsAvailable({
                            facultyId: selectedFacultyId,
                            day: String(draft.day2 || ""),
                            begin: slot.start,
                            peerMeetings: slot2PeerMeetings,
                            busySlots: facultyAvailability,
                            excludeSectionId: currentSectionId,
                          })
                        );

                        return (
                          <>
                            <td className="px-4 py-3 text-center">
                              {editing ? (
                                <div className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700">
                                  {(draft.section_code || r.section_code || "—") as string}
                                </div>
                              ) : (
                                <div className="font-medium">{r.section_code?.trim() ? r.section_code : "—"}</div>
                              )}
                            </td>

                            <td className="px-4 py-3 min-w-[240px] align-top">
                              {editing ? (
                                <ComboSelect
                                  value={facultyInput?.trim() ? facultyInput : ""}
                                  onChange={(v) => {
                                    if (!canEditFacultySchedule) return;
                                    const t = (v || "").trim();
                                    if (t === "" || t.toUpperCase() === "UNASSIGNED") {
                                      setFacultyInput("");
                                      setDraft((d) => ({ ...d, faculty_id: null }));
                                      return;
                                    }
                                    setFacultyInput(t);
                                    const fid = facultyNameToIdUpper[t.toUpperCase()] || "";
                                    setDraft((d) => ({ ...d, faculty_id: fid ? fid : null }));
                                  }}
                                  options={["", "UNASSIGNED", ...availableFacultyNames.filter((n) => n !== "UNASSIGNED")]}
                                  placeholder={facultyNames.length > 1 ? (availableFacultyNames.length > 1 ? "Select Faculty" : "No available faculty") : "Loading…"}
                                  disabled={!canEditFacultySchedule}
                                />
                              ) : (
                                <div className="font-medium">{r.faculty_name || "UNASSIGNED"}</div>
                              )}
                            </td>

                            {editing ? (
                              <>
                                <td className="px-4 py-3 align-top min-w-[620px]" colSpan={2}>
                                  <div className="rounded-xl border border-neutral-200 bg-white px-4 py-4">
                                    <div className="space-y-5">
                                      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                                        Section stays blank here until APO assigns the section and room. OM/CHAIR can still save faculty, schedule, status, and remarks.
                                      </div>
                                      <div className="space-y-2">
                                        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                                          <div className="space-y-1.5">
                                            <div className="text-[12px] font-semibold text-emerald-800">Day 1</div>
                                            <SelectBox
                                              disabled={!canEditFacultySchedule}
                                              value={draft.day1 ? DAY_LABELS[draft.day1 as DayCode] : DAY_PLACEHOLDER}
                                              onChange={(lbl) => {
                                                const nextDay1 = lbl === DAY_PLACEHOLDER ? "" : (DAY_FROM_LABEL[lbl as DayLabel] || "M");
                                                const autoDay2 = nextDay1 ? (DAY_PAIR[nextDay1] || "") : "";
                                                setDraft((d) => {
                                                  const next = { ...d, day1: nextDay1 as any, day2: autoDay2 as any };
                                                  if (selectedFacultyId && String(next.begin1 || "") && nextDay1 && !slotOptionIsAvailable({ facultyId: selectedFacultyId, day: nextDay1, begin: String(next.begin1 || ""), peerMeetings: slot1PeerMeetings, busySlots: facultyAvailability, excludeSectionId: currentSectionId })) {
                                                    next.begin1 = "";
                                                    next.end1 = "";
                                                  }
                                                  if (selectedFacultyId && String(next.begin2 || "") && autoDay2 && !slotOptionIsAvailable({ facultyId: selectedFacultyId, day: autoDay2, begin: String(next.begin2 || ""), peerMeetings: slot2PeerMeetings, busySlots: facultyAvailability, excludeSectionId: currentSectionId })) {
                                                    next.begin2 = "";
                                                    next.end2 = "";
                                                  }
                                                  return next;
                                                });
                                              }}
                                              options={[DAY_PLACEHOLDER, ...(selectedFacultyId ? availableDay1Options : DAY_OPTS_LABELS)]}
                                            />
                                          </div>

                                          <div className="space-y-1.5">
                                            <div className="text-[12px] font-semibold text-emerald-800">Begin 1</div>
                                            <SelectBox
                                              disabled={!canEditFacultySchedule}
                                              value={prettyHHMM(draft.begin1 || "") || "Select time…"}
                                              onChange={(band) => {
                                                if (band === "Select time…") {
                                                  setSlotFromBand(1, "");
                                                  return;
                                                }
                                                setSlotFromBand(1, band);
                                              }}
                                              options={["Select time…", ...(selectedFacultyId ? availableBegin1Options : GE_TIME_SLOTS).map((x) => x.label)]}
                                            />
                                          </div>

                                          <div className="space-y-1.5">
                                            <div className="text-[12px] font-semibold text-emerald-800">End 1</div>
                                            <input
                                              value={prettyHHMM(draft.end1 || "")}
                                              disabled
                                              className={cls(
                                                "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                                "bg-gray-100 text-gray-700 cursor-not-allowed"
                                              )}
                                            />
                                          </div>
                                        </div>
                                      </div>

                                      <div className="space-y-2 border-t border-neutral-200 pt-5">
                                        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                                          <div className="space-y-1.5">
                                            <div className="text-[12px] font-semibold text-emerald-800">Day 2</div>
                                            <SelectBox
                                              disabled={!canEditFacultySchedule}
                                              value={draft.day2 ? DAY_LABELS[draft.day2 as DayCode] : DAY_PLACEHOLDER}
                                              onChange={(lbl) => {
                                                const nextDay2 = lbl === DAY_PLACEHOLDER ? "" : (DAY_FROM_LABEL[lbl as DayLabel] || "M");
                                                setDraft((d) => {
                                                  const next = { ...d, day2: nextDay2 as any };
                                                  if (selectedFacultyId && String(next.begin2 || "") && nextDay2 && !slotOptionIsAvailable({ facultyId: selectedFacultyId, day: nextDay2, begin: String(next.begin2 || ""), peerMeetings: slot2PeerMeetings, busySlots: facultyAvailability, excludeSectionId: currentSectionId })) {
                                                    next.begin2 = "";
                                                    next.end2 = "";
                                                  }
                                                  return next;
                                                });
                                              }}
                                              options={[DAY_PLACEHOLDER, ...(selectedFacultyId ? availableDay2Options : DAY_OPTS_LABELS)]}
                                            />
                                          </div>

                                          <div className="space-y-1.5">
                                            <div className="text-[12px] font-semibold text-emerald-800">Begin 2</div>
                                            <SelectBox
                                              disabled={!canEditFacultySchedule}
                                              value={prettyHHMM(draft.begin2 || "") || "Select time…"}
                                              onChange={(band) => {
                                                if (band === "Select time…") {
                                                  setSlotFromBand(2, "");
                                                  return;
                                                }
                                                setSlotFromBand(2, band);
                                              }}
                                              options={["Select time…", ...(selectedFacultyId ? availableBegin2Options : GE_TIME_SLOTS).map((x) => x.label)]}
                                            />
                                          </div>

                                          <div className="space-y-1.5">
                                            <div className="text-[12px] font-semibold text-emerald-800">End 2</div>
                                            <input
                                              value={prettyHHMM(draft.end2 || "")}
                                              disabled
                                              className={cls(
                                                "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                                "bg-gray-100 text-gray-700 cursor-not-allowed"
                                              )}
                                            />
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </td>

                                <td className="px-4 py-3 align-top min-w-[180px]">
                                  <div className="space-y-1.5 text-center leading-5 whitespace-nowrap">
                                    {buildScheduleSlotViews(draft).map((slot) => (
                                      <div key={slot.key}>{slot.time}</div>
                                    ))}
                                  </div>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="px-4 py-3 align-top min-w-[180px]">
                                  <div className="space-y-1.5 text-center leading-5 whitespace-nowrap">
                                    {buildScheduleSlotViews(r).map((slot) => (
                                      <div key={slot.key}>{slot.day}</div>
                                    ))}
                                  </div>
                                </td>
                                <td className="px-4 py-3 align-top min-w-[180px]">
                                  <div className="space-y-1.5 text-center leading-5 whitespace-nowrap">
                                    {buildScheduleSlotViews(r).map((slot) => (
                                      <div key={slot.key}>{slot.time}</div>
                                    ))}
                                  </div>
                                </td>
                              </>
                            )}
                          </>
                        );
                      })()}

                      <td className="px-4 py-3 align-top min-w-[180px]">
                        <div className="space-y-1.5 text-center leading-5 whitespace-nowrap">
                          {roomCellItems(r).map((item) => (
                            <span key={item.key} title={item.title} className="block">
                              {item.label}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="px-4 py-3 text-center whitespace-nowrap">
                        {editing ? (
                          <SelectBox
                            value={(draft.status || r.status || "") as string}
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
                          <textarea
                            value={(draft.remarks || "") as string}
                            onChange={(e) => setDraft((d) => ({ ...d, remarks: e.target.value }))}
                            rows={3}
                            className={cls(
                              "w-full min-w-[180px] rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm resize-none",
                              "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition"
                            )}
                          />
                        ) : (
                          <span className="block whitespace-pre-wrap text-gray-700">
                            {r.remarks || <span className="text-gray-400">—</span>}
                          </span>
                        )}
                      </td>

                      <td className="px-2 py-3 whitespace-nowrap text-center">
                        {!hideMessageIcon ? (() => {
                          const messageTarget = r.students.find((student) => !!student.faculty_id) || null;
                          return (
                            <button
                              type="button"
                              onClick={() => {
                                if (!messageTarget) return;
                                setConv({
                                  open: true,
                                  termId: String(messageTarget.term_id || r.term_id || ""),
                                  facultyId: messageTarget.faculty_id ?? r.faculty_id ?? null,
                                  facultyName: messageTarget.faculty_name || r.faculty_name || "UNASSIGNED",
                                  sectionId: messageTarget.special_id,
                                });
                              }}
                              disabled={!messageTarget || editing}
                              className={cls(
                                "relative inline-flex items-center justify-center p-1 rounded-md text-blue-700 hover:bg-blue-50",
                                (!messageTarget || editing) && "opacity-50 cursor-not-allowed hover:bg-transparent"
                              )}
                              title={messageTarget ? "Message" : "Assign a faculty first to open conversation"}
                              aria-label="Message"
                            >
                              <MessageSquareText className="h-4 w-4" />
                              {Boolean((r as any)?.rfc_needs_om) && (
                                <span
                                  className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-red-600"
                                  aria-label="New message"
                                  title="New message"
                                />
                              )}
                            </button>
                          );
                        })() : null}
                      </td>

                      <td className="px-2 py-3 whitespace-nowrap text-center">
                        {editing ? (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={saveEdit}
                              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                              title="Save"
                              aria-label="Save"
                            >
                              <Check className="h-4 w-4" />
                            </button>

                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                              title="Cancel"
                              aria-label="Cancel"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => beginEdit(r)}
                              className="inline-flex items-center justify-center p-1 rounded-md text-emerald-700 hover:bg-emerald-50"
                              title="Edit"
                              aria-label="Edit"
                            >
                              <Edit className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteSpecialClassRow(r)}
                              disabled={loading || assignInlineOpen}
                              className="inline-flex items-center justify-center p-1 rounded-md text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                              title="Delete special class"
                              aria-label="Delete special class"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>

                    {assignInlineOpen && inlineAssignState ? (
                      <tr className="bg-emerald-50/40">
                        <td colSpan={13} className="border-t border-emerald-100 px-4 py-4">
                          <div className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="text-base font-semibold text-emerald-800">
                                  Add Student to Class
                                </div>
                                <div className="text-sm text-gray-600">
                                  {inlineAssignState.courseLabel} • {inlineAssignState.sectionLabel || "—"}
                                </div>
                              </div>
                            </div>

                            <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                              <div className="space-y-1.5">
                                <div className="text-sm font-medium text-gray-700">
                                  Eligible student
                                </div>
                                {inlineAssignState.loading ? (
                                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">Loading eligible students…</div>
                                ) : inlineAssignState.candidates.length === 0 ? (
                                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                                    No students are available for this course right now.
                                  </div>
                                ) : (
                                  <SelectBox
                                    value={(inlineAssignState.candidates.find((candidate) => candidate.special_id === inlineAssignState.selectedStudentId)
                                      ? candidateLabel(inlineAssignState.candidates.find((candidate) => candidate.special_id === inlineAssignState.selectedStudentId)!)
                                      : "")}
                                    onChange={(v) => {
                                      const match = inlineAssignState.candidates.find((candidate) => candidateLabel(candidate) === v);
                                      setInlineAssignState((current) => current ? { ...current, selectedStudentId: match?.special_id || "" } : current);
                                    }}
                                    options={inlineAssignState.candidates.map((candidate) => candidateLabel(candidate))}
                                  />
                                )}
                              </div>

                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={closeInlineAssign}
                                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={inlineAssignState.loading || !inlineAssignState.selectedStudentId}
                                  onClick={confirmInlineAssign}
                                  className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                                >
                                  Add Student
                                </button>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>


      {viewOpen && (
        <div className="fixed inset-0 z-[125] flex items-center justify-center bg-black/40 px-4 py-6">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
            <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
              <div>
                <div className="text-lg font-semibold text-slate-900">Special Class Application</div>
                <div className="mt-1 text-sm text-slate-500">
                  {viewData?.student_name || "View submitted details"}
                </div>
              </div>
              <button
                type="button"
                onClick={closeView}
                className="rounded-lg p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close application detail"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-[calc(90vh-88px)] overflow-y-auto px-5 py-4">
              {viewLoading ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
                  Loading application details…
                </div>
              ) : viewErr ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700">
                  {viewErr}
                </div>
              ) : viewData ? (
                <div className="space-y-6">
                  <section>
                    <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Application</div>
                    <div className="rounded-xl border border-gray-200 bg-white px-4">
                      <DetailRow label="Student" value={viewData.student_name} />
                      <DetailRow label="Student Number" value={viewData.student_number} />
                      <DetailRow label="Status" value={viewData.status} />
                      <DetailRow label="Submitted" value={formatDate(viewData.submitted_at)} />
                      <DetailRow label="Updated" value={formatDate(viewData.updated_at)} />
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Course and class</div>
                    <div className="rounded-xl border border-gray-200 bg-white px-4">
                      <DetailRow label="Course Code" value={viewData.course_code} />
                      <DetailRow label="Course Title" value={viewData.course_title} />
                      <DetailRow label="Section" value={viewData.section_code} />
                      <DetailRow label="Faculty" value={viewData.faculty_name} />
                      <DetailRow label="Schedule" value={viewData.schedule_text} />
                      <DetailRow label="Remarks" value={viewData.remarks} />
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Student details</div>
                    <div className="rounded-xl border border-gray-200 bg-white px-4">
                      <DetailRow label="Department" value={viewData.department_name} />
                      <DetailRow label="Course Units" value={viewData.course_units} />
                      <DetailRow label="Units Remaining" value={viewData.units_remaining} />
                      <DetailRow label="Graduating After Term" value={viewData.graduating_after_term} />
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 flex items-center justify-between gap-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                      <span>Attached EAF</span>
                      {viewData.eaf_view_url ? (
                        <button
                          type="button"
                          onClick={() => openEaf(viewData.eaf_view_url)}
                          className="inline-flex items-center rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold normal-case tracking-normal text-white hover:bg-emerald-800"
                        >
                          Open EAF
                        </button>
                      ) : null}
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white px-4">
                      <DetailRow label="Uploaded" value={viewData.has_eaf ? 'Yes' : 'No'} />
                      <DetailRow label="Filename" value={viewData.eaf_original_name} />
                      <DetailRow label="Content Type" value={viewData.eaf_content_type} />
                      <DetailRow label="File Size" value={viewData.eaf_size ? `${viewData.eaf_size} bytes` : ''} />
                      <DetailRow label="Uploaded At" value={formatDate(viewData.eaf_uploaded_at)} />
                    </div>
                  </section>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
                  No application details available.
                </div>
              )}
            </div>
          </div>
        </div>
      )}


      {confirmState && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
            <div className={cls("flex items-start gap-3 px-5 py-4 text-white", confirmState.accent === "amber" ? "bg-amber-600" : "bg-emerald-700")}>
              <div className="mt-0.5 rounded-full bg-white/15 p-2">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold">{confirmState.title}</div>
                {confirmState.note && <div className="mt-1 text-sm text-white/85">{confirmState.note}</div>}
              </div>
              <button type="button" onClick={() => closeConfirm(false)} className="rounded-lg p-1 text-white/90 transition hover:bg-white/10" aria-label="Close confirmation">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-5 py-4 text-sm whitespace-pre-line text-slate-700">{confirmState.message}</div>
            <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-4">
              <button type="button" onClick={() => closeConfirm(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-gray-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => closeConfirm(true)}
                className={cls("rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm", confirmState.accent === "amber" ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-700 hover:bg-emerald-800")}
              >
                {confirmState.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Special Class conversation (RFC thread) */}
      {!hideMessageIcon && (
      <SpecialConversationModal
        open={!!conv?.open}
        onClose={() => setConv(null)}
        userId={userId}
        termId={conv?.termId || ""}
        facultyId={conv?.facultyId}
        facultyName={conv?.facultyName}
        sectionId={conv?.sectionId}
        onToast={toast}
      />
      )}
    </main>
  );
}
