// frontend/src/pages/ADMIN/ADMIN_Inbox.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, ChevronLeft } from "lucide-react";

/* ========== local helpers (scoped to this file) ========== */
type Mail = {
  id: number;
  from: string;
  email: string;
  subject: string;
  preview: string;
  body: string;
  receivedAt: Date;
};

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

const initials = (name: string) => {
  const parts = (name || "").trim().split(/\s+/);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const timeAgo = (d: Date) => {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
};

/* ========== Inline Admin Inbox (TopBar-less) ========== */
/** Use this inside the Admin dashboard (ADMIN.tsx) when showInbox === true */
export function InboxContent() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"default" | "compose" | "read">("default");
  const [mails, setMails] = useState<Mail[]>([]);
  const [selected, setSelected] = useState<Mail | null>(null);

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem("animo.user") || "{}");
    const userId: string | undefined = user.userId || user.user_id || user.id;
    if (!userId) return;

    fetch(`/api/admin/inbox?userId=${encodeURIComponent(userId)}`)
      .then((res) => res.json())
      .then((data) => {
        // Expecting { ok: boolean, inbox: [...] }
        if (!data?.ok) return;
        const mapped: Mail[] = (data.inbox || []).map((it: any, idx: number) => ({
          id: Number(it.id ?? idx + 1),
          from: String(it.from ?? it.senderName ?? "Unknown Sender"),
          email: String(it.email ?? it.senderEmail ?? "unknown@example.com"),
          subject: String(it.subject ?? "(No subject)"),
          preview: String(it.preview ?? it.body ?? "").slice(0, 120),
          body: String(it.body ?? it.preview ?? ""),
          receivedAt: new Date(it.receivedAt ?? it.received_at ?? it.date ?? Date.now()),
        }));
        setMails(mapped);
      })
      .catch((err) => console.error("Admin inbox fetch error", err));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mails
      .filter((m) => !q || `${m.from} ${m.subject} ${m.preview}`.toLowerCase().includes(q))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }, [query, mails]);

  const openCompose = () => setMode("compose");
  const openRead = (m: Mail) => {
    setSelected(m);
    setMode("read");
  };
  const backToDefault = () => {
    setMode("default");
    setSelected(null);
  };

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        {/* Header (no page topbar) */}
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Inbox</h3>
            <p className="text-sm text-gray-500">Manage communication and support requests</p>
          </div>
          <button
            onClick={() => window.dispatchEvent(new Event("admin:closeInbox"))}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
          >
            Back to Dashboard
          </button>
        </div>

        {/* Search + Compose */}
        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search messages..."
              className="w-full bg-transparent pl-7 outline-none"
            />
          </div>
          <button
            onClick={openCompose}
            disabled={mode === "compose"}
            className={cls(
              "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium",
              mode === "compose"
                ? "cursor-not-allowed bg-gray-300 text-gray-600"
                : "bg-emerald-700 text-white hover:bg-emerald-700"
            )}
          >
            <Plus className="h-4 w-4" /> Compose Email
          </button>
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
          {/* Left list */}
          <aside className="space-y-3">
            <div className="text-sm font-semibold text-gray-700">Messages</div>
            <div className="space-y-3">
              {filtered.map((m) => (
                <button
                  key={m.id}
                  onClick={() => openRead(m)}
                  className={cls(
                    "w-full rounded-xl border bg-white p-4 text-left shadow-sm hover:shadow",
                    selected?.id === m.id ? "border-emerald-400 ring-1 ring-emerald-200" : "border-gray-200"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700">
                      {initials(m.from)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">{m.from}</div>
                        <div className="text-[11px] text-gray-400">{timeAgo(m.receivedAt)}</div>
                      </div>
                      <div className="text-sm">{m.subject}</div>
                      <div className="mt-1 line-clamp-1 text-xs text-gray-500">{m.preview}</div>
                    </div>
                  </div>
                </button>
              ))}
              {!filtered.length && (
                <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
                  No messages found.
                </div>
              )}
            </div>
          </aside>

          {/* Right panel */}
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
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                    placeholder="recipient@dlsu.edu.ph"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Subject:</label>
                  <input
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                    placeholder="Subject"
                  />
                </div>
                <div>
                  <textarea
                    className="h-64 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                    placeholder="Type your message..."
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={backToDefault}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={backToDefault}
                    className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
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
                    {initials(selected.from)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-semibold">{selected.subject}</div>
                    <div className="text-sm text-gray-600">
                      <span className="font-medium">From:</span> {selected.from}
                      <br />
                      <span className="font-medium">Email:</span> {selected.email}
                      <br />
                      <span className="text-gray-400">{timeAgo(selected.receivedAt)}</span>
                    </div>
                  </div>
                </div>
                <div className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800">
                  {selected.body}
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Reply</div>
                  <textarea
                    className="h-40 w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                    placeholder={`Reply to ${selected.from}...`}
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={backToDefault}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                      Reply
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

/* ========== Full-page route wrapper (default export) ========== */
/** Used by <Route path="/admin/inbox" element={<ADMIN_Inbox />} /> */
export default function ADMIN_Inbox() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      {/* Simple header bar with a Back button */}
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-screen-2xl items-center gap-3 px-4 py-3">
          <button
            onClick={() => navigate("/admin")}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            <ChevronLeft className="h-4 w-4" />
            Back to Dashboard
          </button>
          <div className="ml-1 text-sm text-gray-500">Admin Inbox (full-page)</div>
        </div>
      </header>

      {/* Reuse the inline content */}
      <main className="mx-auto max-w-screen-2xl px-4 py-6">
        <InboxContent />
      </main>
    </div>
  );
}
