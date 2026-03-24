// frontend/src/pages/STUDENT/STUDENT_SpecialClass.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, AlertCircle, Send, Upload, FileText, X, Eye, Download } from "lucide-react";

import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";

import TopBar from "../../component/TopBar";
import {
  getStudentSpecialClassOptions,
  getStudentSpecialClassProfile,
  getStudentSpecialClasses,
  getStudentSpecialClassCourseInfo,
  submitStudentSpecialClass,
  type SpecialClassOptions,
  type SpecialClassSubmitPayload,
  type SpecialClassView,
} from "../../api";

/* ---------------- Local Types ---------------- */
type ProfileData = {
  ok: boolean;
  first_name: string;
  last_name: string;
  student_number: string;
  program_code?: string;
};

type UserData = { userId: string; fullName: string; roles?: string[] };

type FormData = {
  // Student Information
  studentNumber: string;
  degree: string;

  // Degree Progress
  unitsRemaining: string;
  graduatingAfterTerm: "" | "Yes" | "No";

  // Course Request
  courseCode: string;
  courseTitle: string;
  units: string;
  reason: string;
  reasonOther: string;
  department: string;

  // EAF
  eafFile: File | null;

  // Terms
  agree: boolean;
};

const MAX_EAF_BYTES = 5 * 1024 * 1024;
const EAF_ACCEPT = ".pdf,application/pdf";

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* ---------------- Searchable, Typable Combo for Course Code ---------------- */
function SearchableCourseCode({
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value || "");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setQ(value || "");
  }, [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  const normalizedOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of options) {
      const v = String(raw || "").trim().toUpperCase();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  }, [options]);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (!needle) return normalizedOptions.slice(0, 30);
    const res = normalizedOptions.filter((x) => x.includes(needle));
    return res.slice(0, 30);
  }, [normalizedOptions, q]);

  const commit = (v: string) => {
    const cleaned = String(v || "").trim().toUpperCase();
    onChange(cleaned);
    setQ(cleaned);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={`w-full rounded-lg border px-3 py-2 text-sm flex items-center justify-between gap-2
          ${disabled ? "bg-gray-100 border-gray-300" : "bg-white border-gray-300"}`}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
        }}
      >
        <input
          value={q}
          disabled={disabled}
          onFocus={() => !disabled && setOpen(true)}
          onChange={(e) => {
            const next = e.target.value.toUpperCase();
            setQ(next);
            onChange(next.trim());
          }}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit(q);
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
            }
          }}
          placeholder={placeholder || "-- Select / Type Course Code --"}
          className={`w-full bg-transparent outline-none ${disabled ? "cursor-not-allowed" : ""}`}
        />

        <svg
          width="16"
          height="16"
          viewBox="0 0 20 20"
          aria-hidden="true"
          className={`shrink-0 opacity-60 ${disabled ? "opacity-30" : ""}`}
        >
          <path d="M5 7l5 5 5-5H5z" />
        </svg>
      </div>

      {open && !disabled && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="max-h-64 overflow-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500">No matching courses.</div>
            ) : (
              filtered.map((opt) => {
                const active = opt === (value || "").trim().toUpperCase();
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => commit(opt)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-emerald-50 ${
                      active ? "bg-emerald-50 font-medium" : ""
                    }`}
                    title={opt}
                  >
                    {opt}
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-gray-200 px-3 py-2 text-xs text-gray-500">
            Tip: Type to search, press <span className="font-semibold">Enter</span> to use what you
            typed.
          </div>
        </div>
      )}
    </div>
  );
}

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

function DeadlineBanner({ openISO, deadlineISO, className }: { openISO: string; deadlineISO: string; className?: string }) {
  const hasWindow = !!openISO && !!deadlineISO;
  if (!hasWindow) {
    return (
      <div className={cls("mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700", className)}>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 h-2.5 w-2.5 rounded-full bg-slate-400" />
          <div>
            <div className="font-semibold">Submission Window Not Started</div>
            <div className="mt-0.5 text-xs text-slate-600">The Office Manager has not started the submission window yet.</div>
          </div>
        </div>
      </div>
    );
  }

  const { past: openPassed, label: openLabel } = useCountdown(openISO);
  const { past: deadlinePassed, label: deadlineLabel } = useCountdown(deadlineISO);

  if (!openPassed) {
    return (
      <div className={cls("mb-4 flex items-start gap-3 rounded-xl border p-4 border-amber-300 bg-amber-50 text-amber-900", className)}>
        <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
        <div className="text-sm">
          <div className="font-semibold">Submissions Open In</div>
          <div className="mt-0.5">
            Opens: <span className="font-medium">{openISO ? new Date(openISO).toLocaleString() : "—"}</span>{" "}
            • <span className="font-bold text-amber-700">{openLabel}</span>
          </div>
          <div className="mt-1 text-[12px] opacity-80">Editing is locked until the window opens.</div>
        </div>
      </div>
    );
  }

  if (deadlinePassed) {
    return (
      <div className={cls("mb-4 flex items-start gap-3 rounded-xl border p-4 border-red-300 bg-red-50 text-red-800", className)}>
        <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
        <div className="text-sm">
          <div className="font-semibold">Editing Locked</div>
          <div className="mt-0.5">
            Deadline: <span className="font-medium">{deadlineISO ? new Date(deadlineISO).toLocaleString() : "—"}</span>{" "}
            • <span className="font-bold text-red-700">Deadline passed</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cls("mb-4 flex items-start gap-3 rounded-xl border p-4 border-amber-300 bg-amber-50 text-amber-900", className)}>
      <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
      <div className="text-sm">
        <div className="font-semibold">Submission Deadline Approaching</div>
        <div className="mt-0.5">
          Deadline: <span className="font-medium">{deadlineISO ? new Date(deadlineISO).toLocaleString() : "—"}</span>{" "}
          • <span className="font-bold text-amber-700">{deadlineLabel}</span>
        </div>
        <div className="mt-1 text-[12px] opacity-80">Please finalize your preferences before the deadline.</div>
      </div>
    </div>
  );
}

/* ---------------- Small helpers ---------------- */
function formatDateShort(dt?: string) {
  if (!dt) return "—";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return String(dt);
  return d.toLocaleDateString();
}

function formatHHMM(v?: string) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  const s = raw.replace(":", "");
  if (s.length === 4 && /^\d{4}$/.test(s)) return `${s.slice(0, 2)}:${s.slice(2)}`;
  return raw;
}

function normalizeRoomDisplay(v?: unknown) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const u = s.toUpperCase();
  if (u === "ONLINE") return "TBA";
  if (u === "ONLINE CLASS" || u === "ONLINECLASS") return "TBA";
  // Some backends send "Online" casing.
  if (u === "ONLINE") return "TBA";
  return s;
}

/**
 * Returns a compact "Day/s" + "Time" display without duplicating the same time below the table.
 * - If both slots share the same time range: Day/s = "M, H", Time = "0730 - 0900"
 * - If times differ: Day/s = "M / H", Time = "0730 - 0900; 1000 - 1200"
 */
/* ---------------- Extend view type for schedule details (optional fields) ---------------- */
type StudentSpecialClassView = SpecialClassView & {
  section_code?: string;
  faculty_name?: string;

  // schedule (from section schedules OR custom)
  day1?: string;
  begin1?: string;
  end1?: string;
  room1?: string;
  day2?: string;
  begin2?: string;
  end2?: string;
  room2?: string;
  schedule_text?: string;
};

/* ---------------- Status Card (clean, non-redundant) ---------------- */
function StatusCard({ a }: { a: StudentSpecialClassView }) {
  const statusRaw = String(a.status || "").trim();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState("");

  const pill =
    statusRaw.toLowerCase().includes("approved")
      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
      : statusRaw.toLowerCase().includes("disapproved") ||
        statusRaw.toLowerCase().includes("rejected")
      ? "bg-red-50 text-red-700 border border-red-200"
      : statusRaw.toLowerCase().includes("forwarded")
      ? "bg-amber-50 text-amber-700 border border-amber-200"
      : "bg-gray-100 text-gray-600 border border-gray-200";

  const ayLabel = (() => {
    const n = Number.parseInt(String((a as any).acad_year_start ?? ""), 10);
    return Number.isFinite(n) ? `AY ${n}-${n + 1}` : "AY —";
  })();

  const course = String(a.course_code || "").trim() || "—";
  const section = String(a.section_code || "").trim() || "—";
  const faculty = String((a as any).faculty_name || (a as any).facultyName || "").trim() || "UNASSIGNED";

  const d1 = String(a.day1 || "").trim() || "—";
  const b1 = formatHHMM(String(a.begin1 || "").trim()) || "—";
  const e1 = formatHHMM(String(a.end1 || "").trim()) || "—";
  const r1 = normalizeRoomDisplay((a as any).room1) || "—";

  const d2 = String(a.day2 || "").trim() || "—";
  const b2 = formatHHMM(String(a.begin2 || "").trim()) || "—";
  const e2 = formatHHMM(String(a.end2 || "").trim()) || "—";
  const r2 = normalizeRoomDisplay((a as any).room2) || "—";

  // ✅ Remarks column shows APPLICATION remarks
  const remarksCell = String(a.remarks || "").trim() || "—";
  const eafName = String((a as any).eaf_original_name || "").trim();
  const eafViewUrl = String((a as any).eaf_view_url || "").trim();
  const hasEaf = Boolean((a as any).has_eaf) && !!eafName && !!eafViewUrl;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const loadEafBlob = async () => {
    if (!eafViewUrl) throw new Error("EAF not found.");
    const res = await fetch(eafViewUrl, { credentials: "include", cache: "no-store" });
    if (!res.ok) {
      let message = "EAF not found.";
      try {
        const data = await res.json();
        if (data?.detail) message = String(data.detail);
      } catch {
        // ignore parse failures and use default message
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) throw new Error("EAF file is unavailable.");
    return blob;
  };

  const handleOpenPreview = async () => {
    if (!hasEaf) return;
    setActionError("");
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError("");
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl("");
    }
    try {
      const blob = await loadEafBlob();
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err: any) {
      setPreviewError(err?.message || "Unable to preview the uploaded EAF.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!hasEaf) return;
    setActionError("");
    setDownloading(true);
    try {
      const blob = await loadEafBlob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = eafName || `${course || "special-class-eaf"}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } catch (err: any) {
      setActionError(err?.message || "Unable to download the uploaded EAF.");
    } finally {
      setDownloading(false);
    }
  };

  const closePreview = () => {
    setPreviewOpen(false);
    setPreviewLoading(false);
    setPreviewError("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
  };

  return (
    <>
      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden mb-5">
      {/* Header */}
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-bold text-emerald-700 leading-tight">
              {course || "—"}
            </div>
            <div className="text-sm text-gray-700">{a.course_title || " "}</div>
            <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
              <Calendar className="h-4 w-4" />
              <span>Submitted: {formatDateShort(a.submitted_at)}</span>
              <span className="mx-1">•</span>
              <span>
                {ayLabel} · Term {(a as any).term_number ?? "—"}
              </span>
            </div>
            {eafName && (
              <div className="mt-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0 text-sm">
                  <span className="min-w-0 inline-flex flex-1 items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-800">
                    <FileText className="h-4 w-4 shrink-0" />
                    <span className="truncate">{eafName}</span>
                  </span>
                  {hasEaf && (
                    <>
                      <button
                        type="button"
                        onClick={handleOpenPreview}
                        className="inline-flex shrink-0 items-center gap-2 rounded-full border border-gray-300 bg-white px-3 py-1 text-gray-700 hover:bg-gray-50"
                        title="View EAF"
                      >
                        <Eye className="h-4 w-4" />
                        <span>View</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleDownload}
                        disabled={downloading}
                        title={downloading ? "Downloading EAF" : "Download EAF"}
                        aria-label={downloading ? "Downloading EAF" : "Download EAF"}
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
                {!!actionError && <div className="mt-2 text-xs text-red-600">{actionError}</div>}
              </div>
            )}
          </div>

          <span className={`shrink-0 px-3 py-1 text-xs rounded-full font-medium ${pill}`}>
            {statusRaw || "—"}
          </span>
        </div>
      </div>

      <div className="h-px bg-gray-200" />

      {/* Compact Schedule Table (aligned grid, no redundant time below) */}
      <div className="px-5 py-4">
        <div className="overflow-x-auto rounded-xl border border-emerald-200">
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="bg-emerald-50 text-emerald-900">
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[110px]">Course</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[90px]">Section</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[200px]">Faculty</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[70px]">Day 1</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[90px]">Begin 1</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[90px]">End 1</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[120px]">Room 1</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[70px]">Day 2</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[90px]">Begin 2</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[90px]">End 2</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[120px]">Room 2</th>
                <th className="border border-emerald-200 px-3 py-2 text-xs font-semibold text-left w-[180px]">Remarks</th>
              </tr>
            </thead>

            <tbody>
              <tr className="bg-white">
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">
                  {course}
                </td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">
                  {section}
                </td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">
                  {faculty}
                </td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">{d1}</td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">{b1}</td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">{e1}</td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">{r1}</td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">{d2}</td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">{b2}</td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">{e2}</td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">{r2}</td>
                <td className="border border-emerald-200 px-3 py-2 text-sm text-gray-900">
                  {remarksCell}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
      {previewOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={closePreview}>
          <div
            className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div className="min-w-0">
                <div className="text-base font-semibold text-gray-900">EAF Preview</div>
                <div className="truncate text-sm text-gray-500">{eafName || "Uploaded EAF"}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closePreview}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <X className="h-4 w-4" />
                  <span>Close</span>
                </button>
              </div>
            </div>

            <div className="h-[75vh] bg-gray-50">
              {previewLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-gray-600">Loading EAF preview...</div>
              ) : previewError ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <AlertCircle className="h-10 w-10 text-amber-500" />
                  <div className="text-base font-semibold text-gray-900">Unable to preview EAF</div>
                  <div className="max-w-md text-sm text-gray-600">{previewError}</div>
                </div>
              ) : previewUrl ? (
                <iframe title={`EAF Preview ${eafName || ""}`} src={previewUrl} className="h-full w-full bg-white" />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-gray-600">No EAF preview available.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- Page ---------------- */
export default function STUDENT_SpecialClass() {
  const user: UserData | null = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  }, []);
  const userId = user?.userId ?? null;
  const fullName = user?.fullName ?? "Student";

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [options, setOptions] = useState<SpecialClassOptions>({
    ok: false,
    departments: [],
    courses: [],
    programs: [],
    reasons: [],
    statuses: [],
  });

  const [applications, setApplications] = useState<StudentSpecialClassView[]>([]);

  const [form, setForm] = useState<FormData>({
    studentNumber: "",
    degree: "",
    unitsRemaining: "",
    graduatingAfterTerm: "",
    courseCode: "",
    courseTitle: "",
    units: "",
    reason: "",
    reasonOther: "",
    department: "",
    eafFile: null,
    agree: false,
  });

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const eafInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string>("");
  const [submissionWindow, setSubmissionWindow] = useState<{ openISO: string; deadlineISO: string }>({ openISO: "", deadlineISO: "" });

  const { past: openPassedPage } = useCountdown(submissionWindow.openISO || "");
  const { past: deadlinePassedPage } = useCountdown(submissionWindow.deadlineISO || "");
  const editingLocked = !submissionWindow.openISO || !submissionWindow.deadlineISO || !openPassedPage || deadlinePassedPage;

  // Load options + list + profile (same pattern as Petition)
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        setLoading(true);
        const [opt, apps, prof] = await Promise.all([
          getStudentSpecialClassOptions(userId),
          getStudentSpecialClasses(userId),
          getStudentSpecialClassProfile(userId),
        ]);

        setOptions(opt);
        setSubmissionWindow({
          openISO: opt?.submission_window?.openISO || "",
          deadlineISO: opt?.submission_window?.deadlineISO || "",
        });
        setApplications(((apps?.applications || []) as StudentSpecialClassView[]) ?? []);

        if (prof && prof.ok) {
          setProfile(prof);
          if (prof.program_code) {
            setForm((prev) => ({ ...prev, degree: prof.program_code || prev.degree }));
          }
        } else {
          setProfile({ ok: false, first_name: "", last_name: "", student_number: "" });
        }
      } catch (e: any) {
        setError(e?.response?.data?.detail || e?.message || "Failed to load special class data.");
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  // Build a quick lookup: courseCode -> details (for autofill)
  const courseMap = useMemo(() => {
    const m = new Map<string, { title: string; dept: string; units: number }>();
    for (const c of options.courses) {
      const code = String((c as any).course_code || "").trim().toUpperCase();
      if (!code) continue;
      m.set(code, {
        title: (c as any).course_title || "",
        dept: (c as any).dept_name || "",
        units: Number((c as any).units ?? 0),
      });
    }
    return m;
  }, [options.courses]);

  const courseCodeOptions = useMemo(() => {
    return options.courses
      .map((c: any) => String(c.course_code || "").trim().toUpperCase())
      .filter(Boolean);
  }, [options.courses]);

  // Section completion rules (as requested: disabling next sections)
  const section1Ok = /^\d{8}$/.test(form.studentNumber) && Boolean(form.degree);

  const section2Ok =
    section1Ok &&
    form.unitsRemaining.trim() !== "" &&
    /^[0-9]+$/.test(form.unitsRemaining.trim()) &&
    (form.graduatingAfterTerm === "Yes" || form.graduatingAfterTerm === "No");

  const section3Ok =
    section2Ok &&
    Boolean(form.courseCode.trim()) &&
    form.units.trim() !== "" &&
    /^[0-9]+$/.test(form.units.trim()) &&
    Number(form.units) > 0 &&
    Boolean(form.reason) &&
    Boolean(form.department) &&
    (form.reason !== "Other" || Boolean(form.reasonOther.trim()));

  const section4Ok = section3Ok && !!form.eafFile;
  const section5Ok = section4Ok && form.agree === true;

  const handleCoursePick = async (code: string) => {
    const cleaned = String(code || "").trim().toUpperCase();
    if (!cleaned) {
      setForm((prev) => ({
        ...prev,
        courseCode: "",
        courseTitle: "",
        units: "",
      }));
      return;
    }

    // Optimistic fill (from options list) while fetching DB-truth
    const hit = courseMap.get(cleaned);
    setForm((prev) => ({
      ...prev,
      courseCode: cleaned,
      courseTitle: hit?.title || prev.courseTitle || "",
      department: hit?.dept && options.departments.includes(hit.dept) ? hit.dept : prev.department,
      units: hit?.units ? String(hit.units) : prev.units,
    }));

    // Fetch course info from DB to guarantee correct units/title/department
    try {
      const info = await getStudentSpecialClassCourseInfo(userId!, cleaned);
      if (!info?.ok) return;

      setForm((prev) => ({
        ...prev,
        courseCode: String(info.course_code || cleaned).trim().toUpperCase(),
        courseTitle: info.course_title || prev.courseTitle,
        units: info.units != null ? String(info.units) : prev.units,
        department:
          info.department_name && options.departments.includes(info.department_name)
            ? info.department_name
            : prev.department,
      }));
    } catch (e: any) {
      // Keep optimistic values, but show a gentle error
      setError(
        e?.response?.data?.detail || e?.message || "Failed to fetch course units. Please try again."
      );
    }
  };

  // If user types a course code that matches, autofill title/department immediately
  useEffect(() => {
    const cleaned = String(form.courseCode || "").trim().toUpperCase();
    if (!cleaned) {
      if (form.courseTitle) setForm((p) => ({ ...p, courseTitle: "" }));
      return;
    }
    const hit = courseMap.get(cleaned);
    if (!hit) {
      if (form.courseTitle) setForm((p) => ({ ...p, courseTitle: "" }));
      return;
    }
    if (form.courseTitle !== hit.title || (hit.dept && form.department !== hit.dept)) {
      setForm((prev) => ({
        ...prev,
        courseTitle: hit.title || "",
        department: hit.dept && options.departments.includes(hit.dept) ? hit.dept : prev.department,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.courseCode, courseMap]);

  const handleEafSelected = (file?: File | null) => {
    const picked = file || null;
    if (!picked) {
      setForm((prev) => ({ ...prev, eafFile: null }));
      return;
    }

    const fileName = String(picked.name || "").trim();
    const ext = fileName.toLowerCase().endsWith(".pdf");
    const mime = String(picked.type || "").toLowerCase();
    const mimeOk = !mime || mime === "application/pdf" || mime === "application/octet-stream";
    if (!ext || !mimeOk) {
      setError("Please upload your EAF as a PDF file.");
      if (eafInputRef.current) eafInputRef.current.value = "";
      setForm((prev) => ({ ...prev, eafFile: null }));
      return;
    }
    if (picked.size > MAX_EAF_BYTES) {
      setError("EAF file must be 5 MB or smaller.");
      if (eafInputRef.current) eafInputRef.current.value = "";
      setForm((prev) => ({ ...prev, eafFile: null }));
      return;
    }
    setError("");
    setForm((prev) => ({ ...prev, eafFile: picked }));
  };

  const removeEafFile = () => {
    if (eafInputRef.current) eafInputRef.current.value = "";
    setForm((prev) => ({ ...prev, eafFile: null }));
  };

  const handleSubmit = async () => {
    if (!userId) {
      setError("User not logged in.");
      return;
    }
    if (editingLocked) {
      setError("Special class submissions are currently locked.");
      return;
    }
    if (!section5Ok) {
      setError("Please complete all sections, attach your EAF, and agree to the Terms and Conditions.");
      return;
    }

    try {
      setSubmitting(true);
      setError("");

      if (!form.eafFile) {
        throw new Error("Please attach your EAF file before submitting.");
      }

      const payload: SpecialClassSubmitPayload = {
        studentNumber: form.studentNumber,
        degree: form.degree,
        unitsRemaining: Number(form.unitsRemaining),
        graduatingAfterTerm: form.graduatingAfterTerm === "Yes",
        courseCode: form.courseCode,
        units: Number(form.units),
        reason: form.reason,
        reasonOther: form.reason === "Other" ? form.reasonOther.trim() : "",
        department: form.department,
        agree: true,
        eafFile: form.eafFile,
      };

      const res = await submitStudentSpecialClass(userId, payload);

      if (res?.ok && res?.application) {
        setApplications((prev) => [res.application as StudentSpecialClassView, ...prev]);

        setForm((prev) => ({
          ...prev,
          studentNumber: "",
          unitsRemaining: "",
          graduatingAfterTerm: "",
          courseCode: "",
          courseTitle: "",
          units: "",
          reason: "",
          reasonOther: "",
          department: "",
          eafFile: null,
          agree: false,
        }));
        if (eafInputRef.current) eafInputRef.current.value = "";
      } else {
        throw new Error("Submission failed.");
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Failed to submit application.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-white text-slate-900">
      <TopBar fullName={fullName} role="Student" department={profile?.program_code} inboxPath="/student/inbox" />
      <Tabs
        mode="nav"
        items={[
          { label: "Course Offerings", to: "/student/courseofferings" },
          { label: "Class Petition", to: "/student/petition" },
          { label: "Special Class", to: "/student/specialclass" },
        ]}
      />

      <main className="p-6 max-w-7xl mx-auto">
        <div className="grid xl:grid-cols-2 gap-10">
          {/* LEFT: form */}
          <section>
            <h2 className="text-xl font-bold mb-1">Special Class Application</h2>
            <p className="text-sm text-gray-600 mb-4">
              Submit an application for one (1) special class only.
            </p>

            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-5 text-sm text-amber-800">
              <div className="flex items-center gap-2 font-semibold mb-2">
                <AlertCircle className="h-4 w-4 text-amber-700" />
                Special Class Guidelines
              </div>
              <ul className="list-disc pl-5 space-y-1">
                <li>Each application is strictly for one (1) special class only.</li>
                <li>
                  The course/subject must belong to this college. If offered by another college,
                  use that college’s Google Form.
                </li>
              </ul>
            </div>

            <DeadlineBanner openISO={submissionWindow.openISO} deadlineISO={submissionWindow.deadlineISO} />

            {error && (
              <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg">
                {error}
              </div>
            )}

            {loading ? (
              <div className="text-sm text-gray-500">Loading…</div>
            ) : (
              <div className="space-y-6">
                {/* ---------- Student Information ---------- */}
                <div className="rounded-xl border border-gray-200 p-4">
                  <h3 className="font-semibold text-emerald-700 mb-3">Student Information</h3>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        First Name
                      </label>
                      <input
                        value={profile?.first_name || ""}
                        readOnly
                        className="w-full bg-gray-100 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Last Name
                      </label>
                      <input
                        value={profile?.last_name || ""}
                        readOnly
                        className="w-full bg-gray-100 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>

                  <div className="mt-4">
                    <label className="block text-sm font-semibold text-emerald-700 mb-1">
                      ID Number
                    </label>
                    <input
                      value={form.studentNumber}
                      onChange={(e) => {
                        const onlyDigits = e.target.value.replace(/\D/g, "").slice(0, 8);
                        setForm((prev) => ({ ...prev, studentNumber: onlyDigits }));
                      }}
                      disabled={editingLocked || submitting}
                      placeholder="Enter 8-digit ID number"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                    />
                  </div>

                  <div className="mt-4">
                    <label className="block text-sm font-semibold text-emerald-700 mb-1">
                      Degree Program
                    </label>
                    <SelectBox
                      value={form.degree}
                      onChange={(v) => setForm((prev) => ({ ...prev, degree: v }))}
                      options={options.programs.map((p) => p.program_code)}
                      placeholder="-- Select Degree Program --"
                      disabled={editingLocked || submitting}
                    />
                  </div>
                </div>

                {/* ---------- Degree Progress ---------- */}
                <div
                  className={`rounded-xl border p-4 ${
                    section1Ok ? "border-gray-200" : "border-gray-100 opacity-60"
                  }`}
                >
                  <h3 className="font-semibold text-emerald-700 mb-3">Degree Progress</h3>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Units Remaining (Including Current Term)
                      </label>
                      <input
                        value={form.unitsRemaining}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/\D/g, "");
                          setForm((prev) => ({ ...prev, unitsRemaining: digits }));
                        }}
                        disabled={editingLocked || submitting || !section1Ok}
                        placeholder="Number only"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Graduating After This Term?
                      </label>
                      <SelectBox
                        value={form.graduatingAfterTerm}
                        onChange={(v) => setForm((prev) => ({ ...prev, graduatingAfterTerm: v as any }))}
                        options={["Yes", "No"]}
                        placeholder="-- Select --"
                        disabled={editingLocked || submitting || !section1Ok}
                      />
                    </div>
                  </div>
                </div>

                {/* ---------- Course Request ---------- */}
                <div
                  className={`rounded-xl border p-4 ${
                    section2Ok ? "border-gray-200" : "border-gray-100 opacity-60"
                  }`}
                >
                  <h3 className="font-semibold text-emerald-700 mb-3">Course Request</h3>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Course Code
                      </label>

                      <SearchableCourseCode
                        value={form.courseCode}
                        onChange={(v) => handleCoursePick(v)}
                        options={courseCodeOptions}
                        placeholder="-- Select / Type Course Code --"
                        disabled={editingLocked || submitting || !section2Ok}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Course Title
                      </label>
                      <input
                        value={form.courseTitle}
                        readOnly
                        disabled={editingLocked || submitting || !section2Ok}
                        className="w-full bg-gray-100 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Units
                      </label>
                      <input
                        value={form.units}
                        readOnly
                        disabled={editingLocked || submitting || !section2Ok}
                        className="w-full bg-gray-100 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Department who offers the Course
                      </label>
                      <SelectBox
                        value={form.department}
                        onChange={(v) => setForm((prev) => ({ ...prev, department: v }))}
                        options={options.departments}
                        placeholder="-- Select Department --"
                        disabled={editingLocked || submitting || !section2Ok}
                      />
                    </div>
                  </div>

                  <div className="mt-4">
                    <label className="block text-sm font-semibold text-emerald-700 mb-1">
                      Reason for Application of Special Class
                    </label>
                    <SelectBox
                      value={form.reason}
                      onChange={(v) =>
                        setForm((prev) => ({
                          ...prev,
                          reason: v,
                          reasonOther: v === "Other" ? prev.reasonOther : "",
                        }))
                      }
                      options={options.reasons}
                      placeholder="-- Select Reason --"
                      disabled={editingLocked || submitting || !section2Ok}
                    />
                  </div>

                  {form.reason === "Other" && (
                    <div className="mt-3">
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Other (please specify)
                      </label>
                      <input
                        value={form.reasonOther}
                        onChange={(e) => setForm((prev) => ({ ...prev, reasonOther: e.target.value }))}
                        disabled={editingLocked || submitting || !section2Ok}
                        placeholder="Type your reason…"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                      />
                    </div>
                  )}
                </div>

                {/* ---------- EAF ---------- */}
                {section3Ok && (
                  <div className="rounded-xl border border-gray-200 p-4">
                    <h3 className="font-semibold text-emerald-700 mb-3">EAF</h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Attach your latest EAF as a PDF file before proceeding to the Terms and Conditions.
                    </p>

                    <div className={cls(
                      "rounded-xl border border-dashed p-4",
                      editingLocked || submitting ? "bg-gray-50 border-gray-200" : "bg-emerald-50/50 border-emerald-200"
                    )}>
                      {!form.eafFile ? (
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 rounded-full bg-white p-2 border border-emerald-200">
                              <Upload className="h-4 w-4 text-emerald-700" />
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-gray-900">Upload EAF</div>
                              <div className="text-sm text-gray-600">Accepted format: PDF only. Maximum file size: 5 MB.</div>
                            </div>
                          </div>

                          <div>
                            <input
                              ref={eafInputRef}
                              type="file"
                              accept={EAF_ACCEPT}
                              className="hidden"
                              disabled={editingLocked || submitting}
                              onChange={(e) => handleEafSelected(e.target.files?.[0] || null)}
                            />
                            <button
                              type="button"
                              onClick={() => eafInputRef.current?.click()}
                              disabled={editingLocked || submitting}
                              className="inline-flex items-center gap-2 rounded-lg border border-emerald-600 bg-white px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                            >
                              <Upload className="h-4 w-4" />
                              Choose File
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-start gap-3 min-w-0">
                            <div className="mt-0.5 rounded-full bg-white p-2 border border-emerald-200">
                              <FileText className="h-4 w-4 text-emerald-700" />
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-gray-900 truncate">{form.eafFile.name}</div>
                              <div className="text-sm text-gray-600">{formatFileSize(form.eafFile.size)} • PDF file attached</div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <input
                              ref={eafInputRef}
                              type="file"
                              accept={EAF_ACCEPT}
                              className="hidden"
                              disabled={editingLocked || submitting}
                              onChange={(e) => handleEafSelected(e.target.files?.[0] || null)}
                            />
                            <button
                              type="button"
                              onClick={() => eafInputRef.current?.click()}
                              disabled={editingLocked || submitting}
                              className="inline-flex items-center gap-2 rounded-lg border border-emerald-600 bg-white px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                            >
                              <Upload className="h-4 w-4" />
                              Replace File
                            </button>
                            <button
                              type="button"
                              onClick={removeEafFile}
                              disabled={editingLocked || submitting}
                              className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
                            >
                              <X className="h-4 w-4" />
                              Remove
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ---------- Terms and Condition ---------- */}
                {section4Ok && (
                  <div className="rounded-xl border border-gray-200 p-4">
                    <h3 className="font-semibold text-emerald-700 mb-3">Terms and Condition</h3>

                    <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700">
                      <li>This form must be accomplished honestly and correctly.</li>
                      <li>
                        The course must belong to this college; otherwise file through the offering
                        college’s form.
                      </li>
                      <li>The application will be forwarded to the Associate Dean and Academic Department for approval.</li>
                      <li>
                        The application is deemed final upon inclusion in the official enrollment
                        record; student can no longer withdraw.
                      </li>
                      <li>All deadlines must be complied with (Registrar enrollment schedules).</li>
                      <li>
                        Once approved, student may print revised EAF after three working days. The
                        APO will advise approval/disapproval.
                      </li>
                    </ul>

                    <label className="mt-4 flex items-center gap-2 text-sm text-gray-800">
                      <input
                        type="checkbox"
                        checked={form.agree}
                        onChange={(e) => setForm((prev) => ({ ...prev, agree: e.target.checked }))}
                        disabled={editingLocked || submitting || !section4Ok}
                        className="h-4 w-4"
                      />
                      <span>I understand and Agree</span>
                    </label>
                  </div>
                )}

                <button
                  onClick={handleSubmit}
                  disabled={editingLocked || !section5Ok || submitting}
                  className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-[#21804A] px-6 py-2 text-white font-medium hover:bg-[#18693B] disabled:opacity-60"
                >
                  <Send className="h-4 w-4" />
                  {submitting ? "Submitting…" : "Submit Application"}
                </button>
              </div>
            )}
          </section>

          {/* RIGHT: status list */}
          <section className="xl:border-l xl:pl-8 border-gray-200">
            <h2 className="text-xl font-bold mb-1">Application Status</h2>
            <p className="text-sm text-gray-600 mb-4">Track your submitted special class applications.</p>

            {applications.length === 0 ? (
              <div className="text-sm text-gray-500">No applications submitted yet.</div>
            ) : (
              applications.map((a) => <StatusCard key={a.special_id} a={a} />)
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
