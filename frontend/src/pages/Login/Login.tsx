import React from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, Mail, CheckCircle2, X } from "lucide-react";
import AA_Logo from "@/assets/Images/AA_Logo.png";
import { login as apiLogin, type LoginResponse } from "@/api";

function PrivacyPolicyModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Close on ESC (optional, doesn't affect login logic)
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label="Privacy Policy"
    >
      {/* Backdrop */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
        aria-label="Close privacy policy"
      />

      {/* Modal */}
      <div className="relative w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-neutral-200 px-6 py-4">
          <div>
            <div className="text-sm font-semibold text-emerald-800">AnimoAssign</div>
            <h2 className="text-xl font-bold text-slate-900">Privacy Policy</h2>
            <div className="mt-1 text-xs text-slate-500">Last updated: January 2026</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200 bg-white text-slate-700 hover:bg-neutral-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[75vh] overflow-y-auto px-6 py-5">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-slate-700">
            AnimoAssign is a student-developed capstone web application for DLSU academic workflows
            (course offerings, faculty preferences, petitions, special classes, and load assignment).
            We take privacy seriously and handle personal data in accordance with the Data Privacy
            Act of 2012 (RA 10173) and NPC guidance.
          </div>

          <div className="mt-6 space-y-6 text-sm text-slate-700 leading-relaxed">
            <section>
              <h3 className="text-base font-bold text-slate-900">1. Data Controller</h3>
              <p className="mt-2">
                <span className="font-semibold">AnimoAssign</span>{" "}
                <br />
                For privacy concerns, data access/correction, or deletion requests, contact:
                <br />
                <span className="font-semibold">Email:</span>{" "}
                <span className="text-slate-600">animoassign@dlsu.edu.ph</span>
              </p>
            </section>

            <section>
              <h3 className="text-base font-bold text-slate-900">2. Information We Collect</h3>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                <li>
                  <span className="font-semibold">Account and identity:</span> name, DLSU email,
                  system user ID, and role(s).
                </li>
                <li>
                  <span className="font-semibold">Academic/organizational:</span> department/college,
                  program assignment (if applicable), and course/section data needed to support
                  academic workflows.
                </li>
                <li>
                  <span className="font-semibold">Workflow inputs:</span> faculty preferences and
                  availability, course offering updates, petition/special class details, and related
                  remarks/status.
                </li>
                <li>
                  <span className="font-semibold">Technical data:</span> basic logs (e.g., timestamps
                  of requests, diagnostics) to help secure and maintain the service.
                </li>
              </ul>
              <p className="mt-2 text-slate-600">
                We do not request or store your email password.
              </p>
            </section>

            <section>
              <h3 className="text-base font-bold text-slate-900">3. Purpose of Processing</h3>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                <li>Authentication and role-based access control</li>
                <li>Managing academic workflows: offerings, preferences, petitions, special classes</li>
                <li>Maintaining data integrity, auditability, and troubleshooting</li>
                <li>Security monitoring and prevention of misuse</li>
                <li>Responding to user support requests (non-marketing)</li>
              </ul>
            </section>

            <section>
              <h3 className="text-base font-bold text-slate-900">4. Legal Basis</h3>
              <p className="mt-2">
                We process personal data based on consent when you use the system, legitimate
                interests in maintaining a secure and functional academic platform, and other lawful
                bases applicable to the deployment context.
              </p>
            </section>

            <section>
              <h3 className="text-base font-bold text-slate-900">5. Data Sharing</h3>
              <p className="mt-2">
                We do not sell or rent personal data. Data is only shared:
              </p>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                <li>Within the system according to role-based permissions</li>
                <li>With necessary service providers (hosting/database) operating on our behalf</li>
                <li>When required by law or lawful order</li>
              </ul>
            </section>

            <section>
              <h3 className="text-base font-bold text-slate-900">6. Storage & Retention</h3>
              <p className="mt-2">
                Data is retained only as long as needed for system operations and academic workflow
                continuity, or until deletion/anonymization is requested where feasible, subject to
                operational and academic requirements.
              </p>
            </section>

            <section>
              <h3 className="text-base font-bold text-slate-900">7. Security</h3>
              <p className="mt-2">
                We apply reasonable safeguards such as access controls, role restrictions, and secure
                configurations. No system is 100% secure; if a security incident occurs, we will take
                reasonable steps to investigate and mitigate and follow applicable notification
                guidelines.
              </p>
            </section>

            <section>
              <h3 className="text-base font-bold text-slate-900">8. Your Rights</h3>
              <p className="mt-2">
                Under the Data Privacy Act, you may request access, correction, deletion/blocking
                (where applicable), or raise concerns/complaints. Contact:{" "}
                <span className="font-semibold">animoassign@dlsu.edu.ph</span>
              </p>
            </section>

            <section>
              <h3 className="text-base font-bold text-slate-900">9. Policy Updates</h3>
              <p className="mt-2">
                We may update this policy as features or integrations change. Updates will be posted
                within the application, and significant changes may be communicated when feasible.
              </p>
            </section>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-neutral-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const Login: React.FC = () => {
  const [showPw, setShowPw] = React.useState(false);
  const [showForm, setShowForm] = React.useState(false);
  const [showPrivacy, setShowPrivacy] = React.useState(false);

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState(""); // UI only
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const user: LoginResponse = await apiLogin(email.trim());
      const roles = (user.roles || []).map((r) => r.toLowerCase());

      let dest: string | null = null;
      if (roles.includes("apo")) dest = "/apo/preenlistment";
      else if (roles.includes("office manager") || roles.includes("gs coordinator"))
        dest = "/om/load-assignment";
      else if (roles.includes("department chair") || roles.includes("deparment chair"))
        dest = "/chair";
      else if (roles.includes("faculty")) dest = "/faculty/overview";
      else if (roles.includes("student")) dest = "/student/courseofferings";
      else if (roles.includes("admin")) dest = "/admin";
      else if (roles.includes("dean")) dest = null;

      if (dest) {
        localStorage.setItem("animo.user", JSON.stringify(user));
        navigate(dest, { replace: true });
      } else {
        setError("Your account has no valid role configured. Please contact the administrator.");
      }
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-[#f5f6f7] grid place-items-center px-4 py-10">
      {/* Privacy Policy Modal (UI only; does not affect login logic) */}
      <PrivacyPolicyModal open={showPrivacy} onClose={() => setShowPrivacy(false)} />

      <div className="w-full max-w-6xl overflow-hidden rounded-2xl bg-white shadow-[0_10px_30px_rgba(0,0,0,0.12)]">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          {/* LEFT PANEL */}
          <div className="p-8 sm:p-10">
            <h1 className="text-3xl font-bold text-slate-900">Log in or sign up now!</h1>
            <p className="mt-2 text-sm text-slate-600">
              Use your DLSU email address to continue with AnimoAssign.
            </p>

            {/* LEFT-ALIGNED BUTTON */}
            <div className="mt-7">
              <button
                type="button"
                onClick={() => {
                  setShowForm(true);
                  setError(null);
                }}
                className="
                  group inline-flex w-full max-w-xl items-center justify-center gap-3
                  rounded-xl border border-neutral-300 bg-white px-6 py-3
                  text-sm font-semibold text-slate-900 shadow-sm
                  transition
                  hover:border-emerald-700 hover:bg-emerald-700 hover:text-white
                  focus:outline-none focus:ring-2 focus:ring-emerald-500/30
                "
              >
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-transparent">
                  <Mail className="h-5 w-5 text-slate-700 transition group-hover:text-white" />
                </span>

                <span>Login with your DLSU Google Account</span>
              </button>
            </div>

            <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
              By using AnimoAssign, you agree to follow the guidelines outlined in the{" "}
              <a
                href="https://www.dlsu.edu.ph/wp-content/uploads/pdf/osa/student-handbook.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-slate-700"
              >
                DLSU Student Handbook
              </a>{" "}
              and{" "}
              <button
                type="button"
                onClick={() => setShowPrivacy(true)}
                className="underline hover:text-slate-700"
              >
                Privacy Policy
              </button>{" "}
              of AnimoAssign.
            </p>

            {/* Reveal Email/Password AFTER clicking */}
            {showForm && (
              <div className="mt-7 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                <form className="space-y-4" onSubmit={onSubmit}>
                  <div>
                    <label className="block text-sm font-medium text-slate-900 mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      className="
                        w-full rounded-xl bg-gray-100 border border-gray-200
                        px-4 py-3 shadow-inner
                        focus:outline-none focus:ring-2 focus:ring-emerald-600/40 focus:border-emerald-600
                      "
                      placeholder="name@dlsu.edu.ph"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoComplete="email"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-900 mb-1">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPw ? "text" : "password"}
                        className="
                          w-full rounded-xl bg-gray-100 border border-gray-200
                          px-4 py-3 pr-11 shadow-inner
                          focus:outline-none focus:ring-2 focus:ring-emerald-600/40 focus:border-emerald-600
                        "
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPw((s) => !s)}
                        className="absolute inset-y-0 right-0 pr-3 flex items-center"
                        aria-label="Toggle password visibility"
                      >
                        {showPw ? (
                          <Eye className="h-5 w-5 text-gray-500" />
                        ) : (
                          <EyeOff className="h-5 w-5 text-gray-500" />
                        )}
                      </button>
                    </div>
                  </div>

                  {error && <div className="text-sm text-red-600 text-center">{error}</div>}

                  <button
                    type="submit"
                    disabled={loading}
                    className="
                      w-full py-3 rounded-xl bg-emerald-700 text-white font-semibold
                      shadow hover:brightness-110
                      focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-700/40
                      disabled:opacity-60
                    "
                  >
                    {loading ? "Logging in…" : "Login"}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setShowForm(false);
                      setError(null);
                    }}
                    className="w-full rounded-xl border border-neutral-300 bg-white py-3 text-sm font-medium hover:bg-neutral-50"
                  >
                    Back
                  </button>
                </form>
              </div>
            )}
          </div>

          {/* RIGHT PANEL */}
          <div className="relative overflow-hidden bg-gradient-to-b from-emerald-900 via-emerald-800 to-emerald-700 text-white">
            <div className="flex h-full flex-col items-center justify-center px-8 py-12 text-center">
              <div className="text-sm font-semibold opacity-95">Welcome to</div>

              <img
                src={AA_Logo}
                alt="AnimoAssign"
                className="mt-2 w-[360px] sm:w-[420px] max-w-full"
              />

              <p className="mt-4 max-w-md text-sm text-white/85">
                AnimoAssign is a collaborative platform for centralizing course offerings, faculty
                preferences, petitions, and special classes.
              </p>

              <div className="mt-7 w-full max-w-md">
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-white/25" />
                  <div className="text-xs font-bold tracking-widest">WHAT CAN YOU DO?</div>
                  <div className="h-px flex-1 bg-white/25" />
                </div>

                <ul className="mt-6 space-y-4 text-left text-sm">
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 mt-0.5" />
                    <span>Manage course offerings across campuses.</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 mt-0.5" />
                    <span>Smart algorithm for optimal faculty-course matching.</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 mt-0.5" />
                    <span>Submit and track teaching preferences for scheduling.</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 mt-0.5" />
                    <span>Process student petitions and special classes.</span>
                  </li>
                </ul>
              </div>

              <div className="mt-10 w-full max-w-md">
                <div className="h-px w-full bg-white/20" />
                <div className="mt-4 text-xs text-white/80">College of Computer Studies</div>
              </div>
            </div>
          </div>
          {/* END RIGHT */}
        </div>
      </div>
    </div>
  );
};

export default Login;
