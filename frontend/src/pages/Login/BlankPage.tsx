import React from "react";
import { useNavigate } from "react-router-dom";

export default function BlankPage() {
  const SUBJECT_PREFIX = "[AnimoAssign] ";

  const navigate = useNavigate();

  const [toEmail, setToEmail] = React.useState("");
  const [subject, setSubject] = React.useState(""); // user part only
  const [message, setMessage] = React.useState("");

  const [sending, setSending] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const onSend = async () => {
    setError(null);
    setStatus(null);

    const token = localStorage.getItem("gmail_access_token");
    if (!token) {
      setError("No Gmail token found. Please reconnect Gmail.");
      return;
    }

    setSending(true);
    try {
      const res = await fetch("/api/gmail/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          to: toEmail,
          subject, // backend will enforce [AnimoAssign]
          body: message,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Backend error (${res.status}): ${text}`);
      }

      const data = await res.json();
      setStatus(`Email sent! Gmail message id: ${data.id ?? "(no id returned)"}`);
      setToEmail("");
      setSubject("");
      setMessage("");
    } catch (e: any) {
      setError(e?.message || "Failed to send email.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-white p-6">
      <div className="mx-auto w-full max-w-2xl">
         <button
          type="button"
          onClick={() => navigate("/calendar-manager")}
          className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Manage Google Calendar
        </button>
        <button
          type="button"
          onClick={() => navigate("/calendar-invite")}
          className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Send Calendar Event
        </button>
        <h1 className="text-2xl font-semibold text-slate-900">Send Email</h1>
        <p className="mt-1 text-sm text-slate-600">
          Enter the recipient, subject, and the email message.
        </p>

        <div className="mt-6 space-y-4">
          {/* Recipient */}
          <div>
            <label className="block text-sm font-medium text-slate-900 mb-1">
              Recipient Email
            </label>
            <input
              type="email"
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              placeholder="recipient@example.com"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3
                         focus:outline-none focus:ring-2 focus:ring-emerald-600/40 focus:border-emerald-600"
            />
          </div>

          {/* Subject */}
          <div>
            <label className="block text-sm font-medium text-slate-900 mb-1">
              Subject
            </label>
            <div className="flex items-stretch rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
              <div className="px-3 py-3 text-sm text-slate-700 bg-slate-100 border-r border-slate-200 whitespace-nowrap">
                {SUBJECT_PREFIX}
              </div>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Enter subject..."
                className="flex-1 bg-transparent px-4 py-3 focus:outline-none"
              />
            </div>
          </div>

          {/* Body */}
          <div>
            <label className="block text-sm font-medium text-slate-900 mb-1">
              Email to be sent
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Write your message here..."
              rows={10}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3
                         focus:outline-none focus:ring-2 focus:ring-emerald-600/40 focus:border-emerald-600"
            />
          </div>

          {/* Status */}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {status && <div className="text-sm text-emerald-700">{status}</div>}

          {/* Send */}
          <button
            type="button"
            onClick={onSend}
            disabled={sending || !toEmail || !message}
            className="w-full rounded-xl bg-emerald-700 py-3 font-semibold text-white
                       disabled:opacity-50 hover:brightness-110"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
