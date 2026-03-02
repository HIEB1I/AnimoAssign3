import { useEffect, useMemo, useState } from "react";
import { Calendar, AlertCircle, Send } from "lucide-react";
import SelectBox from "../../component/SelectBox";
import Tabs from "../../component/Tabs";

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
};

type UserData = { userId: string; fullName: string; roles?: string[] };

type FormData = {
  degree: string;
  department: string;
  courseCode: string;
  reason: string;
  studentNumber: string;
};

/* ---------------- Status Card ---------------- */
const STATUS_PILL: Record<string, string> = {
  "Less Than Minimum": "bg-amber-100 text-amber-800",
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
        setPetitions((pet?.petitions || []) as PetitionView[]);
        if (prof && prof.ok) {
          setProfile(prof);
          setForm((prev) => ({ ...prev, degree: prof.program_code || prev.degree }));
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

  const handleSubmit = async () => {
    if (!userId) {
      setError("User not logged in.");
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
        setForm((prev) => ({ ...prev, department: "", courseCode: "", reason: "" }));
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
                    placeholder="Enter 8-digit student number"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-emerald-700 mb-1">Degree Program</label>
                  <SelectBox
                    value={form.degree}
                    onChange={(v) => setForm((prev) => ({ ...prev, degree: v }))}
                    options={options.programs.map((p) => p.program_code)}
                    placeholder="-- Select Degree Program --"
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
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-emerald-700 mb-1">Course</label>
                    <SelectBox
                      value={form.courseCode}
                      onChange={(v) => setForm((prev) => ({ ...prev, courseCode: v }))}
                      options={coursesForDeptCodes} // ONLY codes
                      disabled={!form.department}
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
                  />
                </div>

                <button
                  onClick={handleSubmit}
                  disabled={submitting}
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
