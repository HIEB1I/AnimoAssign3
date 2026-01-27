import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Search, Plus } from "lucide-react";

import TopBar from "../../component/TopBar";

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

const timeAgo = (d: Date) => {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hours ago`;
  const dd = Math.floor(h / 24);
  return `${dd} day${dd > 1 ? "s" : ""} ago`;
};

const initials = (name: string) =>
  String(name || "")
    .replace(/@.*/, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

type Mail = {
  id: string;
  from: string;
  email: string;
  subject: string;
  preview: string;
  body: string;
  receivedAt: Date;
  direction: "inbox" | "sent";
};

function readUserSession() {
  try {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function parseDate(v: any): Date {
  if (!v) return new Date();
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export default function APO_Inbox() {
  const navigate = useNavigate();
  const location = useLocation();

  const user = useMemo(() => readUserSession(), []);
  const userId = String(user?.userId || "");

  // Preserve whatever the TopBar displayed on the source page (e.g., "Academic Programming Officer | Manila").
  const topbarName = (location.state as any)?.topbarName || user?.fullName || "APO";
  const topbarRole =
    (location.state as any)?.topbarRole ||
    (((user?.roles || []) as string[]).some((r) => /^apo\b/i.test(r))
      ? "Academic Programming Officer"
      : "User");
  const topbarDepartment = (location.state as any)?.topbarDepartment;

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"default" | "compose" | "read">("default");
  const [mails, setMails] = useState<Mail[]>([]);
  const [selected, setSelected] = useState<Mail | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compose
  const [toEmail, setToEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [replyBody, setReplyBody] = useState("");

  const goBack = () => {
    const from = (location.state as any)?.from;
    if (typeof from === "string" && from.startsWith("/apo/")) {
      navigate(from);
      return;
    }
    navigate("/apo/preenlistment");
  };

  const loadInbox = async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/apo/inbox?userId=${encodeURIComponent(userId)}`);
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.detail || "Failed to load inbox");

      const rows = (data.inbox || []) as any[];
      const normalized: Mail[] = rows
        .map((it: any, idx: number) => {
          const dir = String(it.direction || it.box || "inbox").toLowerCase() === "sent" ? "sent" : "inbox";
          const from = String(it.from ?? it.senderName ?? it.sender ?? "Unknown Sender");
          const email = String(it.email ?? it.senderEmail ?? it.from_email ?? it.sender_email ?? "");
          const subj = String(it.subject ?? "(No subject)");
          const body = String(it.body ?? it.message ?? it.preview ?? "");
          const preview = String(it.preview ?? body).slice(0, 120);
          const receivedAt = parseDate(it.receivedAt ?? it.received_at ?? it.date ?? Date.now());
          const id = String(it.id ?? it.msg_id ?? it.inbox_id ?? it._id ?? `${idx + 1}`);
          return { id, from, email, subject: subj, preview, body, receivedAt, direction: dir as any };
        })
        .filter((m) => m.id);
      setMails(normalized);
    } catch (e: any) {
      setError(e?.message || "Failed to load inbox");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mails
      .filter((m) => !q || `${m.from} ${m.email} ${m.subject} ${m.preview}`.toLowerCase().includes(q))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }, [query, mails]);

  const openCompose = () => {
    setMode("compose");
    setSelected(null);
    setError(null);
    setToEmail("");
    setSubject("");
    setMessage("");
    setReplyBody("");
  };

  const openRead = (m: Mail) => {
    setSelected(m);
    setMode("read");
    setError(null);
    setReplyBody("");
  };

  const backToDefault = () => {
    setMode("default");
    setSelected(null);
    setReplyBody("");
    setError(null);
  };

  const sendMessage = async (to: string, subj: string, body: string) => {
    if (!userId) throw new Error("Missing userId");
    const res = await fetch(`/api/apo/inbox?userId=${encodeURIComponent(userId)}&action=send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject: subj, body }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.detail || `Request failed with status ${res.status}`);
    }
    await res.json().catch(() => null);
  };

  const onSendCompose = async () => {
    const to = toEmail.trim();
    if (!to) {
      setError("Please enter a recipient email.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await sendMessage(to, subject.trim(), message);
      backToDefault();
      await loadInbox();
    } catch (e: any) {
      setError(e?.message || "Failed to send");
    } finally {
      setLoading(false);
    }
  };

  const onReply = async () => {
    if (!selected?.email) return;
    const to = selected.email.trim();
    const subj = selected.subject?.toLowerCase().startsWith("re:")
      ? selected.subject
      : `Re: ${selected.subject || ""}`.trim();
    setLoading(true);
    setError(null);
    try {
      await sendMessage(to, subj, replyBody);
      backToDefault();
      await loadInbox();
    } catch (e: any) {
      setError(e?.message || "Failed to send reply");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900" style={{ scrollbarGutter: "stable both-edges" }}>
      <TopBar fullName={topbarName} role={topbarRole} department={topbarDepartment} inboxPath="/apo/inbox" />

      <main className="mx-auto w-full max-w-screen-2xl px-4 py-6">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          {/* Header (match Faculty Inbox) */}
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-900">Inbox</h3>
              <p className="text-sm text-gray-500">Manage communication and support requests</p>
            </div>
            <button
              onClick={goBack}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
            >
              Back to Dashboard
            </button>
          </div>

          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
          )}

          {/* Search + Compose (match Faculty Inbox) */}
          <div className="mb-4 flex items-center gap-3">
            <div className="relative flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search messages..."
                className="w-full bg-transparent outline-none pl-7"
              />
            </div>

            <button
              onClick={openCompose}
              disabled={mode === "compose"}
              className={cls(
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium",
                mode === "compose"
                  ? "bg-gray-300 text-gray-600 cursor-not-allowed"
                  : "bg-emerald-700 text-white hover:bg-emerald-700"
              )}
            >
              <Plus className="h-4 w-4" /> Compose Email
            </button>
          </div>

          {/* Two-column layout (match Faculty Inbox) */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
            {/* List */}
            <aside className="space-y-3">
              <div className="text-sm font-semibold text-gray-700">Messages</div>
              <div className="space-y-3">
                {loading && !mails.length ? (
                  <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
                    Loading…
                  </div>
                ) : (
                  filtered.map((m) => {
                    const who = m.direction === "sent" ? `To: ${m.email}` : m.from;
                    return (
                      <button
                        key={m.id}
                        onClick={() => openRead(m)}
                        className={cls(
                          "w-full rounded-xl border bg-white p-4 text-left shadow-sm hover:shadow",
                          selected?.id === m.id
                            ? "border-emerald-400 ring-1 ring-emerald-200"
                            : "border-gray-200"
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700">
                            {initials(who)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between">
                              <div className="text-sm font-semibold truncate">{who}</div>
                              <div className="text-[11px] text-gray-400 whitespace-nowrap">{timeAgo(m.receivedAt)}</div>
                            </div>
                            <div className="text-sm truncate">{m.subject}</div>
                            <div className="mt-1 line-clamp-1 text-xs text-gray-500">{m.preview}</div>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}

                {filtered.length === 0 && !loading && (
                  <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
                    No messages found.
                  </div>
                )}
              </div>
            </aside>

            {/* Reader / Composer */}
            <section className="min-h-[520px] rounded-xl border border-gray-200 bg-white p-5">
              {mode === "default" && (
                <div className="grid h-full place-items-center text-center text-gray-500">
                  <div>
                    <div className="mx-auto mb-4 grid h-16 w-20 place-items-center rounded-lg border border-gray-300">
                      <div className="h-6 w-10 rounded border border-gray-400" />
                    </div>
                    <div className="font-semibold text-gray-700">Select a Message</div>
                    <div className="text-sm">Choose a message to view its content</div>
                  </div>
                </div>
              )}

              {mode === "compose" && (
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium">To:</label>
                    <input
                      value={toEmail}
                      onChange={(e) => setToEmail(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                      placeholder="recipient@dlsu.edu.ph"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Subject:</label>
                    <input
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                      placeholder="Subject"
                    />
                  </div>
                  <div>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      className="h-64 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                      placeholder="Type your message..."
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={backToDefault}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                      disabled={loading}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={onSendCompose}
                      className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                      disabled={loading}
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}

              {mode === "read" && selected && (
                <div className="space-y-5">
                  <div className="flex items-start gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-100 text-[12px] font-bold text-emerald-700">
                      {initials(selected.direction === "sent" ? selected.email : selected.from)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-lg font-semibold">{selected.subject}</div>
                      <div className="text-sm text-gray-600">
                        {selected.direction === "sent" ? (
                          <>
                            <span className="font-medium">To:</span> {selected.email}
                          </>
                        ) : (
                          <>
                            <span className="font-medium">From:</span> {selected.from}
                            <br />
                            <span className="font-medium">Email:</span> {selected.email}
                          </>
                        )}
                        <br />
                        <span className="text-gray-400">{timeAgo(selected.receivedAt)}</span>
                      </div>
                    </div>
                    <button
                      onClick={backToDefault}
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
                    >
                      Close
                    </button>
                  </div>

                  <div className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800">
                    {selected.body || "(No content)"}
                  </div>

                  {/* Reply only for inbox messages */}
                  {selected.direction !== "sent" && (
                    <div className="space-y-2">
                      <div className="text-sm font-semibold">Reply</div>
                      <textarea
                        value={replyBody}
                        onChange={(e) => setReplyBody(e.target.value)}
                        className="h-40 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                        placeholder={`Reply to ${selected.from}...`}
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={backToDefault}
                          className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                          disabled={loading}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={onReply}
                          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
                          disabled={loading || !replyBody.trim()}
                        >
                          Reply
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
