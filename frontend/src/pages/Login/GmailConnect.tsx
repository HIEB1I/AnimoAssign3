import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useGoogleLogin } from "@react-oauth/google";

function useNextParam(defaultPath = "/blank") {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  return params.get("next") || defaultPath;
}

export default function GmailConnect() {
  const navigate = useNavigate();
  const next = useNextParam("/blank");

  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

 const login = useGoogleLogin({
  flow: "implicit",
  prompt: "consent",
  scope: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.readonly",
  ].join(" "),
  onSuccess: (tokenResponse) => {
    // ✅ now TS knows access_token exists
    localStorage.setItem("gmail_access_token", tokenResponse.access_token);
    navigate(next, { replace: true });
  },
  onError: () => setError("Google sign-in failed. Please try again."),
});


  const onConnectClick = () => {
    setError(null);
    setConnecting(true);

    // Optional: if you want to ALWAYS require reconnect, clear previous token
    localStorage.removeItem("gmail_access_token");

    // ✅ Step 2–3 happens here (user sees Google login/account picker)
    login();
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white shadow p-6">
        <h1 className="text-xl font-semibold">Connect your Gmail</h1>
        <p className="mt-2 text-sm text-gray-600">
          Click below to sign in with Google and grant Gmail access.
        </p>

        {error && <div className="mt-4 text-sm text-red-600">{error}</div>}

        <button
          type="button"
          onClick={onConnectClick}
          disabled={connecting}
          className="mt-6 w-full rounded-xl px-4 py-3 bg-black text-white disabled:opacity-60"
        >
          {connecting ? "Opening Google…" : "Connect Gmail"}
        </button>
      </div>
    </div>
  );
}
