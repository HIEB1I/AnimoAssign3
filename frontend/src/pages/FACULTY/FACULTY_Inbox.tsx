// frontend/src/pages/FACULTY/FAC_Inbox.tsx
import { useEffect, useMemo, useState } from "react";
import { Search, Plus } from "lucide-react";

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
  name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

type Mail = {
  id: number;
  from: string;
  email: string;
  subject: string;
  preview: string;
  body: string;
  receivedAt: Date;
};

function InboxMain() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"default" | "compose" | "read">("default");
  const [mails, setMails] = useState<Mail[]>([]);
  const [selected, setSelected] = useState<Mail | null>(null);

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem("animo.user") || "{}");
    const userId: string | undefined = user.userId || user.user_id || user.id;
    if (!userId) return;

    fetch(`/api/faculty/inbox?userId=${encodeURIComponent(userId)}`)
      .then((res) => res.json())
      .then((data) => {
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
      .catch((err) => console.error("Inbox fetch error", err));
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
        {/* Header to match in-tab look (no page topbar) */}
        <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-900">Inbox</h3>
          <p className="text-sm text-gray-500">Manage communication and support requests</p>
        </div>
        <button
          onClick={() => window.dispatchEvent(new Event("faculty:closeInbox"))}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
        >
          Back to Dashboard
        </button>
      </div>

        {/* Actions / Search */}
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

        {/* Two-column layout */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
          {/* List */}
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
              {filtered.length === 0 && (
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
                  <button className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
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

export function InboxContent() {
  return <InboxMain />;
}

export default InboxMain;
