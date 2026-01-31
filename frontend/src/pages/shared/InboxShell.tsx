// frontend/src/pages/shared/InboxShell.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getSocket } from "@/realtime/socket";
import { emitAck } from "@/realtime/ack";

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
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

export type Mail = {
  id: number;
  conversationId: string;
  from: string;
  email: string;
  subject: string;
  preview: string;
  body: string;
  receivedAt: Date;
  unread: number;
  peerUserId?: string;
};

export type InboxShellProps = {
  title?: string;
  subtitle?: string;
  fallbackRoute: string;
  closeEventName?: string; // optional (OM can pass "om:closeInbox")
};

export default function InboxShell({
  title = "Inbox",
  subtitle = "Manage communication",
  fallbackRoute,
  closeEventName,
}: InboxShellProps) {
  // Thread search (left list)
  const [query, setQuery] = useState("");

  const [mode, setMode] = useState<"default" | "compose" | "read">("default");
  const [mails, setMails] = useState<Mail[]>([]);
  const [selected, setSelected] = useState<Mail | null>(null);

  // Compose
  const [composeTo, setComposeTo] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [pickedUser, setPickedUser] = useState<any | null>(null);

  // Reply
  const [replyText, setReplyText] = useState("");

  // Dedupe message_new vs ACK
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  // Avoid stale state inside socket callbacks
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const selectedConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedConvIdRef.current = selected?.conversationId ?? null;
  }, [selected]);

  const joinedConversationIdsRef = useRef<Set<string>>(new Set());

  // Throttle mark_read spam when messages arrive while reading
  const markReadTimerRef = useRef<number | null>(null);

  const navigate = useNavigate();

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }

    if (closeEventName) {
      window.dispatchEvent(new Event(closeEventName));
    }

    navigate(fallbackRoute);
  };

  const markRead = async (conversationId: string) => {
    const cid = String(conversationId || "");
    if (!cid) return;

    const s = getSocket();
    if (!s) return;

    const resp = await emitAck<any>(s, "conversation_mark_read", { conversationId: cid });
    if (!resp?.ok) return;

    // Keep UI in sync immediately
    setMails((prev) =>
      prev.map((x) => (String(x.conversationId) === cid ? { ...x, unread: 0 } : x))
    );
  };

  const scheduleMarkRead = (conversationId: string) => {
    const cid = String(conversationId || "");
    if (!cid) return;

    if (markReadTimerRef.current) {
      window.clearTimeout(markReadTimerRef.current);
    }

    markReadTimerRef.current = window.setTimeout(() => {
      void markRead(cid);
      markReadTimerRef.current = null;
    }, 250);
  };

  const loadConversations = async () => {
    const s = getSocket();
    if (!s) return;

    const resp = await emitAck<any>(s, "conversation_list", { limit: 50 });
    if (!resp?.ok) {
      console.error("conversation_list failed", resp);
      return;
    }

    const convs = resp.conversations || [];
    const mapped: Mail[] = convs.map((c: any, idx: number) => {
      const peer = c.peer || {};
      const lm = c.lastMessage || {};
      const ts = lm.createdAt || c.updatedAt || Date.now();

      const from = String(peer.fullName || peer.userId || "User");
      const email = String(peer.email || "");
      const preview = String(lm.preview || "");
      const unread = Number(c.unread || 0);

      return {
        id: idx + 1,
        conversationId: String(c.conversationId),
        from,
        email,
        subject: from,
        preview,
        body: "",
        receivedAt: new Date(ts),
        unread: Number.isFinite(unread) ? unread : 0,
        peerUserId: peer.userId ? String(peer.userId) : undefined,
      };
    });

    setMails(mapped);
  };

  // Join only once per conversationId
  const joinIfNeeded = async (conversationId: string) => {
    const cid = String(conversationId || "");
    if (!cid) return false;
    if (joinedConversationIdsRef.current.has(cid)) return true;

    const s = getSocket();
    if (!s) return false;

    const joinResp = await emitAck<any>(s, "conversation_join", { conversationId: cid });
    if (!joinResp?.ok) {
      console.error("conversation_join failed", joinResp);
      return false;
    }

    joinedConversationIdsRef.current.add(cid);
    return true;
  };

  // Optional fallback: fetch details if convo arrives but not in list yet
  const hydrateConversation = async (conversationId: string) => {
    const s = getSocket();
    if (!s) return;

    const resp = await emitAck<any>(s, "conversation_get", { conversationId });
    if (!resp?.ok) return;

    const c = resp.conversation || {};
    const peer = c.peer || {};
    const lm = c.lastMessage || {};
    const ts = lm.createdAt || c.updatedAt || Date.now();

    setMails((prev) => {
      const cid = String(c.conversationId || conversationId);
      const exists = prev.some((x) => String(x.conversationId) === cid);

      const base: Partial<Mail> = {
        conversationId: cid,
        from: String(peer.fullName || peer.userId || "User"),
        email: String(peer.email || ""),
        subject: String(peer.fullName || peer.userId || "Chat"),
        preview: String(lm.preview || ""),
        receivedAt: new Date(ts),
        unread: Number(c.unread || 0),
        peerUserId: peer.userId ? String(peer.userId) : undefined,
      };

      let next = exists
        ? prev.map((x) => (String(x.conversationId) === cid ? { ...x, ...base } : x))
        : [
            {
              id: Date.now(),
              conversationId: cid,
              from: String(base.from || "User"),
              email: String(base.email || ""),
              subject: String(base.subject || "Chat"),
              preview: String(base.preview || ""),
              body: "",
              receivedAt: new Date(base.receivedAt || Date.now()),
              unread: Number(base.unread || 0),
              peerUserId: base.peerUserId,
            },
            ...prev,
          ];

      next = [...next].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
      return next;
    });
  };

  // Incoming message handler (message_new + ACK)
  const handleIncomingMessage = (m: any) => {
    const mid = String(m?.messageId || "");
    if (mid) {
      if (seenMessageIdsRef.current.has(mid)) return;
      seenMessageIdsRef.current.add(mid);
    }

    const convId = String(m?.conversationId || "");
    const body = String(m?.body || "");
    const createdAt = m?.createdAt ? new Date(m.createdAt) : new Date();

    const isReadingThis =
      modeRef.current === "read" && String(selectedConvIdRef.current || "") === convId;

    // Update list preview/time (unread will be corrected by unread_update anyway)
    setMails((prev) => {
      const preview = body.length > 80 ? body.slice(0, 80).trimEnd() + "…" : body;
      const idx = prev.findIndex((x) => String(x.conversationId) === convId);
      let next = [...prev];

      if (idx === -1) {
        next.unshift({
          id: Date.now(),
          conversationId: convId,
          from: "User",
          email: "",
          subject: "Chat",
          preview,
          body: "",
          receivedAt: createdAt,
          unread: isReadingThis ? 0 : 1,
        });

        void hydrateConversation(convId);
      } else {
        const cur = next[idx];
        next[idx] = {
          ...cur,
          preview,
          receivedAt: createdAt,
          unread: isReadingThis ? 0 : (cur.unread || 0) + 1,
        };
      }

      next.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
      return next;
    });

    // Append to open thread if selected
    setSelected((prev) => {
      if (!prev) return prev;
      if (String(prev.conversationId) !== convId) return prev;

      const name = m?.senderName || m?.senderId || "User";
      const line = `${name}: ${body}`;
      const nextBody = prev.body ? `${prev.body}\n\n${line}` : line;
      return { ...prev, body: nextBody, receivedAt: createdAt };
    });

    // If you're actively reading this conversation, keep DB unread at 0
    if (isReadingThis) {
      scheduleMarkRead(convId);
    }
  };

  // Phase 3: load once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await loadConversations();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconnect safety: reload list + rejoin current conversation
  useEffect(() => {
    const s = getSocket();
    if (!s) return;

    const onConnect = async () => {
      await loadConversations();
      const cid = selectedConvIdRef.current;
      if (cid) await joinIfNeeded(cid);
    };

    s.on("connect", onConnect);
    return () => {
      s.off("connect", onConnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live socket events: message_new, conversation_updated, unread_update
  useEffect(() => {
    const s = getSocket();
    if (!s) return;

    const onMessageNew = (m: any) => handleIncomingMessage(m);

    const onConversationUpdated = (u: any) => {
      const cid = String(u?.conversationId || "");
      if (!cid) return;

      setMails((prev) => {
        const lm = u?.lastMessage || {};
        const newTime = lm?.createdAt ? new Date(lm.createdAt) : null;

        const idx = prev.findIndex((x) => String(x.conversationId) === cid);

        if (idx === -1) {
          const preview = String(lm.preview || "");
          const receivedAt = newTime || new Date();
          const isReadingThis =
            modeRef.current === "read" && String(selectedConvIdRef.current || "") === cid;

          const next = [
            {
              id: Date.now(),
              conversationId: cid,
              from: "User",
              email: "",
              subject: "Chat",
              preview,
              body: "",
              receivedAt,
              unread: isReadingThis ? 0 : 1,
            },
            ...prev,
          ].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

          void hydrateConversation(cid);
          return next;
        }

        const updated = prev
          .map((x) =>
            String(x.conversationId) === cid
              ? {
                  ...x,
                  preview: String(lm.preview || x.preview),
                  receivedAt: newTime || x.receivedAt,
                }
              : x
          )
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

        return updated;
      });
    };

    const onUnreadUpdate = (u: any) => {
      const cid = String(u?.conversationId || "");
      if (!cid) return;

      const isReadingThis =
        modeRef.current === "read" && String(selectedConvIdRef.current || "") === cid;

      const unreadIncoming = Number(u?.unread || 0);
      const unread = isReadingThis ? 0 : (Number.isFinite(unreadIncoming) ? unreadIncoming : 0);

      setMails((prev) =>
        prev.map((x) => (String(x.conversationId) === cid ? { ...x, unread } : x))
      );

      // If backend says you have unread while you're reading, clean it up
      if (isReadingThis && unreadIncoming > 0) {
        scheduleMarkRead(cid);
      }
    };

    s.on("message_new", onMessageNew);
    s.on("conversation_updated", onConversationUpdated);
    s.on("unread_update", onUnreadUpdate);

    return () => {
      s.off("message_new", onMessageNew);
      s.off("conversation_updated", onConversationUpdated);
      s.off("unread_update", onUnreadUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mails
      .filter((m) => !q || `${m.from} ${m.subject} ${m.preview}`.toLowerCase().includes(q))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }, [query, mails]);

  const openCompose = () => {
    setMode("compose");
    modeRef.current = "compose";

    setSelected(null);
    selectedConvIdRef.current = null;

    setReplyText("");

    setComposeTo("");
    setComposeBody("");
    setSearchResults([]);
    setPickedUser(null);
  };

  const openRead = async (m: Mail) => {
    setSelected(m);
    setMode("read");
    setReplyText("");

    // IMPORTANT: update refs immediately (before awaits)
    modeRef.current = "read";
    selectedConvIdRef.current = String(m.conversationId);

    // optimistic unread clear
    setMails((prev) =>
      prev.map((x) => (String(x.conversationId) === String(m.conversationId) ? { ...x, unread: 0 } : x))
    );

    const ok = await joinIfNeeded(m.conversationId);
    if (!ok) return;

    // mark read in DB immediately
    void markRead(m.conversationId);

    const s = getSocket();
    if (!s) return;

    const resp = await emitAck<any>(s, "message_list", { conversationId: m.conversationId, limit: 50 });
    if (!resp?.ok) {
      console.error("message_list failed", resp);
      return;
    }

    const msgs = resp.messages || [];
    for (const x of msgs) {
      const mid = String(x?.messageId || "");
      if (mid) seenMessageIdsRef.current.add(mid);
    }

    const transcript = msgs.map((x: any) => `${x.senderName || x.senderId}: ${x.body}`).join("\n\n");
    setSelected({ ...m, body: transcript });

    // after loading, mark read again (safe)
    void markRead(m.conversationId);
  };

  const backToDefault = () => {
    setMode("default");
    modeRef.current = "default";

    setSelected(null);
    selectedConvIdRef.current = null;

    setReplyText("");
  };

  const sendReply = async () => {
    const body = replyText.trim();
    if (!selected?.conversationId || !body) return;

    const s = getSocket();
    if (!s) return;

    const resp = await emitAck<any>(s, "message_send", { conversationId: selected.conversationId, body });
    if (!resp?.ok) {
      console.error("message_send failed", resp);
      return;
    }

    setReplyText("");

    // If ACK includes message, render immediately (dedupe protects double render)
    if (resp?.message) handleIncomingMessage(resp.message);
  };

  // User search (debounced) — only while composing
  useEffect(() => {
    if (mode !== "compose") return;

    const s = getSocket();
    if (!s) return;

    const q = composeTo.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }

    const t = setTimeout(async () => {
      const resp = await emitAck<any>(s, "user_search", { q, limit: 10 });
      if (!resp?.ok) {
        console.error("user_search failed", resp);
        setSearchResults([]);
        return;
      }
      setSearchResults(resp.users || []);
    }, 300);

    return () => clearTimeout(t);
  }, [composeTo, mode]);

  const pickRecipient = (u: any) => {
    setPickedUser(u);
    setComposeTo(u.fullName || u.email || u.userId);
    setSearchResults([]);
  };

  const sendCompose = async () => {
    const body = composeBody.trim();
    if (!pickedUser?.userId || !body) return;

    const s = getSocket();
    if (!s) return;

    const openResp = await emitAck<any>(s, "conversation_open", { targetUserId: pickedUser.userId });
    if (!openResp?.ok) {
      console.error("conversation_open failed", openResp);
      return;
    }

    const conversationId = String(openResp.conversationId);

    const ok = await joinIfNeeded(conversationId);
    if (!ok) return;

    const sendResp = await emitAck<any>(s, "message_send", { conversationId, body });
    if (!sendResp?.ok) {
      console.error("message_send failed", sendResp);
      return;
    }

    await loadConversations();

    const newMail: Mail = {
      id: Date.now(),
      conversationId,
      from: pickedUser.fullName || pickedUser.userId || "User",
      email: pickedUser.email || "",
      subject: pickedUser.fullName || "Chat",
      preview: body.length > 80 ? body.slice(0, 80).trimEnd() + "…" : body,
      body: "",
      receivedAt: new Date(),
      unread: 0,
      peerUserId: String(pickedUser.userId),
    };

    if (sendResp?.message) handleIncomingMessage(sendResp.message);

    await openRead(newMail);

    setComposeBody("");
    setPickedUser(null);
    setSearchResults([]);
  };

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">{title}</h3>
            {subtitle ? <p className="text-sm text-gray-500">{subtitle}</p> : null}
          </div>
          <button
            onClick={handleBack}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
          >
            Back
          </button>
        </div>

        {/* Actions / Search */}
        <div className="mb-4 flex items-start gap-3">
          <div className="relative flex-1">
            <div className="relative rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full bg-transparent outline-none pl-7"
                placeholder="Search messages..."
              />
            </div>
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
            <Plus className="h-4 w-4" /> Compose
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
                  key={m.conversationId}
                  onClick={() => openRead(m)}
                  className={cls(
                    "w-full rounded-xl border bg-white p-4 text-left shadow-sm hover:shadow",
                    selected?.conversationId === m.conversationId
                      ? "border-emerald-400 ring-1 ring-emerald-200"
                      : "border-gray-200"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700">
                      {initials(m.from)}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">{m.from}</div>

                        <div className="flex items-center gap-2">
                          {m.unread > 0 && (
                            <span className="min-w-[22px] rounded-full bg-emerald-700 px-2 py-0.5 text-center text-[11px] font-semibold text-white">
                              {m.unread}
                            </span>
                          )}
                          <div className="text-[11px] text-gray-400">{timeAgo(m.receivedAt)}</div>
                        </div>
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
                <div className="relative">
                  <label className="mb-1 block text-sm font-medium">To:</label>
                  <input
                    value={composeTo}
                    onChange={(e) => {
                      setComposeTo(e.target.value);
                      setPickedUser(null);
                    }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30"
                    placeholder="Search user by name/email..."
                  />

                  {searchResults.length > 0 && !pickedUser && (
                    <div className="absolute z-10 mt-2 w-full rounded-lg border border-gray-200 bg-white p-2 shadow">
                      {searchResults.map((u: any) => (
                        <button
                          key={u.userId}
                          type="button"
                          onClick={() => pickRecipient(u)}
                          className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-gray-50"
                        >
                          <div className="font-medium">{u.fullName}</div>
                          <div className="text-xs text-gray-500">{u.email || u.userId}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium">Message:</label>
                  <textarea
                    value={composeBody}
                    onChange={(e) => setComposeBody(e.target.value)}
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
                    onClick={sendCompose}
                    disabled={!pickedUser || !composeBody.trim()}
                    className={cls(
                      "rounded-lg px-4 py-2 text-sm font-medium text-white",
                      pickedUser && composeBody.trim()
                        ? "bg-emerald-700 hover:bg-emerald-700"
                        : "bg-gray-300 cursor-not-allowed"
                    )}
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
                  {selected.body || "(no messages)"}
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Reply</div>
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
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
                    <button
                      onClick={sendReply}
                      disabled={!replyText.trim()}
                      className={cls(
                        "rounded-lg px-4 py-2 text-sm font-medium text-white",
                        replyText.trim()
                          ? "bg-emerald-700 hover:bg-emerald-700"
                          : "bg-gray-300 cursor-not-allowed"
                      )}
                    >
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
