import React from "react";
import { Eye, EyeOff } from "lucide-react";

// Import logo (path is relative to src)
import AA_Logo from "@/assets/Images/AA_Logo.png";
import Login_BG from "@/assets/Images/login_bg.png";


const Login: React.FC = () => {
  const [showPw, setShowPw] = React.useState(false);

  return (
    <div
      className="min-h-screen w-full flex bg-cover bg-center"
      style={{ backgroundImage: `url(${Login_BG})` }} 
    >
      {/* Left panel with logo */}
      <div className="hidden sm:flex flex-1 items-center justify-center">
        <div className="relative px-6">
          {/* Logo image */}
          <img
            src={AA_Logo}
            alt="AnimoAssign Logo"
            className="w-[750px] h-[150px]"
          />
          {/* Slogan text */}
          <p className="absolute left-[115px] top-[125px] text-white text-xl font-normal">
            Delivering schedules that work for all.
          </p>
        </div>
      </div>

      {/* Right panel (login form) */}
      <div
        className="
          min-h-screen bg-[#F5F5F5] shadow-xl ml-auto
          flex items-center justify-center
          w-full sm:w-1/2 lg:w-[520px] 2xl:w-[560px]
          p-6 sm:p-8
        "
      >
        {/* Login Card */}
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 sm:p-8">
          {/* Title + accent underline */}
          <div className="mb-6 sm:mb-8">
            <h2 className="text-2xl sm:text-3xl font-bold">Log In</h2>
            <div className="h-1 w-16 sm:w-20 bg-[#21804A] rounded mt-2" />
          </div>

          <form className="space-y-4 sm:space-y-5">
            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1">
                Email Address
              </label>
              <input
                type="email"
                className="w-full rounded-xl bg-gray-100 border border-gray-200 px-4 py-3 shadow-inner focus:outline-none focus:ring-2 focus:ring-[#21804A]/60 focus:border-[#21804A]"
                placeholder="name@dlsu.edu.ph"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  className="w-full rounded-xl bg-gray-100 border border-gray-200 px-4 py-3 pr-11 shadow-inner focus:outline-none focus:ring-2 focus:ring-[#21804A]/60 focus:border-[#21804A]"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  {showPw ? (
                    <Eye className="h-5 w-5 text-gray-500" />
                  ) : (
                    <EyeOff className="h-5 w-5 text-gray-500" />
                  )}
                </button>
              </div>
              <div className="mt-2 text-right">
                <a href="#" className="text-sm text-blue-600 hover:underline">
                  Forgot Password?
                </a>
              </div>
            </div>

            {/* Primary Login */}
            <button
              type="submit"
              className="w-full py-3 rounded-xl bg-[#21804A] text-white font-semibold shadow hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#21804A]"
            >
              Login
            </button>

            {/* Google Login */}
            <button
              type="button"
              className="w-full py-3 rounded-xl border border-gray-300 bg-white font-medium shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300 flex items-center justify-center gap-3"
            >
              <svg
                className="h-5 w-5 shrink-0"
                viewBox="0 0 48 48"
                aria-hidden="true"
                focusable="false"
              >
                <path fill="#FFC107" d="M43.611 20.083H42v-.083H24v8h11.303C33.668 32.657 29.223 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.153 7.957 3.043l5.657-5.657C32.671 6.053 28.568 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20c10.5 0 19.5-7.6 20-19.917v-4z"/>
                <path fill="#FF3D00" d="M6.306 14.691l6.571 4.818C14.655 16.157 18.961 13 24 13c3.059 0 5.842 1.153 7.957 3.043l5.657-5.657C32.671 6.053 28.568 4 24 4 16.102 4 9.287 8.343 6.306 14.691z"/>
                <path fill="#4CAF50" d="M24 44c5.313 0 10.18-1.822 13.989-4.943l-6.476-5.318C29.71 35.41 27.001 36 24 36c-5.275 0-9.747-3.555-11.346-8.355l-6.51 5.02C9.147 39.793 16.02 44 24 44z"/>
                <path fill="#1976D2" d="M44 24c0-1.341-.138-2.652-.389-3.917H24v8h11.303c-.737 3.484-2.812 6.086-5.39 7.66l6.476 5.318C39.485 37.65 44 31.45 44 24z"/>
              </svg>
              <span>Login with Google</span>
            </button>

          </form>
        </div>
      </div>
    </div>
  );
};

export default Login;
