import React from "react";

type CalendarListItem = { id: string; summary?: string };
type GCalEvent = {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

function getToken() {
  return localStorage.getItem("gmail_access_token");
}

function toIsoFromDateAndTime(date: string, time: string) {
  // date: YYYY-MM-DD, time: HH:MM
  // Build local time ISO (with timezone offset)
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  return dt.toISOString();
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export default function CalendarManager() {
  const [calendars, setCalendars] = React.useState<CalendarListItem[]>([]);
  const [srcCal, setSrcCal] = React.useState("primary");
  const [dstCal, setDstCal] = React.useState("primary");

  // Easier range inputs
  const [fromDate, setFromDate] = React.useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  });
  const [toDate, setToDate] = React.useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });

  const [events, setEvents] = React.useState<GCalEvent[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Create form
  const [newTitle, setNewTitle] = React.useState("");
  const [newDesc, setNewDesc] = React.useState("");

  const [startDate, setStartDate] = React.useState(fromDate);
  const [startTime, setStartTime] = React.useState("09:00");
  const [endDate, setEndDate] = React.useState(fromDate);
  const [endTime, setEndTime] = React.useState("10:00");

  // repetition: every N days, repeat count
  const [repeatEveryDays, setRepeatEveryDays] = React.useState(0); // 0 = no repeat
  const [repeatCount, setRepeatCount] = React.useState(1); // total occurrences

  async function apiGET(path: string) {
    const token = getToken();
    if (!token) throw new Error("No Google token found. Reconnect Google with Calendar scopes.");

    const res = await fetch(path, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) throw new Error(`Backend error (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async function apiPOST(path: string, body: any) {
    const token = getToken();
    if (!token) throw new Error("No Google token found. Reconnect Google with Calendar scopes.");

    const res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Backend error (${res.status}): ${await res.text()}`);
    return res.json();
  }

  const loadCalendars = async () => {
    setError(null);
    setStatus(null);
    try {
      const data = await apiGET("/api/gcal/calendars");
      setCalendars(data.items ?? []);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const loadEvents = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      // Convert date range into ISO range (whole days)
      const timeMin = new Date(`${fromDate}T00:00:00`).toISOString();
      const timeMax = new Date(`${toDate}T23:59:59`).toISOString();

      const data = await apiGET(
        `/api/gcal/events?calendarId=${encodeURIComponent(srcCal)}&timeMin=${encodeURIComponent(
          timeMin
        )}&timeMax=${encodeURIComponent(timeMax)}`
      );
      setEvents(data.items ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const copyEvent = async (eventId: string) => {
    setError(null);
    setStatus(null);
    try {
      const created = await apiPOST("/api/gcal/copy", {
        sourceCalendarId: srcCal,
        destCalendarId: dstCal,
        eventId,
      });
      setStatus(`Copied! New event id in destination: ${created.id ?? "(unknown)"}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const deleteDstEvent = async (eventId: string) => {
    setError(null);
    setStatus(null);
    try {
      await apiPOST("/api/gcal/delete", { calendarId: dstCal, eventId });
      setStatus("Deleted event from destination calendar.");
    } catch (e: any) {
      setError(e.message);
    }
  };

  const createRepeatedEvents = async () => {
    setError(null);
    setStatus(null);

    try {
      const occurrences = Math.max(1, repeatCount);
      const every = Math.max(0, repeatEveryDays);

      const startISO0 = toIsoFromDateAndTime(startDate, startTime);
      const endISO0 = toIsoFromDateAndTime(endDate, endTime);

      const baseStart = new Date(startISO0);
      const baseEnd = new Date(endISO0);

      if (baseEnd <= baseStart) {
        throw new Error("End time must be after start time.");
      }

      const createdIds: string[] = [];
      for (let i = 0; i < occurrences; i++) {
        const offsetDays = every === 0 ? 0 : i * every;
        const s = addDays(baseStart, offsetDays).toISOString();
        const e = addDays(baseEnd, offsetDays).toISOString();

        const created = await apiPOST("/api/gcal/create", {
          calendarId: dstCal,
          summary: newTitle,
          start: s,
          end: e,
          description: newDesc,
        });

        if (created?.id) createdIds.push(created.id);
        if (every === 0) break; // no repeat → only create once
      }

      setStatus(
        every === 0
          ? "Created 1 event in destination calendar."
          : `Created ${createdIds.length} events (every ${every} day/s) in destination calendar.`
      );

      setNewTitle("");
      setNewDesc("");
    } catch (e: any) {
      setError(e.message);
    }
  };

  React.useEffect(() => {
    loadCalendars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen w-full bg-white p-6">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold text-slate-900">Calendar Manager</h1>

        <div className="text-sm text-slate-600">
          <div>
            <b>Source calendar</b> = where we read events from (copy FROM)
          </div>
          <div>
            <b>Destination calendar</b> = where we create/edit/delete events (copy TO)
          </div>
        </div>

        {error && <div className="text-sm text-red-600">{error}</div>}
        {status && <div className="text-sm text-emerald-700">{status}</div>}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Source Calendar</label>
            <select
              value={srcCal}
              onChange={(e) => setSrcCal(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
            >
              <option value="primary">primary (your main calendar)</option>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.summary ?? c.id}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium">Destination Calendar</label>
            <select
              value={dstCal}
              onChange={(e) => setDstCal(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
            >
              <option value="primary">primary (your main calendar)</option>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.summary ?? c.id}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Easier date range */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="text-sm font-medium">From date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
            />
          </div>
          <div>
            <label className="text-sm font-medium">To date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
            />
          </div>
        </div>

        <button
          type="button"
          onClick={loadEvents}
          disabled={loading}
          className="rounded-xl bg-emerald-700 px-4 py-2 text-white font-semibold disabled:opacity-60"
        >
          {loading ? "Loading…" : "Load Events From Source (date range)"}
        </button>

        {/* Create + repeat + notes */}
        <div className="rounded-xl border border-slate-200 p-4 space-y-3">
          <h2 className="font-semibold">Create event in destination</h2>

          <div>
            <label className="text-sm font-medium">Title</label>
            <input
              placeholder="Event title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Notes / Description</label>
            <textarea
              placeholder="Optional notes..."
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              rows={4}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Start</label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                />
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">End</label>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                />
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Repeat every (days)</label>
              <input
                type="number"
                min={0}
                value={repeatEveryDays}
                onChange={(e) => setRepeatEveryDays(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
              />
              <div className="mt-1 text-xs text-slate-500">
                0 = no repetition (create only once)
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">Number of occurrences</label>
              <input
                type="number"
                min={1}
                value={repeatCount}
                onChange={(e) => setRepeatCount(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={createRepeatedEvents}
            disabled={!newTitle}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
          >
            Create (with repetition if set)
          </button>
        </div>

        {/* Events list */}
        <div className="space-y-2">
          <h2 className="font-semibold">Source events</h2>
          {events.map((ev) => (
            <div key={ev.id} className="rounded-xl border border-slate-200 p-3">
              <div className="font-medium">{ev.summary ?? "(no title)"}</div>
              <div className="text-xs text-slate-600">
                {ev.start?.dateTime ?? ev.start?.date ?? ""} → {ev.end?.dateTime ?? ev.end?.date ?? ""}
              </div>

              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => copyEvent(ev.id)}
                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-white text-sm"
                >
                  Copy to destination
                </button>
                <button
                  type="button"
                  onClick={() => deleteDstEvent(ev.id)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50"
                  title="Delete requires the destination event ID; use this only if you know the ID exists in destination."
                >
                  Delete from destination
                </button>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={loadCalendars}
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Reload calendars
        </button>
      </div>
    </div>
  );
}
