// frontend/src/pages/STUDENT/STUDENT_SpecialClass.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Calendar, AlertCircle, Send, UserCircle, LogOut } from "lucide-react";

import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";

import {
  getStudentSpecialClassOptions,
  getStudentSpecialClassProfile,
  getStudentSpecialClasses,
  submitStudentSpecialClass,
  type SpecialClassOptions,
  type SpecialClassSubmitPayload,
  type SpecialClassView,
} from "../../api";

/* ---------------- Inline TopBar (matches Petition) ---------------- */
function TopBarInline({
  fullName,
  role,
  department,
}: {
  fullName: string;
  role: string;
  department?: string;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (!headerRef.current) return;
    const el = headerRef.current;
    const setVar = () =>
      document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    setVar();
    const ro = new ResizeObserver(setVar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const logout = () => {
    localStorage.removeItem("authToken");
    sessionStorage.clear();
    navigate("/login");
  };

  return (
    <header className="sticky top-0 z-[80]" ref={headerRef}>
      <div className="w-full border-b border-emerald-900/30 bg-gradient-to-r from-emerald-800 via-emerald-700 to-green-600">
        <div className="mx-auto flex w-full items-center justify-between px-5 py-4 text-white">
          <div ref={wrapperRef} className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="group flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-white/10"
            >
              <span className="grid h-10 w-10 place-items-center rounded-full bg-white/20">
                <UserCircle className="h-6 w-6" />
              </span>
              <span className="leading-tight text-left">
                <div className="text-[17px] font-semibold">{fullName}</div>
                <div className="text-[12px] opacity-90">
                  {role}
                  {department && ` | ${department}`}
                </div>
              </span>
            </button>

            {menuOpen && (
              <div className="absolute left-0 top-full z-[90] mt-2 w-56 rounded-2xl border border-neutral-200 bg-white text-slate-800 shadow-2xl">
                <div className="px-4 pb-2 pt-3 text-[15px] font-semibold text-emerald-700">
                  My Account
                </div>
                <div className="mx-4 h-px bg-neutral-200" />
                <button
                  onClick={logout}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left text-[15px] hover:bg-neutral-50"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            )}
          </div>

          <div />
        </div>
        <div className="h-[2px] w-full bg-neutral-200/80" />
      </div>
    </header>
  );
}

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

  // Terms
  agree: boolean;
};

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
            // allow typing without forcing a selection
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
          className={`w-full bg-transparent outline-none ${
            disabled ? "cursor-not-allowed" : ""
          }`}
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
            Tip: Type to search, press <span className="font-semibold">Enter</span> to use what you typed.
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Status Card (matches Petition styling) ---------------- */
function StatusCard({ a }: { a: SpecialClassView }) {
  const pill =
    a.status?.toLowerCase().includes("approved")
      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
      : a.status?.toLowerCase().includes("disapproved") ||
        a.status?.toLowerCase().includes("rejected")
      ? "bg-red-50 text-red-700 border border-red-200"
      : "bg-gray-100 text-gray-600 border border-gray-200";

  const ayLabel = (() => {
    const n = Number.parseInt(String(a.acad_year_start ?? ""), 10);
    return Number.isFinite(n) ? `AY ${n}-${n + 1}` : "AY —";
  })();

  return (
    <div className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm mb-4">
      <div className="flex items-center justify-between mb-1">
        <div>
          <h3 className="font-semibold text-emerald-700">{a.course_code}</h3>
          <div className="text-sm text-gray-600">{a.course_title || " "}</div>
          <div className="text-xs text-gray-500 mt-1">
            {ayLabel} · Term {a.term_number ?? "—"}
          </div>
        </div>
        <span className={`px-3 py-1 text-xs rounded-full font-medium ${pill}`}>{a.status}</span>
      </div>

      <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
        <Calendar className="h-4 w-4" />
        Submitted: {new Date(a.submitted_at).toLocaleDateString()}
      </div>

      <div className="mt-2 text-sm text-gray-600">
        <span className="font-medium">Department:</span>{" "}
        {a.department_name ? a.department_name : <span className="text-gray-400">—</span>}
      </div>

      <div className="mt-2 text-sm text-gray-600">
        <span className="font-medium">Units Remaining:</span>{" "}
        <span className="tabular-nums">{a.units_remaining ?? 0}</span>
        {" · "}
        <span className="font-medium">Graduating:</span> {a.graduating_after_term ? "Yes" : "No"}
      </div>

      <div className="mt-2 text-sm bg-gray-100 rounded-md px-2 py-1">
        <span className="font-medium">Reason:</span>{" "}
        {a.reason === "Other" ? a.reason_other || "Other" : a.reason}
      </div>

      <div className="mt-2 text-sm text-gray-600">
        <span className="font-medium">Remarks:</span>{" "}
        {a.remarks ? a.remarks : <span className="text-gray-400">—</span>}
      </div>
    </div>
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

  const [applications, setApplications] = useState<SpecialClassView[]>([]);

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
    agree: false,
  });

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");

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
        setApplications((apps?.applications || []) as SpecialClassView[]);

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
      const code = String(c.course_code || "").trim().toUpperCase();
      if (!code) continue;
      m.set(code, {
        title: c.course_title || "",
        dept: c.dept_name || "",
        units: Number((c as any).units ?? 0),
      });
    }
    return m;
  }, [options.courses]);

  const courseCodeOptions = useMemo(() => {
    // for dropdown list
    return options.courses.map((c) => String(c.course_code || "").trim().toUpperCase()).filter(Boolean);
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

  const section4Ok = section3Ok && form.agree === true;

  const handleCoursePick = (code: string) => {
    const cleaned = String(code || "").trim().toUpperCase();
    const hit = courseMap.get(cleaned);

    setForm((prev) => ({
      ...prev,
      courseCode: cleaned,
      courseTitle: hit?.title || "",
      department:
        hit?.dept && options.departments.includes(hit.dept) ? hit.dept : prev.department,
    }));
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
    // only update if different to avoid loops
    if (form.courseTitle !== hit.title || (hit.dept && form.department !== hit.dept)) {
      setForm((prev) => ({
        ...prev,
        courseTitle: hit.title || "",
        department:
          hit.dept && options.departments.includes(hit.dept) ? hit.dept : prev.department,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.courseCode, courseMap]);

  const handleSubmit = async () => {
    if (!userId) {
      setError("User not logged in.");
      return;
    }
    if (!section4Ok) {
      setError("Please complete all sections and agree to the Terms and Conditions.");
      return;
    }

    try {
      setSubmitting(true);
      setError("");

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
      };

      const res = await submitStudentSpecialClass(userId, payload);

      if (res?.ok && res?.application) {
        setApplications((prev) => [res.application as SpecialClassView, ...prev]);

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
          agree: false,
        }));
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
      <TopBarInline fullName={fullName} role="Student" />
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
                      placeholder="Enter 8-digit ID number"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
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
                        disabled={!section1Ok}
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
                        onChange={(v) =>
                          setForm((prev) => ({ ...prev, graduatingAfterTerm: v as any }))
                        }
                        options={["Yes", "No"]}
                        placeholder="-- Select --"
                        disabled={!section1Ok}
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

                      {/* ✅ Dropdown + Typable search */}
                      <SearchableCourseCode
                        value={form.courseCode}
                        onChange={(v) => handleCoursePick(v)}
                        options={courseCodeOptions}
                        placeholder="-- Select / Type Course Code --"
                        disabled={!section2Ok}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Course Title
                      </label>
                      <input
                        value={form.courseTitle}
                        readOnly
                        disabled={!section2Ok}
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
                        onChange={(e) => {
                          const digits = e.target.value.replace(/\D/g, "");
                          setForm((prev) => ({ ...prev, units: digits }));
                        }}
                        disabled={!section2Ok}
                        placeholder="Number only"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
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
                        disabled={!section2Ok}
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
                      disabled={!section2Ok}
                    />
                  </div>

                  {form.reason === "Other" && (
                    <div className="mt-3">
                      <label className="block text-sm font-semibold text-emerald-700 mb-1">
                        Other (please specify)
                      </label>
                      <input
                        value={form.reasonOther}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, reasonOther: e.target.value }))
                        }
                        disabled={!section2Ok}
                        placeholder="Type your reason…"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                      />
                    </div>
                  )}
                </div>

                {/* ---------- Terms and Condition ---------- */}
                {section3Ok && (
                  <div className="rounded-xl border border-gray-200 p-4">
                    <h3 className="font-semibold text-emerald-700 mb-3">Terms and Condition</h3>

                    <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700">
                      <li>This form must be accomplished honestly and correctly.</li>
                      <li>
                        The course must belong to this college; otherwise file through the offering
                        college’s form.
                      </li>
                      <li>
                        The application will be forwarded to the Associate Dean and Academic
                        Department for approval.
                      </li>
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
                        className="h-4 w-4"
                      />
                      <span>I understand and Agree</span>
                    </label>
                  </div>
                )}

                <button
                  onClick={handleSubmit}
                  disabled={!section4Ok || submitting}
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
            <p className="text-sm text-gray-600 mb-4">
              Track your submitted special class applications.
            </p>

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
