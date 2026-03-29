import { useEffect, useMemo, useState } from "react";
import { Calendar, AlertCircle, Send } from "lucide-react";
import SelectBox from "../../component/SelectBox";
import Tabs from "../../component/Tabs";
import { cls } from "../../utilities/cls";

import TopBar from "../../component/TopBar";
import {
  getStudentPetitions,
  submitStudentPetition,
  getStudentOptions,
  getStudentProfile,
  type StudentOptions,
  type PetitionSubmitPayload,
  type PetitionView
} from "../../api";

/* ---------------- Local Types ---------------- */
type ProfileData = {
  ok: boolean;
  first_name: string;
  last_name: string;
  student_number: string;
  program_code?: string;
  lock_student_number?: boolean;
  lock_degree?: boolean;
};

type UserData = { userId: string; fullName: string; roles?: string[] };

type FormData = {
  degree: string;
  department: string;
  courseCode: string;
  reason: string;
  studentNumber: string;
};

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

/* ---------------- Status Card ---------------- */
const STATUS_PILL: Record<string, string> = {
  "Less Than Minimum": "bg-gray-200 text-gray-700",
  "Forwarded To Department": "bg-amber-50 text-amber-800",
  "Rejected": "bg-red-100 text-red-800",
  "Wait For Frosh Block": "bg-purple-100 text-purple-800",
  "Wait For College Enlistment": "bg-yellow-100 text-yellow-800",
  "Open Slots Available": "bg-green-100 text-green-800",
  "New Class Opened": "bg-green-100 text-green-800",
  "Advised For Special Class": "bg-indigo-100 text-indigo-800",
  "Slots Increased": "bg-teal-100 text-teal-800",
};

function pillClass(status?: string) {
  if (!status) return "bg-gray-100 text-gray-600 border border-gray-200";
  const exact = STATUS_PILL[status];
  if (exact) return `${exact} border border-black/5`;
  const s = status.toLowerCase();
  if (s.includes("rejected")) return "bg-red-100 text-red-800 border border-black/5";
  if (s.includes("approved") || s.includes("opened") || s.includes("open slots") || s.includes("new class"))
    return "bg-green-100 text-green-800 border border-black/5";
  if (s.includes("wait")) return "bg-yellow-100 text-yellow-800 border border-black/5";
  return "bg-gray-100 text-gray-600 border border-gray-200";
}

function StatusCard({ p }: { p: PetitionView }) {
  const pill = pillClass(p.status);

  // Build "AY 2024-2025" from acad_year_start (number or string)
  const ayLabel = (() => {
    const n = Number.parseInt(String(p.acad_year_start ?? ""), 10);
    return Number.isFinite(n) ? `AY ${n}-${n + 1}` : "AY —";
    })();

  return (
    <div className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm mb-4">
      <div className="flex items-center justify-between mb-1">
        <div>
          <h3 className="font-semibold text-emerald-700">{p.course_code}</h3>
          <div className="text-sm text-gray-600">{p.course_title || " "}</div>
          <div className="text-xs text-gray-500 mt-1">
            {ayLabel} · Term {p.term_number ?? "—"}
          </div>
        </div>
        <span className={`px-3 py-1 text-xs rounded-full font-medium ${pill}`}>{p.status}</span>
      </div>

      <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
        <Calendar className="h-4 w-4" />
        Submitted: {new Date(p.submitted_at).toLocaleDateString()}
      </div>

      <div className="mt-2 text-sm bg-gray-100 rounded-md px-2 py-1">
        <span className="font-medium">Reason:</span> {p.reason}
      </div>

      <div className="mt-2 text-sm text-gray-600">
        <span className="font-medium">Remarks:</span>{" "}
        {p.remarks ? p.remarks : <span className="text-gray-400">—</span>}
      </div>
    </div>
  );
}

/* ---------------- Page ---------------- */
export default function STUDENT_Petition() {
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
  const [options, setOptions] = useState<StudentOptions>({
    ok: false,
    departments: [],
    courses: [],
    programs: [],
    reasons: [],
    statuses: [],
  });

  const [petitions, setPetitions] = useState<PetitionView[]>([]);
  const [form, setForm] = useState<FormData>({
    degree: "",
    department: "",
    courseCode: "",
    reason: "",
    studentNumber: "",
  });

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [submissionWindow, setSubmissionWindow] = useState<{ openISO: string; deadlineISO: string }>({ openISO: "", deadlineISO: "" });

  const { past: openPassedPage } = useCountdown(submissionWindow.openISO || "");
  const { past: deadlinePassedPage } = useCountdown(submissionWindow.deadlineISO || "");
  const editingLocked = !submissionWindow.openISO || !submissionWindow.deadlineISO || !openPassedPage || deadlinePassedPage;

  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        setLoading(true);
        const [opt, pet, prof] = await Promise.all([
          getStudentOptions(userId),
          getStudentPetitions(userId),
          getStudentProfile(userId),
        ]);
        setOptions(opt);
        setSubmissionWindow({
          openISO: opt?.submission_window?.openISO || "",
          deadlineISO: opt?.submission_window?.deadlineISO || "",
        });
        setPetitions((pet?.petitions || []) as PetitionView[]);
        if (prof && prof.ok) {
          setProfile(prof);
          setForm((prev) => ({
            ...prev,
            degree: prof.program_code || prev.degree,
            studentNumber: prof.student_number || prev.studentNumber,
          }));
        } else {
          setProfile({ ok: false, first_name: "", last_name: "", student_number: "" });
        }
      } catch (e: any) {
        setError(e?.response?.data?.detail || e?.message || "Failed to load petition data.");
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  const coursesForDeptCodes = useMemo(() => {
    if (!form.department) return [];
    return options.courses.filter((c) => c.dept_name === form.department).map((c) => c.course_code);
  }, [options.courses, form.department]);

  const studentNumberLocked = !!profile?.lock_student_number;
  const degreeLocked = !!profile?.lock_degree;

  const handleSubmit = async () => {
    if (!userId) {
      setError("User not logged in.");
      return;
    }
    if (editingLocked) {
      setError("Petition submissions are currently locked.");
      return;
    }
    if (!form.department || !form.courseCode || !form.reason || !form.degree) {
      setError("Please fill out all required fields.");
      return;
    }
    if (!/^\d{8}$/.test(form.studentNumber)) {
      setError("Student number must be exactly 8 digits.");
      return;
    }
    try {
      setSubmitting(true);
      setError("");
      const res = await submitStudentPetition(userId, form as PetitionSubmitPayload);
      if (res?.ok && res?.petition) {
        setPetitions((prev) => [res.petition as PetitionView, ...prev]);
        setProfile((prev) => prev ? ({ ...prev, student_number: form.studentNumber || prev.student_number, program_code: form.degree || prev.program_code, lock_student_number: true, lock_degree: true }) : prev);
        setForm((prev) => ({ ...prev, department: "", courseCode: "", reason: "", studentNumber: prev.studentNumber, degree: prev.degree }));
      } else {
        throw new Error("Submission failed.");
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Failed to submit petition.");
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
          { label: "Special Class", to: "/student/specialclass" }
        ]}
      />

      <main className="p-6 max-w-7xl mx-auto">
        <div className="grid xl:grid-cols-2 gap-10">
          {/* LEFT: form */}
          <section>
            <h2 className="text-xl font-bold mb-1">Class Petition Form</h2>
            <p className="text-sm text-gray-600 mb-4">
              Submit a petition to request additional sections or slots.
            </p>

            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-5 text-sm text-amber-800">
              <div className="flex items-center gap-2 font-semibold mb-2">
                <AlertCircle className="h-4 w-4 text-amber-700" />
                Petition Guidelines
              </div>
              <ul className="list-disc pl-5 space-y-1">
                <li>Only 1 course petition per student allowed</li>
                <li>Petitions are subject to faculty availability</li>
                <li>Invalid reasons: professor preference</li>
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
              <div className="space-y-4">
                {/* Auto-filled */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-emerald-700 mb-1">First Name</label>
                    <input
                      value={profile?.first_name || ""}
                      readOnly
                      className="w-full bg-gray-100 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-emerald-700 mb-1">Last Name</label>
                    <input
                      value={profile?.last_name || ""}
                      readOnly
                      className="w-full bg-gray-100 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-emerald-700 mb-1">Student Number</label>
                  <input
                    value={form.studentNumber}
                    onChange={(e) => {
                      const onlyDigits = e.target.value.replace(/\D/g, "").slice(0, 8);
                      setForm((prev) => ({ ...prev, studentNumber: onlyDigits }));
                    }}
                    disabled={editingLocked || submitting || studentNumberLocked}
                    placeholder="Enter 8-digit student number"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-emerald-700 mb-1">Degree Program</label>
                  <SelectBox
                    value={form.degree}
                    onChange={(v) => setForm((prev) => ({ ...prev, degree: v }))}
                    options={options.programs.map((p) => p.program_code)}
                    placeholder="-- Select Degree Program --"
                    disabled={editingLocked || submitting || degreeLocked}
                  />
                </div>

                {/* Department & Course */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-emerald-700 mb-1">Course Department</label>
                    <SelectBox
                      value={form.department}
                      onChange={(v) => setForm((prev) => ({ ...prev, department: v, courseCode: "" }))}
                      options={options.departments}
                      placeholder="-- Select Department --"
                      disabled={editingLocked || submitting}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-emerald-700 mb-1">Course</label>
                    <SelectBox
                      value={form.courseCode}
                      onChange={(v) => setForm((prev) => ({ ...prev, courseCode: v }))}
                      disabled={editingLocked || submitting || !form.department}
                      options={coursesForDeptCodes}
                      placeholder="-- Select Course --"
                    />
                  </div>
                </div>

                {/* Reason */}
                <div>
                  <label className="block text-sm font-semibold text-emerald-700 mb-1">Reason</label>
                  <SelectBox
                    value={form.reason}
                    onChange={(v) => setForm((prev) => ({ ...prev, reason: v }))}
                    options={options.reasons}
                    placeholder="-- Select Reason --"
                    disabled={editingLocked || submitting}
                  />
                </div>

                <button
                  onClick={handleSubmit}
                  disabled={editingLocked || submitting}
                  className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-[#21804A] px-6 py-2 text-white font-medium hover:bg-[#18693B] disabled:opacity-60"
                >
                  <Send className="h-4 w-4" />
                  {submitting ? "Submitting…" : "Submit Petition"}
                </button>
              </div>
            )}
          </section>

          {/* RIGHT: status list */}
          <section className="xl:border-l xl:pl-8 border-gray-200">
            <h2 className="text-xl font-bold mb-1">Petition Status</h2>
            <p className="text-sm text-gray-600 mb-4">Track your submitted petitions.</p>

            {petitions.length === 0 ? (
              <div className="text-sm text-gray-500">No petitions submitted yet.</div>
            ) : (
              petitions.map((p) => <StatusCard key={p.petition_id} p={p} />)
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
