import React from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, Lock, CheckCircle2, Mail } from "lucide-react";
import AA_Logo from "@/assets/Images/AA_Logo.png";
import { loginWithPassword, type LoginResponse } from "@/api";
import { useGoogleLogin } from "@react-oauth/google";

const Login: React.FC = () => {
  const [showPw, setShowPw] = React.useState(false);

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState(""); // UI only
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const navigate = useNavigate();

function finishLogin(user: LoginResponse) {
  const roles = (user.roles || []).map((r) => (r || "").toLowerCase());

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

  if (!dest) {
    setError("Your account has no valid role configured. Please contact the administrator.");
    return;
  }

    localStorage.setItem("animo.user", JSON.stringify(user));
    navigate(dest, { replace: true });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const user: LoginResponse = await loginWithPassword(email.trim(), password);
      finishLogin(user);
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  const googleLogin = useGoogleLogin({
    flow: "auth-code",
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events",
    ].join(" "),
    onSuccess: async (codeResponse) => {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch("/api/auth/google/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: codeResponse.code }),
        });

        if (!res.ok) throw new Error(await res.text());

        const user: LoginResponse = await res.json();
        finishLogin(user);
      } catch (e: any) {
        setError(e?.message || "Google login failed.");
      } finally {
        setLoading(false);
      }
    },
    onError: () => setError("Google sign-in failed. Please try again."),
  });

  return (
    <div className="min-h-screen w-full bg-[#f5f6f7] grid place-items-center px-4 py-10">
      <div className="w-full max-w-6xl overflow-hidden rounded-2xl bg-white shadow-[0_10px_30px_rgba(0,0,0,0.12)]">
        <div className="grid grid-cols-1 lg:grid-cols-2">
          {/* LEFT PANEL */}
          <div className="p-8 sm:p-10">
            <h1 className="text-3xl font-bold text-slate-900">Log in or sign up now!</h1>
            <p className="mt-2 text-sm text-slate-600">
              Use your DLSU email address to continue with AnimoAssign.
            </p>

            {error && (
              <div className="mt-5 max-w-xl rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="mt-7 w-full max-w-xl">
              <form className="space-y-4" onSubmit={onSubmit}>
                {/* EMAIL */}
                <div className="relative">
                  <Mail
                    className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden="true"
                  />

                  <input
                    type="email"
                    className="w-full rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 pl-11 shadow-inner focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/40"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (error) setError(null);
                    }}
                    required
                    autoComplete="email"
                  />
                </div>

                {/* PASSWORD */}
                <div className="relative">
                  <Lock
                    className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden="true"
                  />

                  <input
                    type={showPw ? "text" : "password"}
                    className="w-full rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 pl-11 pr-11 shadow-inner focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/40"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    autoComplete="current-password"
                    required
                  />

                  <button
                    type="button"
                    aria-label={showPw ? "Hide password" : "Show password"}
                    onClick={() => setShowPw((s) => !s)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3"
                  >
                    {showPw ? (
                      <Eye className="h-5 w-5 text-gray-500" />
                    ) : (
                      <EyeOff className="h-5 w-5 text-gray-500" />
                    )}
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-xl bg-emerald-700 py-3 font-semibold text-white shadow hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-emerald-700/40 focus:ring-offset-2 disabled:opacity-60"
                >
                  {loading ? "Logging in…" : "Login"}
                </button>
              </form>

              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-neutral-200" />
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  or
                </div>
                <div className="h-px flex-1 bg-neutral-200" />
              </div>

              {/* GOOGLE LOGIN with Google icon */}
              <button
                type="button"
                onClick={() => googleLogin()}
                disabled={loading}
                className="group inline-flex w-full items-center justify-center gap-3 rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:border-emerald-700 hover:bg-emerald-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:opacity-60"
              >
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-transparent shadow-none">
                <img
                  src="/google.png"
                  alt="Google"
                  className="h-5 w-5 bg-transparent"
                  draggable={false}
                />
              </span>
                <span>Login with your DLSU Google Account</span>
              </button>

            </div>

            <p className="mt-5 max-w-xl text-[11px] leading-relaxed text-slate-500">
              By using AnimoAssign, you agree to follow the guidelines outlined in the{" "}
              <a
                href="https://www.dlsu.edu.ph/wp-content/uploads/pdf/osa/student-handbook.pdf"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-emerald-700"
              >
                DLSU Student Handbook
              </a> and{" "}
              <span className="underline">Privacy Policy</span> of AnimoAssign.
            </p>
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
