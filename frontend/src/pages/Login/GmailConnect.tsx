import React from "react";
import { useNavigate } from "react-router-dom";
import { useGoogleLogin } from "@react-oauth/google";
import type { CodeResponse } from "@react-oauth/google";

export default function GmailConnect() {
  const navigate = useNavigate();
  const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = raw.userId || raw.user_id || raw.id;

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const connect = useGoogleLogin(
    ({
      flow: "auth-code",
      prompt: "consent",      //  force consent here ONLY (so refresh_token can be issued)
      access_type: "offline", //  refresh token
      include_granted_scopes: true,
      scope: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/calendar.events",
      ].join(" "),
      onSuccess: async (codeResponse: CodeResponse) => {
        setLoading(true);
        setError(null);

        try {
          if (!userId) throw new Error("Missing userId. Please log in again.");

          const res = await fetch("/api/auth/google/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, code: codeResponse.code }),
          });

          if (!res.ok) throw new Error(await res.text());

          //  connected; go back to where user should be
          navigate("/faculty/overview", { replace: true }); // change if needed
        } catch (e: any) {
          setError(e?.message || "Failed to connect Google.");
        } finally {
          setLoading(false);
        }
      },
      onError: () => setError("Google connect failed."),
    }) as any
  );

  return (
    <div className="min-h-screen grid place-items-center bg-gray-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white shadow p-6">
        <h1 className="text-xl font-semibold">Connect Gmail & Calendar</h1>
        <p className="mt-2 text-sm text-gray-600">
          This is a one-time setup to enable sending email and adding calendar events.
        </p>

        {error && <div className="mt-4 text-sm text-red-600">{error}</div>}

        <button
          type="button"
          onClick={() => connect()}
          disabled={loading}
          className="mt-6 w-full rounded-xl px-4 py-3 bg-black text-white disabled:opacity-60"
        >
          {loading ? "Connecting…" : "Connect Google"}
        </button>
      </div>
    </div>
  );
}
