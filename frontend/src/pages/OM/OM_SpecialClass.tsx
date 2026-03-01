import { useEffect, useMemo, useRef, useState } from "react";
import { Search as SearchIcon, Edit, Check, ChevronDown, Eye, X, Download, MessageSquareText, Send } from "lucide-react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  getOMSC_Options,
  listOMSC,
  updateOMSC,
  getOMSC_SchedulePresets,
  getOMSC_Detail,
  exportOMSC_Pdf,
  getOmLoadAssignmentRfc,
  respondOmLoadAssignmentRfc,
  downloadBlob,
  type OMSpecialClassRow,
  type OMSpecialClassOptions,
  type OMSCSchedulePreset,
  type OMSpecialClassDetail,
} from "../../api";

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

function scheduleTextFromRow(r: Partial<OMSpecialClassRow>) {
  const parts: string[] = [];
  if (r.day1 && r.begin1 && r.end1) parts.push(`${r.day1} ${r.begin1}-${r.end1}`);
  if (r.day2 && r.begin2 && r.end2) parts.push(`${r.day2} ${r.begin2}-${r.end2}`);
  return parts.join("; ");
}

function formatDate(dt?: string) {
  if (!dt) return "—";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return dt;
  return d.toLocaleString();
}

const CLEAR_SCHEDULE_LABEL = "Clear schedule";

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

export default function OM_SpecialClass({ hideMessageIcon = false }: { hideMessageIcon?: boolean } = {}) {
  const [status, setStatus] = useState("All Status");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");

  const [exportOpen, setExportOpen] = useState(false);

  const [statuses, setStatuses] = useState<string[]>(["All Status"]);
  const [activeTermLabel, setActiveTermLabel] = useState<string>("");

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
  const [rows, setRows] = useState<OMSpecialClassRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [errKind, setErrKind] = useState<"success" | "error">("error");

  // selection
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // edit
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<OMSpecialClassRow>>({});
  const [facultyInput, setFacultyInput] = useState<string>("");

  // presets
  const [presets, setPresets] = useState<OMSCSchedulePreset[]>([]);
  const [presetChoice, setPresetChoice] = useState<string>("CUSTOM"); 
  const [clearMode, setClearMode] = useState<"none" | "schedule" | "all">("none");
  const [didClearAll, setDidClearAll] = useState(false);

  // view modal
  const [viewOpen, setViewOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewErr, setViewErr] = useState("");
  const [viewData, setViewData] = useState<OMSpecialClassDetail | null>(null);

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
    // This screen uses an inline banner for feedback; keep it consistent.
    setErrKind(kind === "success" ? "success" : "error");
    setErr(message);
    if (kind === "success") {
      window.setTimeout(() => setErr(""), 2500);
    }
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

  // load options
  useEffect(() => {
    (async () => {
      try {
        const opt: OMSpecialClassOptions = await getOMSC_Options();
        if (!opt.ok) throw new Error("Failed to load options");
        setStatuses(["All Status", ...(opt.statuses || [])]);

        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setActiveTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");

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
      setErrKind("error");
      const res = await listOMSC({ status, q });
      if (!res.ok) throw new Error("Failed to load special class applications");
      const incoming = res.rows || [];
      setRows(incoming);

      setSelectedIds((prev) => {
        const allowed = new Set(incoming.map((r) => r.special_id));
        const next: Record<string, boolean> = {};
        Object.entries(prev).forEach(([id, v]) => {
          if (allowed.has(id) && v) next[id] = true;
        });
        return next;
      });
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

  const selectedList = useMemo(
    () => rows.filter((r) => !!selectedIds[r.special_id]).map((r) => r.special_id),
    [rows, selectedIds]
  );

  const toggleAllVisible = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = { ...prev };
      rows.forEach((r) => {
        if (checked) next[r.special_id] = true;
        else delete next[r.special_id];
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
        const blob = await exportOMSC_Pdf({ special_ids: [id] });
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

  const beginEdit = async (row: OMSpecialClassRow) => {
    setEditId(row.special_id);
    setDidClearAll(false);

    setDraft({
      course_id: row.course_id,
      status: row.status,
      remarks: row.remarks || "",
      faculty_id: row.faculty_id || null,
      section_id: row.section_id || null,
      section_code: row.section_code || "",

      day1: (row.day1 || "") as any,
      begin1: row.begin1 || "",
      end1: row.end1 || "",
      day2: (row.day2 || "") as any,
      begin2: row.begin2 || "",
      end2: row.end2 || "",
    });

    const facName = (row.faculty_name || "").toString().trim();
    setFacultyInput(facName === "UNASSIGNED" ? "" : facName);

    try {
      const res = await getOMSC_SchedulePresets(row.course_id);
      setPresets(res.presets || []);
      const match = (res.presets || []).find((p) => p.section_id === row.section_id);

      const rowHasNoSchedule =
        !!row.section_id && !(row.day1 || row.begin1 || row.end1 || row.day2 || row.begin2 || row.end2);

      if (rowHasNoSchedule) {
        setPresetChoice("CLEAR_SCHEDULE");
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
    setDraft({});
    setPresets([]);
    setPresetChoice("CUSTOM");
    setFacultyInput("");
    setDidClearAll(false);
    setClearMode("none");
  };

  const saveEdit = async () => {
    if (!editId) return;

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

      await updateOMSC(editId, payload);

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

  const openView = async (row: OMSpecialClassRow) => {
    setViewOpen(true);
    setViewLoading(true);
    setViewErr("");
    setViewData(null);

    try {
      const res = await getOMSC_Detail(row.special_id);
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

  const allVisibleSelected = rows.length > 0 && rows.every((r) => !!selectedIds[r.special_id]);

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Special Class</h1>
        <p className="text-sm text-gray-600">
          Review Special Class applications {activeTermLabel && `for ${activeTermLabel}`}
        </p>
      </header>

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

                <th className="text-left px-4 py-2 whitespace-nowrap">Student</th>
                <th className="text-left px-4 py-2 whitespace-nowrap">Course</th>
                <th className="text-left px-4 py-2 whitespace-nowrap">Section</th>
                <th className="text-left px-4 py-2 whitespace-nowrap">Faculty</th>

                <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Day1</th>
                <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Begin1</th>
                <th className="text-left px-3 py-2 whitespace-nowrap w-fit">End1</th>
                <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Room1</th>

                <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Day2</th>
                <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Begin2</th>
                <th className="text-left px-3 py-2 whitespace-nowrap w-fit">End2</th>
                <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Room2</th>

                <th className="text-center px-4 py-2 whitespace-nowrap">Status</th>
                <th className="text-left px-4 py-2 whitespace-nowrap">Remarks</th>
                <th className="w-20 px-4 py-2 text-center whitespace-nowrap"> </th>
              </tr>
            </thead>

            <tbody className="divide-y">
              {loading ? (
                <tr>
                  <td className="px-4 py-6 text-center text-gray-500" colSpan={16}>
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-gray-500" colSpan={16}>
                    No results
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const editing = editId === r.special_id;
                  const isCustom = presetChoice === "CUSTOM";

                  return (
                    <tr key={r.special_id} className="hover:bg-gray-50 align-top">
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={!!selectedIds[r.special_id]}
                          onChange={(e) => toggleOne(r.special_id, e.target.checked)}
                          className="h-4 w-4 accent-emerald-600"
                          disabled={loading}
                        />
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-semibold">{r.student_name || "—"}</div>
                        <div className="text-xs text-gray-500">{r.student_number || "—"}</div>
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-semibold text-emerald-700">{r.course_code || "—"}</div>
                        <div className="text-xs text-gray-500">{r.course_title || ""}</div>
                      </td>

                      <td className="px-4 py-3">
                        {editing ? (
                          isCustom ? (
                            <input
                              value={(draft.section_code || "") as string}
                              onChange={(e) => setDraft((d) => ({ ...d, section_code: e.target.value }))}
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
                              if (!isCustom) return;

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
                            disabled={!isCustom}
                          />
                        ) : (
                          <div className="font-medium">{r.faculty_name || "UNASSIGNED"}</div>
                        )}

                      </td>

                      {/* Schedule columns */}
                      {editing ? (
                        <>
                          {/* Editor cell occupies Day1/Begin1/End1 */}
                          <td className="px-3 py-3 whitespace-nowrap" colSpan={3}>
                            <div className="space-y-2 min-w-[520px]">
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
                                  // Any manual change cancels a pending "clear all" state
                                  setDidClearAll(false);
                                  if (label === "Clear schedule") {
                                  setClearMode("schedule");
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
                                  return;
                                }

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

                                  if (label === CLEAR_SCHEDULE_LABEL) {
                                    setPresetChoice("CLEAR_SCHEDULE");
                                    clearScheduleOnlyDraft();
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

                                  <div className="grid grid-cols-[minmax(180px,5px)_minmax(100px,1fr)_minmax(90px,120px)] gap-2 items-center mb-2 min-w-0">
                                    <SelectBox
                                      value={draft.day1 ? DAY_LABELS[draft.day1 as DayCode] : "Monday"}
                                      onChange={(lbl) =>
                                        setDraft((d) => ({ ...d, day1: DAY_FROM_LABEL[lbl as DayLabel] || "M" }))
                                      }
                                      options={[...DAY_OPTS_LABELS]}
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

                                  <div className="grid grid-cols-[minmax(180px,5px)_minmax(100px,1fr)_minmax(90px,120px)] gap-2 items-center">
                                    <SelectBox
                                      value={draft.day2 ? DAY_LABELS[draft.day2 as DayCode] : "Monday"}
                                      onChange={(lbl) =>
                                        setDraft((d) => ({ ...d, day2: DAY_FROM_LABEL[lbl as DayLabel] || "M" }))
                                      }
                                      options={[...DAY_OPTS_LABELS]}
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

                          {/* Room1 (display-only) */}
                          <td className="px-3 py-3 whitespace-nowrap w-fit">
                            <span title={roomTitle(r, 1)} className="inline-block">
                              {roomLabel(r, 1)}
                            </span>
                          </td>

                          {/* Day2/Begin2/End2 (read values) */}
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{draft.day2 || "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(draft.begin2 || "") || "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(draft.end2 || "") || "—"}</td>

                          {/* Room2 (display-only) */}
                          <td className="px-3 py-3 whitespace-nowrap w-fit">
                            <span title={roomTitle(r, 2)} className="inline-block">
                              {roomLabel(r, 2)}
                            </span>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{r.day1 || "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(r.begin1 || "") || "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(r.end1 || "") || "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">
                            <span title={roomTitle(r, 1)} className="inline-block">
                              {roomLabel(r, 1)}
                            </span>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{r.day2 || "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(r.begin2 || "") || "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(r.end2 || "") || "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap w-fit">
                            <span title={roomTitle(r, 2)} className="inline-block">
                              {roomLabel(r, 2)}
                            </span>
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

                      <td className="px-2 py-3 whitespace-nowrap">
  <div className="flex items-center justify-center gap-1">
    {editing ? (
      <>
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
      </>
    ) : (
      <>
        {!hideMessageIcon && (
        <button
          type="button"
          onClick={() => {
            setConv({
              open: true,
              termId: r.term_id,
              facultyId: r.faculty_id ?? null,
              facultyName: r.faculty_name || "UNASSIGNED",
              sectionId: r.special_id,
            });
          }}
          disabled={!r.faculty_id}
          className={cls(
            "relative inline-flex items-center justify-center p-1 rounded-md text-blue-700 hover:bg-blue-50",
            !r.faculty_id && "opacity-50 cursor-not-allowed hover:bg-transparent"
          )}
          title={r.faculty_id ? "Message" : "Assign a faculty first to open conversation"}
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
        )}

        <button
          type="button"
          onClick={() => openView(r)}
          className="inline-flex items-center justify-center p-1 rounded-md text-gray-700 hover:bg-gray-100"
          title="View Application"
          aria-label="View Application"
        >
          <Eye className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => beginEdit(r)}
          className="inline-flex items-center justify-center p-1 rounded-md text-emerald-700 hover:bg-emerald-50"
          title="Edit"
          aria-label="Edit"
        >
          <Edit className="h-4 w-4" />
        </button>
      </>
    )}
  </div>
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
                      <div className="text-sm font-semibold text-gray-900">Student</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Student Name" value={viewData.student_name} />
                      <DetailRow label="Student Number" value={viewData.student_number} />
                      <DetailRow label="Program" value={viewData.program_code} />
                      <DetailRow label="Department" value={viewData.department_name || viewData.course_department} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Course</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Course Code" value={viewData.course_code} />
                      <DetailRow label="Course Title" value={viewData.course_title} />
                      <DetailRow label="Course Units" value={viewData.course_units} />
                      <DetailRow label="Units Remaining" value={viewData.units_remaining} />
                      <DetailRow label="Graduating After Term" value={viewData.graduating_after_term} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Request</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Reason" value={viewData.reason} />
                      <DetailRow label="Reason (Other)" value={viewData.reason_other} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Schedule</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Section" value={viewData.section_code || "—"} />

                      <DetailRow
                        label="Schedule 1"
                        value={
                          viewData.day1 && viewData.begin1 && viewData.end1
                            ? `${viewData.day1} ${prettyHHMM(viewData.begin1)}–${prettyHHMM(viewData.end1)}`
                            : "—"
                        }
                      />
                      <DetailRow label="Room 1" value={roomLabel(viewData, 1)} />

                      <DetailRow
                        label="Schedule 2"
                        value={
                          viewData.day2 && viewData.begin2 && viewData.end2
                            ? `${viewData.day2} ${prettyHHMM(viewData.begin2)}–${prettyHHMM(viewData.end2)}`
                            : "—"
                        }
                      />
                      <DetailRow label="Room 2" value={roomLabel(viewData, 2)} />

                      <DetailRow label="Section ID" value={viewData.section_id} />
                      <DetailRow label="Faculty" value={viewData.faculty_name || "UNASSIGNED"} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Status</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Status" value={viewData.status} />
                      <DetailRow label="Remarks" value={viewData.remarks} />
                      <DetailRow label="Submitted At" value={formatDate(viewData.submitted_at)} />
                      <DetailRow label="Updated At" value={formatDate(viewData.updated_at)} />
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
