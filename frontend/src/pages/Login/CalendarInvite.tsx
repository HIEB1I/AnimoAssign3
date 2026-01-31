import React from "react";

function getToken() {
  return localStorage.getItem("gmail_access_token");
}

function toIsoLocal(date: string, time: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  return dt.toISOString();
}

export default function CalendarInvite() {
  const [recipient, setRecipient] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [desc, setDesc] = React.useState("");

  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = React.useState(today);
  const [startTime, setStartTime] = React.useState("09:00");
  const [endDate, setEndDate] = React.useState(today);
  const [endTime, setEndTime] = React.useState("10:00");

  const [repeatEveryDays, setRepeatEveryDays] = React.useState(0);
  const [repeatCount, setRepeatCount] = React.useState(1);

  const [sending, setSending] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const onSendInvite = async () => {
    setError(null);
    setStatus(null);

    const token = getToken();
    if (!token) {
      setError("No Google token found. Reconnect Google.");
      return;
    }

    const startISO = toIsoLocal(startDate, startTime);
    const endISO = toIsoLocal(endDate, endTime);
    if (new Date(endISO) <= new Date(startISO)) {
      setError("End must be after start.");
      return;
    }

    setSending(true);
    try {
      const res = await fetch("/api/gcal/invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          recipient,
          summary: title,
          description: desc,
          start: startISO,
          end: endISO,
          repeat_every_days: repeatEveryDays,
          repeat_count: repeatCount,
        }),
      });

      if (!res.ok) throw new Error(`Backend error (${res.status}): ${await res.text()}`);

      const data = await res.json();
      setStatus(`Invite sent! Event ID: ${data.id ?? "(no id)"}`);
    } catch (e: any) {
      setError(e?.message || "Failed to send invite.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-white p-6">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold text-slate-900">Send Calendar Event</h1>
        <p className="text-sm text-slate-600">
          Creates an event on your calendar and sends an invite to another user.
        </p>

        {error && <div className="text-sm text-red-600">{error}</div>}
        {status && <div className="text-sm text-emerald-700">{status}</div>}

        <div>
          <label className="block text-sm font-medium mb-1">Recipient Email</label>
          <input
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
            placeholder="recipient@example.com"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
            placeholder="Meeting title"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Notes / Description</label>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
            rows={4}
            placeholder="Optional notes..."
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium mb-1">Start</label>
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" />
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">End</label>
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" />
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium mb-1">Repeat every (days)</label>
            <input
              type="number"
              min={0}
              value={repeatEveryDays}
              onChange={(e) => setRepeatEveryDays(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
            />
            <div className="mt-1 text-xs text-slate-500">0 = no repeat</div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Occurrences</label>
            <input
              type="number"
              min={1}
              value={repeatCount}
              onChange={(e) => setRepeatCount(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={onSendInvite}
          disabled={sending || !recipient || !title}
          className="w-full rounded-xl bg-emerald-700 py-3 font-semibold text-white disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send Invite"}
        </button>
      </div>
    </div>
  );
}
