import React from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import AA_Logo from "@/assets/Images/AA_Logo.png";
import Login_BG from "@/assets/Images/login_bg.png";
import { login as apiLogin, type LoginResponse } from "@/api";

const Login: React.FC = () => {
  const [showPw, setShowPw] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState(""); // not used
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user: LoginResponse = await apiLogin(email.trim());
      localStorage.setItem("animo.user", JSON.stringify(user));

      const roles = (user.roles || []).map((r) => r.toLowerCase());
      if (roles.includes("apo")) {
        navigate("/apo/preenlistment", { replace: true });
      } else if (roles.includes("office_manager")) {
        navigate("/om/home", { replace: true });
      } else if (roles.includes("faculty")) {
        navigate("/faculty/overview", { replace: true });
      } else if (roles.includes("student")) {
        navigate("/student/petition", { replace: true });
      } else if (roles.includes("dean")) {
        navigate("/dean/dashboard", { replace: true });
      } else {
        navigate("/om/home", { replace: true });
      }
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex bg-cover bg-center" style={{ backgroundImage: `url(${Login_BG})` }}>
      <div className="hidden sm:flex flex-1 items-center justify-center">
        <div className="relative px-6">
          <img src={AA_Logo} alt="AnimoAssign Logo" className="w-[750px] h-[150px]" />
          <p className="absolute left-[115px] top-[125px] text-white text-xl font-normal">Delivering schedules that work for all.</p>
        </div>
      </div>

      <div className="min-h-screen bg-[#F5F5F5] shadow-xl ml-auto flex items-center justify-center w-full sm:w-1/2 lg:w-[520px] 2xl:w-[560px] p-6 sm:p-8">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 sm:p-8">
          <div className="mb-6 sm:mb-8">
            <h2 className="text-2xl sm:3xl font-bold">Log In</h2>
            <div className="h-1 w-16 sm:w-20 bg-[#21804A] rounded mt-2" />
          </div>

          <form className="space-y-4 sm:space-y-5" onSubmit={onSubmit}>
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1">Email Address</label>
              <input
                type="email"
                className="w-full rounded-xl bg-gray-100 border border-gray-200 px-4 py-3 shadow-inner focus:outline-none focus:ring-2 focus:ring-[#21804A]/60 focus:border-[#21804A]"
                placeholder="name@dlsu.edu.ph"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  className="w-full rounded-xl bg-gray-100 border border-gray-200 px-4 py-3 pr-11 shadow-inner focus:outline-none focus:ring-2 focus:ring-[#21804A]/60 focus:border-[#21804A]"
                  placeholder="(not required)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button type="button" onClick={() => setShowPw((s) => !s)} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                  {showPw ? <Eye className="h-5 w-5 text-gray-500" /> : <EyeOff className="h-5 w-5 text-gray-500" />}
                </button>
              </div>
            </div>

            {error && <div className="text-sm text-red-600 text-center">{error}</div>}

            <button type="submit" disabled={loading} className="w-full py-3 rounded-xl bg-[#21804A] text-white font-semibold shadow hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#21804A] disabled:opacity-60">
              {loading ? "Logging in…" : "Login"}
            </button>

            <button
              type="button"
              className="w-full py-3 rounded-xl border border-gray-300 bg-white font-medium shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 flex items-center justify-center gap-3"
              onClick={() => alert("Google SSO not yet configured")}
            >
              <span>Login with Google</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Login;
