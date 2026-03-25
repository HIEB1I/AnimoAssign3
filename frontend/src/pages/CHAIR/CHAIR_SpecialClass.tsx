import { useEffect, useMemo, useRef, useState } from "react";
import { Search as SearchIcon, Edit, Check, ChevronDown, X, Download, MessageSquareText, Send, AlertTriangle, CalendarClock, Info } from "lucide-react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import { getSessionUserId } from "../../lib/session";
import {
  getChairSCOptions,
  listChairSC,
  updateChairSC,
  getChairSC_SchedulePresets,
  getChairSC_Detail,
  exportChairSC_Pdf,
  getOmLoadAssignmentRfc,
  respondOmLoadAssignmentRfc,
  downloadBlob,
  type ChairSpecialClassRow,
  type ChairSpecialClassOptions,
  type ChairSCSchedulePreset,
  type ChairSpecialClassDetail,
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
              The Operations Manager has not set a submission deadline for this term yet.
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

function scheduleTextFromRow(r: Partial<ChairSpecialClassRow>) {
  const parts: string[] = [];
  if (r.day1 && r.begin1 && r.end1) parts.push(`${r.day1} ${r.begin1}-${r.end1}`);
  if (r.day2 && r.begin2 && r.end2) parts.push(`${r.day2} ${r.begin2}-${r.end2}`);
  return parts.join("; ");
}


type ScheduleSlotView = {
  key: string;
  day: string;
  time: string;
};

function buildScheduleSlotViews(r: Partial<ChairSpecialClassRow>) {
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

const CLEAR_SCHEDULE_LABEL = "Clear schedule";
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
  rfc_needs_chair?: boolean;
  term_id: string;
};

type SpecialClassGroupRow = Partial<ChairSpecialClassRow> & {
  group_key: string;
  primary_special_id: string;
  special_ids: string[];
  count: number;
  students: SpecialClassGroupStudent[];
};

function buildGroupedRows(input: ChairSpecialClassRow[]): SpecialClassGroupRow[] {
  const groups = new Map<string, ChairSpecialClassRow[]>();
  input.forEach((row) => {
    const key = String(row.course_id || `${row.course_code || ''}|${row.course_title || ''}`).trim();
    if (!key) return;
    const arr = groups.get(key) || [];
    arr.push(row);
    groups.set(key, arr);
  });

  const uniq = (vals: Array<any>) => Array.from(new Set(vals.map((v) => String(v ?? '').trim())));
  const consensusText = (rows: ChairSpecialClassRow[], pick: (r: ChairSpecialClassRow) => any, mixedLabel = 'Multiple') => {
    const vals = uniq(rows.map(pick));
    if (vals.length <= 1) return vals[0] || '';
    return mixedLabel;
  };
  const consensusNullable = (rows: ChairSpecialClassRow[], pick: (r: ChairSpecialClassRow) => any) => {
    const vals = uniq(rows.map(pick));
    return vals.length <= 1 ? (vals[0] || null) : null;
  };
  const consensusSchedule = (rows: ChairSpecialClassRow[], key: keyof ChairSpecialClassRow) => {
    const vals = uniq(rows.map((r) => (r as any)[key]));
    return vals.length <= 1 ? (vals[0] || '') : '';
  };

  return Array.from(groups.entries())
    .map(([groupKey, items]) => {
      const rows = [...items].sort((a, b) => String(a.student_name || '').localeCompare(String(b.student_name || '')));
      const first = rows[0];
      const statuses = uniq(rows.map((r) => r.status));
      const status = statuses.length <= 1 ? (statuses[0] || '') : 'Mixed';
      const remarks = consensusText(rows, (r) => r.remarks, '');
      const facultyId = consensusNullable(rows, (r) => r.faculty_id) as string | null;
      return {
        ...first,
        group_key: groupKey,
        primary_special_id: String(first.special_id || ''),
        special_ids: rows.map((r) => String(r.special_id || '')).filter(Boolean),
        count: rows.length,
        students: rows.map((r) => ({
          special_id: String(r.special_id || ''),
          student_name: String(r.student_name || ''),
          student_number: r.student_number,
          faculty_id: r.faculty_id ?? null,
          faculty_name: r.faculty_name,
          rfc_needs_chair: Boolean((r as any).rfc_needs_chair),
          term_id: String(r.term_id || ''),
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
        rfc_needs_chair: rows.some((r) => Boolean((r as any).rfc_needs_chair)),
      } as SpecialClassGroupRow;
    })
    .sort((a, b) => String(a.course_code || '').localeCompare(String(b.course_code || '')) || String(a.course_title || '').localeCompare(String(b.course_title || '')));
}

export default function CHAIR_SpecialClass({ hideMessageIcon = false }: { hideMessageIcon?: boolean } = {}) {
  const [status, setStatus] = useState("All Status");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");

  const [exportOpen, setExportOpen] = useState(false);

  const [statuses, setStatuses] = useState<string[]>(["All Status"]);
  const [activeTermLabel, setActiveTermLabel] = useState<string>("");
  const [submissionWindow, setSubmissionWindow] = useState<{ openISO: string; deadlineISO: string }>({ openISO: "", deadlineISO: "" });

  // Faculty
  const [facultyNames, setFacultyNames] = useState<string[]>(["UNASSIGNED"]);
  const [facultyNameToIdUpper, setFacultyNameToIdUpper] = useState<Record<string, string>>({});

  // Rooms (read-only display)
  const [roomIdToInfo, setRoomIdToInfo] = useState<
    Record<
      string,
      { room_number: string; building?: string; capacity?: number; room_type?: string; campus_id?: string }
    >
  >({});

  // table
  const [rows, setRows] = useState<ChairSpecialClassRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [errKind, setErrKind] = useState<"success" | "error">("error");

  // selection
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // edit
  const [editId, setEditId] = useState<string | null>(null);
  const [editTargetIds, setEditTargetIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<Partial<ChairSpecialClassRow>>({});
  const [facultyInput, setFacultyInput] = useState<string>("");

  // presets
  const [presets, setPresets] = useState<ChairSCSchedulePreset[]>([]);
  const [presetChoice, setPresetChoice] = useState<string>("CUSTOM"); 
  const [clearMode, setClearMode] = useState<"none" | "schedule" | "all">("none");
  const [didClearAll, setDidClearAll] = useState(false);

  // view modal
  const [viewOpen, setViewOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewErr, setViewErr] = useState("");
  const [viewData, setViewData] = useState<ChairSpecialClassDetail | null>(null);

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

  const toast = (message: string, kind?: "success" | "error") => {
    setErrKind(kind === "success" ? "success" : "error");
    setErr(message);
    if (kind === "success") window.setTimeout(() => setErr(""), 2500);
  };

  const roomLabel = (r: Partial<ChairSpecialClassRow>, slot: 1 | 2) => {
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

  const roomTitle = (r: Partial<ChairSpecialClassRow>, slot: 1 | 2) => {
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

  const roomCellItems = (r: Partial<ChairSpecialClassRow>): RoomCellItem[] => {
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
        key: "room-empty",
        label: "TBA",
      },
    ];
  };


  // load options
  useEffect(() => {
    (async () => {
      try {
        const opt: ChairSpecialClassOptions = await getChairSCOptions();
        if (!opt.ok) throw new Error("Failed to load options");
        setStatuses(["All Status", ...(opt.statuses || [])]);

        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setActiveTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");
        const win = opt.submission_window || {};
        const nextWindow = { openISO: win.openISO || "", deadlineISO: win.deadlineISO || "" };
        setSubmissionWindow(nextWindow);

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

        // rooms map for display-only columns
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
    })();
  }, []);

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
      const res = await listChairSC({ status, q });
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
        const blob = await exportChairSC_Pdf({ special_ids: [id] });
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

    const scheduleForRow = (r: ChairSpecialClassRow) => {
      const parts: string[] = [];
      if (r.day1 && r.begin1 && r.end1) parts.push(`${r.day1} ${prettyHHMM(r.begin1)}-${prettyHHMM(r.end1)}`);
      if (r.day2 && r.begin2 && r.end2) parts.push(`${r.day2} ${prettyHHMM(r.begin2)}-${prettyHHMM(r.end2)}`);
      return parts.join("; ");
    };

    const roomForRow = (r: ChairSpecialClassRow) => {
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


  const presetOptions = useMemo(() => {
    const base = presets.map((p) => {
      const sec = (p.section_code || "").trim();
      const head = sec ? `${sec} · ${p.label}` : p.label;
      return `${head} · ${p.faculty_name || "UNASSIGNED"}`;
    });
    return ["Custom", CLEAR_SCHEDULE_LABEL, ...base];
  }, [presets]);

  const presetLabelToId = useMemo(() => {
    const m: Record<string, string> = {};
    presets.forEach((p) => {
      const sec = (p.section_code || "").trim();
      const head = sec ? `${sec} · ${p.label}` : p.label;
      m[`${head} · ${p.faculty_name || "UNASSIGNED"}`] = p.schedule_id;
    });
    return m;
  }, [presets]);

  const applyPreset = (scheduleId: string) => {
    setDidClearAll(false);

    // Choosing a preset cancels any previous clear-schedule intent
    setClearMode("none");

    if (scheduleId === "CUSTOM") {
      setPresetChoice("CUSTOM");
      setDraft((d) => ({
        ...d,
        section_id: null,
      }));
      return;
    }

    const p = presets.find((x) => x.schedule_id === scheduleId);
    if (!p) return;

    setPresetChoice(scheduleId);

    setDraft((d) => ({
      ...d,
      section_id: p.section_id,
      section_code: p.section_code || "",
      day1: (p.day1 || "") as any,
      begin1: p.begin1 || "",
      end1: p.end1 || "",
      day2: (p.day2 || "") as any,
      begin2: p.begin2 || "",
      end2: p.end2 || "",
      faculty_id: p.faculty_id ?? null,
    }));

    setFacultyInput(p.faculty_name && p.faculty_name !== "UNASSIGNED" ? p.faculty_name : "");
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

    try {
      const res = await getChairSC_SchedulePresets(row.course_id || "");
      setPresets(res.presets || []);
      const match = (res.presets || []).find((p) => p.section_id === row.section_id);

      const rowHasNoSchedule =
        !!row.section_id && !(row.day1 || row.begin1 || row.end1 || row.day2 || row.begin2 || row.end2);

      if (rowHasNoSchedule) {
        setPresetChoice("CLEAR_SCHEDULE");
        setClearMode("schedule");
      } else {
        setPresetChoice(match ? match.schedule_id : "CUSTOM");
      }
    } catch {
      setPresets([]);
      setPresetChoice("CUSTOM");
    }
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
        ? { begin1: found.start, end1: found.end, day1: (d.day1 as any) || "M" }
        : { begin2: found.start, end2: found.end, day2: (d.day2 as any) || "M" }),
    }));
  };



  const clearScheduleOnlyDraft = () => {
    setDidClearAll(false);
    setDraft((d) => ({
      ...d,
      day1: "" as any,
      begin1: "",
      end1: "",
      day2: "" as any,
      begin2: "",
      end2: "",
      schedule_id1: null,
      schedule_id2: null,
    }));
  };

  const cancelEdit = () => {
    setEditId(null);
    setEditTargetIds([]);
    setDraft({});
    setPresets([]);
    setPresetChoice("CUSTOM");
    setFacultyInput("");
    setDidClearAll(false);
    setClearMode("none");
  };

  const saveEdit = async () => {
    if (!editId || editTargetIds.length === 0) return;

    try {
      setLoading(true);
      setErr("");

      const isCustom = presetChoice === "CUSTOM";

      // NOTE: rooms are DISPLAY ONLY (no edits)
      const payload: any = {
        status: draft.status,
        remarks: draft.remarks,
      };

      if (didClearAll) {
        // Clear icon: clear EVERYTHING (faculty, section, schedule/day/time)
        payload.section_id = ""; // backend interprets empty section_id as clear-all
        payload.section_code = "";
        payload.faculty_id = null;

        payload.day1 = "";
        payload.begin1 = "";
        payload.end1 = "";
        payload.day2 = "";
        payload.begin2 = "";
        payload.end2 = "";
      } else {
        let payloadFacultyId: string | null = null;
        if (isCustom) {
          const typedName = (facultyInput || "").trim();
          const fid =
            typedName && typedName.toUpperCase() !== "UNASSIGNED"
              ? facultyNameToIdUpper[typedName.toUpperCase()] || ""
              : "";
          payloadFacultyId = fid ? fid : null;
        }

        payload.section_id = isCustom ? null : draft.section_id || null;
        payload.section_code = isCustom ? draft.section_code || "" : "";
        if (isCustom) payload.faculty_id = payloadFacultyId;

        if (clearMode === "schedule") {
          payload.clear_schedule_only = true;
          payload.section_id = draft.section_id || payload.section_id;
        }

        if (isCustom) {
          payload.day1 = (draft.day1 || "") as any;
          payload.begin1 = draft.begin1 || "";
          payload.end1 = draft.end1 || "";
          payload.day2 = (draft.day2 || "") as any;
          payload.begin2 = draft.begin2 || "";
          payload.end2 = draft.end2 || "";
        }
      }

      for (const specialId of editTargetIds) {
        await updateChairSC(specialId, payload, getSessionUserId());
      }

      setEditId(null);
      setDraft({});
      setPresets([]);
      setPresetChoice("CUSTOM");
      setFacultyInput("");
      setDidClearAll(false);
      await load();
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
      const res = await getChairSC_Detail(specialId);
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

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-4">
        <div>
          <h1 className="text-2xl font-bold">Special Class</h1>
          <p className="text-sm text-gray-600">
            Review Special Class applications {activeTermLabel && `for ${activeTermLabel}`}
          </p>
        </div>
      </header>

      <DeadlineBanner deadlineISO={submissionWindow.deadlineISO} className="mb-6" />

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

        <div className="relative">
          <button
            type="button"
            onClick={() => setExportOpen((v) => !v)}
            disabled={loading}
            title="Export"
            className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
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

      <div className="table-wrapper w-full overflow-hidden">
        <div className="border border-gray-200 bg-white shadow-sm overflow-auto rounded-xl">
          <table className="w-full text-sm table-auto">
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

                <th className="text-left px-4 py-2 whitespace-nowrap">Course Code &amp; Title</th>
                <th className="text-center px-4 py-2 whitespace-nowrap">Count</th>
                <th className="text-left px-4 py-2 whitespace-nowrap">Students</th>
                <th className="text-center px-4 py-2 whitespace-nowrap">Section</th>
                <th className="text-left px-4 py-2 whitespace-nowrap">Faculty</th>

                <th className="text-center px-3 py-2 whitespace-nowrap min-w-[90px]">Day</th>
                <th className="text-center px-3 py-2 whitespace-nowrap min-w-[140px]">Time</th>
                <th className="text-center px-3 py-2 whitespace-nowrap min-w-[90px]">Room</th>

                <th className="text-center px-4 py-2 whitespace-nowrap">Status</th>
                <th className="text-left px-4 py-2 whitespace-nowrap">Remarks</th>
                <th className="w-12 px-2 py-2 text-center whitespace-nowrap"></th>
                <th className="w-12 px-2 py-2 text-center whitespace-nowrap"></th>
              </tr>
            </thead>

            <tbody className="divide-y">
              {loading ? (
                <tr>
                  <td className="px-4 py-6 text-center text-gray-500" colSpan={13}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-gray-500" colSpan={13}>
                    No results
                  </td>
                </tr>
              ) : (
                groupedRows.map((r) => {
                  const editing = editId === r.group_key;
                  const isCustom = presetChoice === "CUSTOM";
                  const canEditSectionFaculty = isCustom || presetChoice === "CLEAR_SCHEDULE";

                  return (
                    <tr key={r.special_id} className="hover:bg-gray-50 align-top">
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={!!selectedIds[r.group_key]}
                          onChange={(e) => toggleOne(r.group_key, e.target.checked)}
                          className="h-4 w-4 accent-emerald-600"
                          disabled={loading}
                        />
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-semibold text-emerald-700">{r.course_code || "—"}</div>
                        <div className="text-xs text-gray-500">{r.course_title || ""}</div>
                      </td>

                      <td className="px-4 py-3 text-center align-top">
                        <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                          {r.count}
                        </span>
                      </td>

                      <td className="px-4 py-3 align-top">
                        <div className="space-y-1.5 min-w-[220px]">
                          {r.students.map((student) => (
                            <button
                              key={student.special_id}
                              type="button"
                              onClick={() => openView(student.special_id)}
                              className="block text-left text-sm font-medium text-emerald-700 hover:text-emerald-800 hover:underline"
                              title="View application"
                            >
                              {student.student_name || "—"}
                            </button>
                          ))}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        {editing ? (
                          canEditSectionFaculty ? (
                            <input
                              value={(draft.section_code || "") as string}
                              onChange={(e) => {
                                if (presetChoice === "CLEAR_SCHEDULE") {
                                  setClearMode("none");
                                  setPresetChoice("CUSTOM");
                                }
                                setDraft((d) => ({ ...d, section_id: null, section_code: e.target.value }));
                              }}
                              placeholder=" "
                              className={cls(
                                "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
                                "min-w-[60px]"
                              )}
                            />
                          ) : (
                            <div className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700">
                              {(draft.section_code || r.section_code || "—") as string}
                            </div>
                          )
                        ) : (
                          <div className="font-medium">{r.section_code?.trim() ? r.section_code : "—"}</div>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        {editing ? (
                          <ComboSelect
                            value={facultyInput?.trim() ? facultyInput : ""}
                            onChange={(v) => {
                              if (!canEditSectionFaculty) return;

                              // If the row is in "Clear schedule" mode, switching faculty means you want Custom mode.
                              if (presetChoice === "CLEAR_SCHEDULE") {
                                setClearMode("none");
                                setPresetChoice("CUSTOM");
                                setDraft((d) => ({ ...d, section_id: null }));
                              }

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
                            options={["", "UNASSIGNED", ...facultyNames.filter((n) => n !== "UNASSIGNED")]}
                            placeholder="Select Faculty"
                            disabled={!canEditSectionFaculty}
                          />
                        ) : (
                          <div className="font-medium">{r.faculty_name || "UNASSIGNED"}</div>
                        )}

                      </td>
                      {/* Schedule columns */}
                      {editing ? (
                        <>
                          <td className="px-3 py-3 align-top">
                            <div className="space-y-2 min-w-[320px]">
                              <SelectBox
                                value={
                                  presetChoice === "CUSTOM"
                                    ? "Custom"
                                    : presetChoice === "CLEAR_SCHEDULE"
                                    ? CLEAR_SCHEDULE_LABEL
                                    : (() => {
                                        const p = presets.find((x) => x.schedule_id === presetChoice);
                                        if (!p) return "Custom";
                                        const sec = (p.section_code || "").trim();
                                        const head = sec ? `${sec} · ${p.label}` : p.label;
                                        return `${head} · ${p.faculty_name || "UNASSIGNED"}`;
                                      })()
                                }
                                onChange={(label) => {
                                  setDidClearAll(false);

                                  if (label === CLEAR_SCHEDULE_LABEL) {
                                    setPresetChoice("CLEAR_SCHEDULE");
                                    setClearMode("schedule");
                                    clearScheduleOnlyDraft();
                                    return;
                                  }

                                  setClearMode("none");

                                  if (label === "Custom") {
                                    setPresetChoice("CUSTOM");
                                    setDraft((d) => ({
                                      ...d,
                                      section_id: null,
                                      section_code: d.section_code || "",
                                      day1: (d.day1 as any) || "M",
                                      day2: (d.day2 as any) || "M",
                                    }));
                                    return;
                                  }

                                  const sid = presetLabelToId[label] || "";
                                  if (sid) applyPreset(sid);
                                }}
                                options={presetOptions}
                              />

                              {presetChoice === "CUSTOM" ? (
                                <div className="rounded-lg border border-gray-200 bg-white p-3">
                                  <div className="text-xs text-gray-600 mb-2">
                                    Custom Schedule (max 2 entries). Begin uses preset time slots and auto-fills End.
                                  </div>

                                  <div className="grid grid-cols-[minmax(140px,1fr)_minmax(140px,1fr)_minmax(80px,100px)] gap-2 items-center mb-2 min-w-0">
                                    <SelectBox
                                      value={draft.day1 ? DAY_LABELS[draft.day1 as DayCode] : DAY_PLACEHOLDER}
                                      onChange={(lbl) =>
                                        setDraft((d) => ({
                                          ...d,
                                          day1: (lbl === DAY_PLACEHOLDER
                                            ? ("" as any)
                                            : (DAY_FROM_LABEL[lbl as DayLabel] || "M")) as any,
                                        }))
                                      }
                                      options={[DAY_PLACEHOLDER, ...DAY_OPTS_LABELS]}
                                    />

                                    <SelectBox
                                      value={(() => {
                                        const b = (draft.begin1 || "").toString();
                                        const e = (draft.end1 || "").toString();
                                        const f = GE_TIME_SLOTS.find((x) => x.start === b && x.end === e);
                                        return f?.label || "Select time…";
                                      })()}
                                      onChange={(band) => {
                                        if (band === "Select time…") {
                                          setSlotFromBand(1, "");
                                          return;
                                        }
                                        setSlotFromBand(1, band);
                                      }}
                                      options={["Select time…", ...GE_TIME_SLOTS.map((x) => x.label)]}
                                    />

                                    <input
                                      value={prettyHHMM(draft.end1 || "")}
                                      disabled
                                      className={cls(
                                        "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                        "bg-gray-100 text-gray-700 cursor-not-allowed"
                                      )}
                                    />
                                  </div>

                                  <div className="grid grid-cols-[minmax(140px,1fr)_minmax(140px,1fr)_minmax(80px,100px)] gap-2 items-center">
                                    <SelectBox
                                      value={draft.day2 ? DAY_LABELS[draft.day2 as DayCode] : DAY_PLACEHOLDER}
                                      onChange={(lbl) =>
                                        setDraft((d) => ({
                                          ...d,
                                          day2: (lbl === DAY_PLACEHOLDER
                                            ? ("" as any)
                                            : (DAY_FROM_LABEL[lbl as DayLabel] || "M")) as any,
                                        }))
                                      }
                                      options={[DAY_PLACEHOLDER, ...DAY_OPTS_LABELS]}
                                    />

                                    <SelectBox
                                      value={(() => {
                                        const b = (draft.begin2 || "").toString();
                                        const e = (draft.end2 || "").toString();
                                        const f = GE_TIME_SLOTS.find((x) => x.start === b && x.end === e);
                                        return f?.label || "Select time…";
                                      })()}
                                      onChange={(band) => {
                                        if (band === "Select time…") {
                                          setSlotFromBand(2, "");
                                          return;
                                        }
                                        setSlotFromBand(2, band);
                                      }}
                                      options={["Select time…", ...GE_TIME_SLOTS.map((x) => x.label)]}
                                    />

                                    <input
                                      value={prettyHHMM(draft.end2 || "")}
                                      disabled
                                      className={cls(
                                        "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                        "bg-gray-100 text-gray-700 cursor-not-allowed"
                                      )}
                                    />
                                  </div>

                                  <div className="mt-2 text-xs text-gray-600">
                                    Preview:{" "}
                                    <span className="font-semibold">{scheduleTextFromRow(draft) || "—"}</span>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </td>

                          <td className="px-3 py-3 align-top whitespace-nowrap">
                            <div className="space-y-1 text-center">
                              {buildScheduleSlotViews(draft).map((slot) => (
                                <div key={slot.key}>{slot.time}</div>
                              ))}
                            </div>
                          </td>

                          <td className="px-3 py-3 align-top whitespace-nowrap">
                            <div className="space-y-1 text-center">
                              {roomCellItems(r).map((item) => (
                                <span key={item.key} title={item.title} className="block">
                                  {item.label}
                                </span>
                              ))}
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-3 align-top whitespace-nowrap">
                            <div className="space-y-1 text-center">
                              {buildScheduleSlotViews(r).map((slot) => (
                                <div key={slot.key}>{slot.day}</div>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top whitespace-nowrap">
                            <div className="space-y-1 text-center">
                              {buildScheduleSlotViews(r).map((slot) => (
                                <div key={slot.key}>{slot.time}</div>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top whitespace-nowrap">
                            <div className="space-y-1 text-center">
                              {roomCellItems(r).map((item) => (
                                <span key={item.key} title={item.title} className="block">
                                  {item.label}
                                </span>
                              ))}
                            </div>
                          </td>
                        </>
                      )}

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
                              {Boolean((r as any)?.rfc_needs_chair) && (
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
                          <button
                            type="button"
                            onClick={() => beginEdit(r)}
                            className="inline-flex items-center justify-center p-1 rounded-md text-emerald-700 hover:bg-emerald-50"
                            title="Edit"
                            aria-label="Edit"
                          >
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
      </div>

      {/* View Application Modal */}
      {viewOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeView();
          }}
        >
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b bg-gray-50">
              <div>
                <div className="text-lg font-bold text-gray-900">View Application</div>
              </div>
              <button
                type="button"
                onClick={closeView}
                className="h-9 w-9 inline-flex items-center justify-center rounded-full hover:bg-gray-200/70"
                title="Close"
              >
                <X className="h-5 w-5 text-gray-700" />
              </button>
            </div>

            <div className="p-5 max-h-[75vh] overflow-auto">
              {viewLoading ? (
                <div className="py-10 text-center text-gray-500">Loading application…</div>
              ) : viewErr ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {viewErr}
                </div>
              ) : !viewData ? (
                <div className="py-10 text-center text-gray-500">No data</div>
              ) : (
                <div className="space-y-5">
                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Student Details</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Name" value={viewData.student_name} />
                      <DetailRow label="ID Number" value={viewData.student_number} />
                      <DetailRow label="Program" value={viewData.program_code} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Request</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Graduating After Term" value={viewData.graduating_after_term} />
                      <DetailRow
                        label="Reason"
                        value={viewData.reason_other ? `${viewData.reason}${viewData.reason ? " — " : ""}${viewData.reason_other}` : viewData.reason}
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">EAF Submission</div>
                    </div>
                    <div className="px-4 py-4 space-y-3">
                      {viewData.has_eaf && viewData.eaf_view_url ? (
                        <>
                          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                            <div className="text-sm font-medium text-gray-900">{viewData.eaf_original_name || "Uploaded EAF"}</div>
                            <div className="mt-1 text-xs text-gray-500">
                              Uploaded: {formatDate(viewData.eaf_uploaded_at)}
                            </div>
                          </div>
                          <div>
                            <button
                              type="button"
                              onClick={() => openEaf(viewData.eaf_view_url)}
                              className="inline-flex items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
                            >
                              Open PDF
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-500">
                          No EAF submission found.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t bg-gray-50 flex items-center justify-end">
              <button
                type="button"
                onClick={closeView}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-100"
              >
                Close
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
