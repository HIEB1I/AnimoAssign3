import { useEffect, useState, useMemo } from "react";
import { Calendar, AlertCircle, Send } from "lucide-react";
import TopBar from "../../component/TopBar";
import SelectBox from "../../component/SelectBox";
import {
  getStudentPetitions,
  submitStudentPetition,
  getStudentOptions,
  getStudentProfile,
} from "../../api";

/* ---------- Interfaces ---------- */
interface PetitionDoc {
  petition_id: string;
  student_id: string;
  course_id: string;
  reason: string;
  status: string;
  submitted_at: string;
}

interface FormData {
  degree: string;
  department: string;
  courseCode: string;
  reason: string;
}

interface OptionsData {
  departments: string[];
  courses: { course_code: string; dept_name: string; course_title: string }[];
  programs: { program_id: string; program_name: string }[];
}

interface ProfileData {
  first_name: string;
  last_name: string;
  student_number: string;
  program_name: string;
}

interface UserData {
  userId: string;
  fullName: string;
  roles?: string[];
}

/* ---------- Status Card ---------- */
function StatusCard({ code, submitted, reason, status }: any) {
  const colors: Record<string, string> = {
    PENDING: "bg-gray-100 text-gray-600 border border-gray-200",
    APPROVED: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    REJECTED: "bg-red-50 text-red-700 border border-red-200",
  };

  return (
    <div className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm mb-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-semibold text-emerald-700">{code}</h3>
        <span className={`px-3 py-1 text-xs rounded-full font-medium ${colors[status] || ""}`}>
          {status}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
        <Calendar className="h-4 w-4" /> Submitted: {submitted}
      </div>
      <div className="mt-2 text-sm bg-gray-100 rounded-md px-2 py-1">
        <span className="font-medium">Reason:</span> {reason}
      </div>
    </div>
  );
}

/* ---------- Main ---------- */
export default function STUDENT_Petition() {
  const user: UserData | null = (() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  })();

  const userId: string | null = user?.userId ?? null;
  const fullName = user?.fullName ?? "Student";

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [form, setForm] = useState<FormData>({
    degree: "",
    department: "",
    courseCode: "",
    reason: "",
  });
  const [options, setOptions] = useState<OptionsData>({
    departments: [],
    courses: [],
    programs: [],
  });
  const [petitions, setPetitions] = useState<PetitionDoc[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const [optRes, petRes, profRes] = await Promise.all([
          getStudentOptions(userId),
          getStudentPetitions(userId),
          getStudentProfile(userId),
        ]);
        setOptions(optRes);
        setPetitions(petRes.petitions || []);
        if (profRes && profRes.ok) {
        setProfile({
          first_name: profRes.first_name,
          last_name: profRes.last_name,
          student_number: profRes.student_number,
          program_name: profRes.program_name,
        });
      } else {
        console.warn("Profile not found or missing fields:", profRes);
      }
        setForm((prev) => ({ ...prev, degree: profRes.program_name }));
      } catch (e) {
        console.error("Error loading data:", e);
      }
    })();
  }, [userId]);

  const handleSubmit = async () => {
    if (!userId) {
      setError("User not logged in.");
      return;
    }
    if (!form.department || !form.courseCode || !form.reason) {
      setError("Please fill out all required fields.");
      return;
    }
    try {
      const res = await submitStudentPetition(userId, form);
      if (res.ok) {
        setPetitions([res.petition, ...petitions]);
        setForm({ ...form, department: "", courseCode: "", reason: "" });
        setError("");
      } else {
        setError("Submission failed.");
      }
    } catch (e: any) {
      setError(e.response?.data?.detail || "Failed to submit petition.");
    }
  };

  return (
    <div className="min-h-screen w-full bg-white text-slate-900">
      <TopBar fullName={fullName} role="Student" />

      <main className="p-6 max-w-7xl mx-auto">
        <div className="grid xl:grid-cols-2 gap-10">
          {/* ---------- Left Panel ---------- */}
          <section>
            <h2 className="text-xl font-bold mb-1">Section Petition Form</h2>
            <p className="text-sm text-gray-600 mb-4">
              Submit a petition to request additional sections or slots.
            </p>

            {/* Petition Guidelines */}
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-5 text-sm text-amber-800">
              <div className="flex items-center gap-2 font-semibold mb-2">
                <AlertCircle className="h-4 w-4 text-amber-700" />
                Petition Guidelines
              </div>
              <ul className="list-disc pl-5 space-y-1">
                <li>Only 1 course petition per student allowed</li>
                <li>Petitions are subject to faculty availability</li>
                <li>Invalid reasons: professor preference</li>
                <li>Not offered courses will NOT be entertained</li>
              </ul>
            </div>

            {error && (
              <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg">
                {error}
              </div>
            )}

            <div className="space-y-4">
              {/* Auto-filled Info */}
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
                  value={profile?.student_number || ""}
                  readOnly
                  className="w-full bg-gray-100 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-emerald-700 mb-1">Degree Program</label>
                <SelectBox
                  value={form.degree}
                  onChange={(v) => setForm({ ...form, degree: v })}
                  options={options.programs.map((p) => p.program_name)}
                  placeholder="-- Select Degree Program --"
                />
              </div>

              {/* Department & Course */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-emerald-700 mb-1">Course Department</label>
                  <SelectBox
                    value={form.department}
                    onChange={(v) => setForm({ ...form, department: v, courseCode: "" })}
                    options={options.departments}
                    placeholder="-- Select Department --"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-emerald-700 mb-1">Course</label>
                  <SelectBox
                    value={form.courseCode}
                    onChange={(v) => setForm({ ...form, courseCode: v })}
                    options={options.courses
                      .filter((c) => c.dept_name === form.department)
                      .map((c) => `${c.course_code}`)}
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
                  onChange={(v) => setForm({ ...form, reason: v })}
                  options={["Out of Slots", "Schedule Conflict"]}
                  placeholder="-- Select Reason --"
                />
              </div>

              <button
                onClick={handleSubmit}
                className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-[#21804A] px-6 py-2 text-white font-medium hover:bg-[#18693B]"
              >
                <Send className="h-4 w-4" /> Submit Petition
              </button>
            </div>
          </section>

          {/* ---------- Right Panel ---------- */}
          <section className="xl:border-l xl:pl-8 border-gray-200">
            <h2 className="text-xl font-bold mb-1">Petition Status</h2>
            <p className="text-sm text-gray-600 mb-4">
              Track your submitted petitions.
            </p>

            {petitions.length === 0 ? (
              <div className="text-sm text-gray-500">No petitions submitted yet.</div>
            ) : (
              petitions.map((p) => (
                <StatusCard
                  key={p.petition_id}
                  code={p.course_id}
                  submitted={new Date(p.submitted_at).toLocaleDateString()}
                  reason={p.reason}
                  status={p.status}
                />
              ))
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
