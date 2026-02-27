// frontend/src/pages/shared/InboxShell.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, Search, Send } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getSocket } from "@/realtime/socket";

const cls = (...s: (string | false | undefined | null)[]) => s.filter(Boolean).join(" ");

// ----------------------------
// Time helpers (real inbox style)
// - Uses the viewer's local timezone.
// - Relative timestamps for conversation list.
// - Full timestamps for tooltips.
// ----------------------------
const fmtFull = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const fmtTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const fmtMonthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" });
const fmtMonthDayYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  year: "numeric",
});

function fullStamp(d: Date) {
  return fmtFull.format(d);
}

function timeOnly(d: Date) {
  return fmtTime.format(d);
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a: Date, b: Date) {
  const da = startOfDay(a).getTime();
  const db = startOfDay(b).getTime();
  return Math.round((da - db) / 86400000);
}

function inboxStamp(d: Date, now: Date) {
  const diffMs = now.getTime() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${Math.max(0, sec)}s`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;

  const dayDiff = daysBetween(now, d);
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return fmtWeekday.format(d);

  // Older: show month/day, and include year if different year
  return d.getFullYear() === now.getFullYear() ? fmtMonthDay.format(d) : fmtMonthDayYear.format(d);
}

function threadSeparatorLabel(d: Date, now: Date) {
  const dayDiff = daysBetween(now, d);
  if (dayDiff === 0) return `Today · ${timeOnly(d)}`;
  if (dayDiff === 1) return `Yesterday · ${timeOnly(d)}`;
  if (dayDiff < 7) return `${fmtWeekday.format(d)} · ${timeOnly(d)}`;
  return `${fmtMonthDayYear.format(d)} · ${timeOnly(d)}`;
}

function shouldShowSeparator(prev: Date | null, cur: Date) {
  if (!prev) return true;
  const prevDay = startOfDay(prev).getTime();
  const curDay = startOfDay(cur).getTime();
  if (prevDay !== curDay) return true;
  const diffMin = Math.floor((cur.getTime() - prev.getTime()) / 60000);
  return diffMin >= 7; // group messages within ~7 minutes
}

const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

type SessionUser = {
  userId?: string;
  user_id?: string;
  id?: string;
  email?: string;
  gmail?: string;
  fullName?: string;
  full_name?: string;
};

function getSessionUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem("animo.user");
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

type ChatMessage = {
  key: string;
  messageId?: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: Date;
  mine: boolean;
  status?: "sending" | "sent" | "delivered";
  deliveredAt?: Date;
  deliveredToCount?: number;
};

export type Mail = {
  id: number;
  conversationId: string;
  from: string;
  email: string;
  subject: string;
  preview: string;
  body: string; // kept for backward compat, not used as transcript anymore
  receivedAt: Date;
  unread: number;
  peerUserId?: string;
};

export type InboxShellProps = {
  title?: string;
  subtitle?: string;
  fallbackRoute: string;
  closeEventName?: string;
};

export default function InboxShell({
  title = "Inbox",
  subtitle = "Manage communication",
  fallbackRoute,
  closeEventName,
}: InboxShellProps) {
  const [query, setQuery] = useState("");

  const [mode, setMode] = useState<"default" | "compose" | "read">("default");
  const [mails, setMails] = useState<Mail[]>([]);
  const [selected, setSelected] = useState<Mail | null>(null);

  // Thread
  const [threadMessages, setThreadMessages] = useState<ChatMessage[]>([]);

  // Compose
  const [composeTo, setComposeTo] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [pickedUser, setPickedUser] = useState<any | null>(null);

  // Reply
  const [replyText, setReplyText] = useState("");

  // Real inbox: ticking "now" for relative timestamps + typing expiry
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setNowTick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const now = useMemo(() => new Date(), [nowTick]);

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

  // Message list scroll container
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);

  // Make the inbox panel auto-fit whatever space the page layout provides.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);

  // Typing + seen state
  const [typingByConv, setTypingByConv] = useState<
    Record<string, { userId: string; userName: string; until: number }>
  >({});
  const [seenAtByConv, setSeenAtByConv] = useState<Record<string, Date | null>>({});

  // Delivered state (per message)
  const [deliveredByMessageId, setDeliveredByMessageId] = useState<
    Record<string, { deliveredAt: Date; deliveredToCount: number }>
  >({});

  const typingStopTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const calc = () => {
      const el = panelRef.current;
      if (!el) return;

      const top = Math.max(0, el.getBoundingClientRect().top);
      const paddingBottom = 18;
      const next = Math.max(520, Math.floor(window.innerHeight - top - paddingBottom));
      setPanelHeight(next);
    };

    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  // Expire typing state if stop event never arrives
  useEffect(() => {
    const t = window.setInterval(() => {
      const ts = Date.now();
      setTypingByConv((prev) => {
        let changed = false;
        const next: typeof prev = {};
        for (const [cid, v] of Object.entries(prev)) {
          if (v.until > ts) next[cid] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const navigate = useNavigate();

  const me = useMemo(() => {
    const u = getSessionUser();
    const userId = String(u?.userId || u?.user_id || u?.id || "").trim();
    const fullName = String(u?.fullName || u?.full_name || "").trim();
    return {
      userId: userId || fullName || "me",
      fullName: fullName || userId || "me",
    };
  }, []);

  const handleBack = () => {
    // IMPORTANT UX CONTRACT (match APO + embedded flows):
    // - If this inbox is embedded (closeEventName provided), Back should simply close the inbox
    //   and MUST NOT use browser history (prevents jumping to other modules like APO).
    // - If this inbox is a standalone route page (no closeEventName), Back should always go to
    //   the provided fallbackRoute (APO uses /apo/preenlistment).
    if (closeEventName) {
      window.dispatchEvent(new Event(closeEventName));
      return;
    }

    navigate(fallbackRoute);
  };

  const markRead = async (conversationId: string) => {
    const cid = String(conversationId || "");
    if (!cid) return;

    const s = getSocket();
    if (!s) return;

    // fire-and-forget ack
    s.emit("conversation_mark_read", { conversationId: cid }, (resp: any) => {
      if (!resp?.ok) return;
      setMails((prev) => prev.map((x) => (String(x.conversationId) === cid ? { ...x, unread: 0 } : x)));
    });
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

    const resp = await new Promise<any>((resolve) => s.emit("conversation_list", { limit: 50 }, resolve));
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

    const joinResp = await new Promise<any>((resolve) => s.emit("conversation_join", { conversationId: cid }, resolve));
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

    const resp = await new Promise<any>((resolve) => s.emit("conversation_get", { conversationId }, resolve));
    if (!resp?.ok) return;

    const c = resp.conversation || {};
    const peer = c.peer || {};
    const lm = c.lastMessage || {};
    const ts = lm.createdAt || c.updatedAt || Date.now();

    // capture peer read state
    const peerLastReadAt = c.peerLastReadAt ? new Date(c.peerLastReadAt) : null;
    setSeenAtByConv((prev) => ({ ...prev, [String(c.conversationId || conversationId)]: peerLastReadAt }));

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

  const toChatMessage = (m: any): ChatMessage => {
    const createdAt = m?.createdAt ? new Date(m.createdAt) : new Date();
    const senderId = String(m?.senderId || "");
    const senderName = String(m?.senderName || senderId || "User");
    const body = String(m?.body || "");
    const messageId = m?.messageId ? String(m.messageId) : undefined;
    // IMPORTANT: keep this strictly boolean (avoid `senderId && ...` which becomes string|boolean)
    const mine = Boolean(senderId) && String(senderId) === String(me.userId);

    const deliveredInfo = messageId ? deliveredByMessageId[messageId] : undefined;

    return {
      key: messageId ? `m:${messageId}` : `m:${createdAt.getTime()}-${Math.random().toString(16).slice(2)}`,
      messageId,
      senderId,
      senderName,
      body,
      createdAt,
      mine,
      status: deliveredInfo ? "delivered" : "sent",
      deliveredAt: deliveredInfo?.deliveredAt,
      deliveredToCount: deliveredInfo?.deliveredToCount,
    };
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

    // Update conversation list preview/time
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
    setThreadMessages((prev) => {
      if (!isReadingThis) return prev;

      const incoming = toChatMessage(m);

      // Reconcile optimistic "sending" bubble for my own messages
      if (incoming.mine) {
        const idx = prev.findIndex((x) => x.mine && x.status === "sending" && x.body === incoming.body);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = incoming;
          return copy;
        }
      }

      return [...prev, incoming];
    });

    // If you're actively reading this conversation, keep DB unread at 0
    if (isReadingThis) {
      scheduleMarkRead(convId);
    }
  };

  // Load once
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

  // Live socket events
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

      setMails((prev) => prev.map((x) => (String(x.conversationId) === cid ? { ...x, unread } : x)));

      if (isReadingThis && unreadIncoming > 0) {
        scheduleMarkRead(cid);
      }
    };

    const onTypingUpdate = (t: any) => {
      const cid = String(t?.conversationId || "");
      const uid = String(t?.userId || "");
      if (!cid || !uid) return;
      if (uid === String(me.userId)) return;

      const name = String(t?.userName || uid);
      const isTyping = !!t?.isTyping;

      setTypingByConv((prev) => {
        const copy = { ...prev };
        if (!isTyping) {
          delete copy[cid];
          return copy;
        }
        copy[cid] = { userId: uid, userName: name, until: Date.now() + 6000 };
        return copy;
      });
    };

    const onConversationSeen = (p: any) => {
      const cid = String(p?.conversationId || "");
      const uid = String(p?.userId || "");
      if (!cid || !uid) return;
      if (uid === String(me.userId)) return;

      const seenAt = p?.seenAt ? new Date(p.seenAt) : new Date();
      setSeenAtByConv((prev) => ({ ...prev, [cid]: seenAt }));
    };

    const onMessageDelivered = (p: any) => {
      const cid = String(p?.conversationId || "");
      const mid = String(p?.messageId || "");
      if (!cid || !mid) return;

      const deliveredAt = p?.deliveredAt ? new Date(p.deliveredAt) : new Date();
      const deliveredToCount = Number(p?.deliveredToCount || 0);

      setDeliveredByMessageId((prev) => ({
        ...prev,
        [mid]: { deliveredAt, deliveredToCount: Number.isFinite(deliveredToCount) ? deliveredToCount : 0 },
      }));

      // If this thread is open, update the message status immediately.
      setThreadMessages((prev) =>
        prev.map((m) =>
          m.messageId === mid
            ? {
                ...m,
                status: "delivered",
                deliveredAt,
                deliveredToCount: Number.isFinite(deliveredToCount) ? deliveredToCount : 0,
              }
            : m
        )
      );
    };

    s.on("message_new", onMessageNew);
    s.on("conversation_updated", onConversationUpdated);
    s.on("unread_update", onUnreadUpdate);
    s.on("typing_update", onTypingUpdate);
    s.on("conversation_seen", onConversationSeen);
    s.on("message_delivered", onMessageDelivered);

    return () => {
      s.off("message_new", onMessageNew);
      s.off("conversation_updated", onConversationUpdated);
      s.off("unread_update", onUnreadUpdate);
      s.off("typing_update", onTypingUpdate);
      s.off("conversation_seen", onConversationSeen);
      s.off("message_delivered", onMessageDelivered);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.userId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mails
      .filter((m) => !q || `${m.from} ${m.subject} ${m.preview}`.toLowerCase().includes(q))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }, [query, mails]);

  // Auto-scroll to bottom when thread updates
  useEffect(() => {
    if (mode !== "read") return;
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [mode, selected?.conversationId, threadMessages.length]);

  const openCompose = () => {
    setMode("compose");
    modeRef.current = "compose";

    setSelected(null);
    selectedConvIdRef.current = null;

    setReplyText("");
    setThreadMessages([]);

    setComposeTo("");
    setComposeBody("");
    setSearchResults([]);
    setPickedUser(null);
  };

  const openRead = async (m: Mail) => {
    setSelected(m);
    setMode("read");
    setReplyText("");
    setThreadMessages([]);

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

    // Fetch peer read state (for "Seen")
    const viewResp = await new Promise<any>((resolve) =>
      s.emit("conversation_get", { conversationId: m.conversationId }, resolve)
    );
    if (viewResp?.ok) {
      const cid = String(m.conversationId);
      const seenAt = viewResp?.conversation?.peerLastReadAt
        ? new Date(viewResp.conversation.peerLastReadAt)
        : null;
      setSeenAtByConv((prev) => ({ ...prev, [cid]: seenAt }));
    }

    const resp = await new Promise<any>((resolve) =>
      s.emit("message_list", { conversationId: m.conversationId, limit: 50 }, resolve)
    );
    if (!resp?.ok) {
      console.error("message_list failed", resp);
      return;
    }

    const msgs = Array.isArray(resp.messages) ? resp.messages : [];
    for (const x of msgs) {
      const mid = String(x?.messageId || "");
      if (mid) seenMessageIdsRef.current.add(mid);
    }

    const mapped = msgs.map(toChatMessage);
    setThreadMessages(mapped);

    // after loading, mark read again (safe)
    void markRead(m.conversationId);
  };

  const backToDefault = () => {
    setMode("default");
    modeRef.current = "default";

    setSelected(null);
    selectedConvIdRef.current = null;

    setReplyText("");
    setThreadMessages([]);

    // ensure typing is cleared
    if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
  };

  const emitTyping = (conversationId: string, isTyping: boolean) => {
    const s = getSocket();
    if (!s) return;
    if (!conversationId) return;
    s.emit(isTyping ? "typing_start" : "typing_stop", { conversationId });
  };

  const bumpTyping = (conversationId: string) => {
    if (!conversationId) return;

    emitTyping(conversationId, true);

    if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = window.setTimeout(() => {
      emitTyping(conversationId, false);
      typingStopTimerRef.current = null;
    }, 1200);
  };

  const sendReply = async () => {
    const body = replyText.trim();
    if (!selected?.conversationId || !body) return;

    const s = getSocket();
    if (!s) return;

    // stop typing on send
    emitTyping(selected.conversationId, false);

    // optimistic bubble
    const optimistic: ChatMessage = {
      key: `tmp:${Date.now()}-${Math.random().toString(16).slice(2)}`,
      senderId: me.userId,
      senderName: me.fullName,
      body,
      createdAt: new Date(),
      mine: true,
      status: "sending",
    };

    setThreadMessages((prev) => [...prev, optimistic]);

    // update list preview immediately
    setMails((prev) =>
      prev
        .map((x) =>
          String(x.conversationId) === String(selected.conversationId)
            ? { ...x, preview: body.length > 80 ? body.slice(0, 80).trimEnd() + "…" : body, receivedAt: new Date() }
            : x
        )
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    );

    setReplyText("");

    const resp = await new Promise<any>((resolve) =>
      s.emit("message_send", { conversationId: selected.conversationId, body }, resolve)
    );

    if (!resp?.ok) {
      console.error("message_send failed", resp);
      // keep optimistic bubble; user will see it was typed (you can add "failed" state later)
      return;
    }

    // If ACK includes message, render immediately (dedupe will prevent double-render)
    if (resp?.message) handleIncomingMessage(resp.message);

    // If server also returns delivered info (peer online), update status.
    try {
      const mid = String(resp?.message?.messageId || "");
      if (mid && resp?.delivered) {
        const deliveredAt = resp.delivered.deliveredAt ? new Date(resp.delivered.deliveredAt) : new Date();
        const deliveredToCount = Number(resp.delivered.deliveredToCount || 0);
        const n = Number.isFinite(deliveredToCount) ? deliveredToCount : 0;
        if (n > 0) {
          setDeliveredByMessageId((prev) => ({
            ...prev,
            [mid]: { deliveredAt, deliveredToCount: n },
          }));
          setThreadMessages((prev) =>
            prev.map((m) =>
              m.messageId === mid
                ? {
                    ...m,
                    status: "delivered",
                    deliveredAt,
                    deliveredToCount: n,
                  }
                : m
            )
          );
        }
      }
    } catch {
      // ignore
    }
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
      const resp = await new Promise<any>((resolve) => s.emit("user_search", { q, limit: 10 }, resolve));
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

    const openResp = await new Promise<any>((resolve) =>
      s.emit("conversation_open", { targetUserId: pickedUser.userId }, resolve)
    );
    if (!openResp?.ok) {
      console.error("conversation_open failed", openResp);
      return;
    }

    const conversationId = String(openResp.conversationId);

    const ok = await joinIfNeeded(conversationId);
    if (!ok) return;

    const sendResp = await new Promise<any>((resolve) =>
      s.emit("message_send", { conversationId, body }, resolve)
    );
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

    if (sendResp?.message) {
      handleIncomingMessage(sendResp.message);

      // delivered info (peer online)
      try {
        const mid = String(sendResp?.message?.messageId || "");
        if (mid && sendResp?.delivered) {
          const deliveredAt = sendResp.delivered.deliveredAt ? new Date(sendResp.delivered.deliveredAt) : new Date();
          const deliveredToCount = Number(sendResp.delivered.deliveredToCount || 0);
          const n = Number.isFinite(deliveredToCount) ? deliveredToCount : 0;
          if (n > 0) {
            setDeliveredByMessageId((prev) => ({
              ...prev,
              [mid]: { deliveredAt, deliveredToCount: n },
            }));
          }
        }
      } catch {
        // ignore
      }
    }

    await openRead(newMail);

    setComposeBody("");
    setPickedUser(null);
    setSearchResults([]);
  };

  // Derived helpers for the open thread
  const typingHere = selected?.conversationId ? typingByConv[selected.conversationId] : undefined;
  const peerSeenAt = selected?.conversationId ? seenAtByConv[selected.conversationId] : null;

  const lastThreadMessage = threadMessages.length ? threadMessages[threadMessages.length - 1] : null;
  const lastMineMessage =
    lastThreadMessage && lastThreadMessage.mine ? lastThreadMessage : null;

  const footerStatus = (() => {
    if (!selected?.conversationId || !lastMineMessage) return null;
    if (lastMineMessage.status === "sending") return "Sending…";

    // Show "Seen" only if peer has read after the last message timestamp
    if (peerSeenAt && peerSeenAt.getTime() >= lastMineMessage.createdAt.getTime()) {
      return `Seen · ${timeOnly(peerSeenAt)}`;
    }

    if (lastMineMessage.status === "delivered") {
      const n = Number(lastMineMessage.deliveredToCount || 0);
      if (Number.isFinite(n) && n > 1) return `Delivered to ${n}`;
      return "Delivered";
    }

    return "Sent";
  })();

  return (
    // Full-width shell (no fixed max width). Padding is handled by the page layout.
    <section className="w-full">
      <div
        ref={panelRef}
        style={panelHeight ? { height: panelHeight } : undefined}
        className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm min-h-[520px]"
      >
        {/* Page Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
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

        {/* Chat Layout */}
        <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-[340px_1fr]">
          {/* Left: conversation list */}
          <aside
            className={cls(
              "bg-white lg:border-r border-gray-200",
              mode === "default" ? "flex flex-col" : "hidden lg:flex lg:flex-col"
            )}
          >
            <div className="border-b border-gray-200 bg-white px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Messages</div>
                  <div className="mt-0.5 text-[11px] text-gray-400">{filtered.length} conversations</div>
                </div>

                <button
                  onClick={openCompose}
                  disabled={mode === "compose"}
                  className={cls(
                    "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold shadow-sm",
                    mode === "compose"
                      ? "cursor-not-allowed bg-gray-200 text-gray-500"
                      : "bg-emerald-700 text-white hover:bg-emerald-800"
                  )}
                  title="New message"
                >
                  <Plus className="h-4 w-4" />
                  <span>New message</span>
                </button>
              </div>

              <div className="relative mt-3">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none shadow-sm focus:ring-2 focus:ring-emerald-500/20"
                  placeholder="Search conversations"
                />
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
              {filtered.map((m) => {
                const active = selected?.conversationId === m.conversationId && mode === "read";
                const typing = typingByConv[m.conversationId];

                return (
                  <button
                    key={m.conversationId}
                    onClick={() => openRead(m)}
                    className={cls(
                      "group w-full rounded-xl px-3 py-3 text-left transition",
                      active ? "bg-emerald-50 shadow-sm ring-1 ring-emerald-200" : "hover:bg-gray-50"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cls(
                          "grid h-10 w-10 place-items-center rounded-full text-[11px] font-bold",
                          active
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-white text-gray-700 border border-gray-200"
                        )}
                      >
                        {initials(m.from)}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate text-sm font-semibold text-gray-900">{m.from}</div>
                          <div className="shrink-0 text-[11px] text-gray-500" title={fullStamp(m.receivedAt)}>
                            {inboxStamp(m.receivedAt, now)}
                          </div>
                        </div>

                        <div className="mt-0.5 flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1 truncate text-xs text-gray-500">
                            {typing ? <span className="italic text-gray-500">Typing…</span> : m.preview || "—"}
                          </div>
                          {m.unread > 0 && (
                            <span className="shrink-0 rounded-full bg-emerald-700 px-2 py-0.5 text-[11px] font-semibold text-white">
                              {m.unread}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}

              {filtered.length === 0 && (
                <div className="mx-2 rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
                  No messages found.
                </div>
              )}
            </div>
          </aside>

          {/* Right: bubble chat */}
          <section className="flex min-h-0 flex-col">
            {mode === "default" && (
              <div className="grid flex-1 place-items-center bg-gradient-to-b from-gray-50 to-white px-6 text-center text-gray-500">
                <div>
                  <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl border border-gray-200 bg-gray-50">
                    <MessageSquare className="h-7 w-7 text-gray-500" />
                  </div>
                  <div className="font-semibold text-gray-700">Select a conversation</div>
                  <div className="mt-1 text-sm">Choose a thread to start chatting.</div>
                </div>
              </div>
            )}

            {mode === "compose" && (
              <>
                {/* Compose Header */}
                <div className="border-b border-gray-200 bg-white px-5 py-4">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={backToDefault}
                      className="lg:hidden rounded-lg border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
                    >
                      Back
                    </button>
                    <div className="text-sm font-semibold text-gray-900">New message</div>
                    <button
                      onClick={backToDefault}
                      className="ml-auto rounded-lg border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="relative mt-3">
                    <label className="mb-1 block text-xs font-semibold text-gray-600">To</label>
                    <input
                      value={composeTo}
                      onChange={(e) => {
                        setComposeTo(e.target.value);
                        setPickedUser(null);
                      }}
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none shadow-sm focus:ring-2 focus:ring-emerald-500/20"
                      placeholder="Search user by name/email..."
                    />

                    {searchResults.length > 0 && !pickedUser && (
                      <div className="absolute z-10 mt-2 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow">
                        {searchResults.map((u: any) => (
                          <button
                            key={u.userId}
                            type="button"
                            onClick={() => pickRecipient(u)}
                            className="w-full px-4 py-3 text-left text-sm hover:bg-gray-50"
                          >
                            <div className="font-semibold text-gray-900">{u.fullName}</div>
                            <div className="text-xs text-gray-500">{u.email || u.userId}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Compose Messages Area */}
                <div className="flex-1 min-h-0 overflow-y-auto bg-gradient-to-b from-gray-50 to-white px-4 sm:px-6 lg:px-10 py-6">
                  <div className="text-sm text-gray-500">Type a message below to start the conversation.</div>
                </div>

                {/* Compose Input */}
                <div className="border-t border-gray-200 bg-white px-4 py-3">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={composeBody}
                      onChange={(e) => setComposeBody(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void sendCompose();
                        }
                      }}
                      rows={1}
                      className="min-h-[42px] max-h-32 flex-1 resize-none rounded-2xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/20"
                      placeholder={pickedUser ? `Message ${composeTo}...` : "Select a recipient first..."}
                    />
                    <button
                      onClick={sendCompose}
                      disabled={!pickedUser || !composeBody.trim()}
                      className={cls(
                        "inline-flex h-10 w-10 items-center justify-center rounded-full text-white shadow-sm",
                        pickedUser && composeBody.trim()
                          ? "bg-emerald-700 hover:bg-emerald-700"
                          : "bg-gray-300 cursor-not-allowed"
                      )}
                      title="Send"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 text-[11px] text-gray-400">Press Enter to send, Shift+Enter for a new line.</div>
                </div>
              </>
            )}

            {mode === "read" && selected && (
              <>
                {/* Thread Header */}
                <div className="border-b border-gray-200 bg-white px-5 py-4">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={backToDefault}
                      className="lg:hidden rounded-lg border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
                    >
                      Back
                    </button>
                    <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-100 text-[12px] font-bold text-emerald-700">
                      {initials(selected.from)}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-gray-900">To: {selected.from}</div>
                      <div className="truncate text-xs text-gray-500">
                        {typingHere ? (
                          <span className="italic">{typingHere.userName} is typing…</span>
                        ) : (
                          selected.email || selected.peerUserId || ""
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="hidden text-xs text-gray-400 sm:block" title={fullStamp(selected.receivedAt)}>
                        {fullStamp(selected.receivedAt)}
                      </div>
                      <button
                        onClick={backToDefault}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>

                {/* Messages */}
                <div
                  ref={messagesScrollRef}
                  className="flex-1 min-h-0 overflow-y-auto bg-gradient-to-b from-gray-50 to-white px-4 sm:px-6 lg:px-10 py-6"
                >
                  {threadMessages.length === 0 ? (
                    <div className="text-sm text-gray-500">No messages yet.</div>
                  ) : (
                    <div className="min-h-full flex flex-col justify-end gap-2">
                      {threadMessages.map((msg, idx) => {
                        const prev = threadMessages[idx - 1] || null;
                        const showSep = shouldShowSeparator(prev ? prev.createdAt : null, msg.createdAt);
                        const showSender = !msg.mine && (!prev || prev.senderId !== msg.senderId);
                        const showAvatar = showSender;

                        return (
                          <div key={msg.key} className="w-full">
                            {showSep ? (
                              <div className="my-3 flex justify-center">
                                <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-[11px] text-gray-500 shadow-sm" title={fullStamp(msg.createdAt)}>
                                  {threadSeparatorLabel(msg.createdAt, now)}
                                </span>
                              </div>
                            ) : null}

                            <div
                              className={cls(
                                "group flex w-full items-end gap-3",
                                msg.mine ? "justify-end" : "justify-start"
                              )}
                            >
                              {!msg.mine ? (
                                <div className="w-9 shrink-0">
                                  {showAvatar ? (
                                    <div className="grid h-8 w-8 place-items-center rounded-full border border-gray-200 bg-white text-[11px] font-bold text-gray-700">
                                      {initials(msg.senderName)}
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}

                              <div
                                className={cls(
                                  "flex min-w-0 flex-1 flex-col",
                                  msg.mine ? "items-end" : "items-start"
                                )}
                              >
                                {showSender ? (
                                  <div className="mb-1 text-[11px] font-semibold text-gray-500">{msg.senderName}</div>
                                ) : null}

                                <div
                                  className={cls(
                                    "w-fit max-w-[88%] sm:max-w-[80%] lg:max-w-[72%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm",
                                    msg.mine
                                      ? "bg-emerald-700 text-white rounded-br-md"
                                      : "bg-white text-gray-900 border border-gray-200 rounded-bl-md"
                                  )}
                                >
                                  <div className="whitespace-pre-wrap break-words">{msg.body}</div>
                                </div>

                                {/* Hover time (like a real inbox) */}
                                <div
                                  className={cls(
                                    "mt-1 text-[10px] text-gray-400 opacity-0 transition group-hover:opacity-100",
                                    msg.mine ? "text-right" : "text-left"
                                  )}
                                >
                                  {timeOnly(msg.createdAt)}
                                </div>

                                {/* Footer status under the latest outgoing message */}
                                {footerStatus && lastMineMessage && msg.key === lastMineMessage.key ? (
                                  <div className="mt-1 text-[11px] text-gray-400">{footerStatus}</div>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {/* Typing indicator bubble at the bottom */}
                      {typingHere ? (
                        <div className="mt-2 flex items-end gap-3">
                          <div className="w-9 shrink-0">
                            <div className="grid h-8 w-8 place-items-center rounded-full border border-gray-200 bg-white text-[11px] font-bold text-gray-700">
                              {initials(typingHere.userName)}
                            </div>
                          </div>
                          <div className="rounded-2xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700 shadow-sm">
                            <span className="inline-flex items-center gap-1">
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: "120ms" }} />
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: "240ms" }} />
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>

                {/* Reply Input */}
                <div className="border-t border-gray-200 bg-white px-4 py-3">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={replyText}
                      onChange={(e) => {
                        setReplyText(e.target.value);
                        if (selected?.conversationId) bumpTyping(selected.conversationId);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void sendReply();
                        }
                      }}
                      rows={1}
                      className="min-h-[42px] max-h-32 flex-1 resize-none rounded-2xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-emerald-500/20"
                      placeholder={`Message ${selected.from}...`}
                    />
                    <button
                      onClick={sendReply}
                      disabled={!replyText.trim()}
                      className={cls(
                        "inline-flex h-10 w-10 items-center justify-center rounded-full text-white shadow-sm",
                        replyText.trim() ? "bg-emerald-700 hover:bg-emerald-700" : "bg-gray-300 cursor-not-allowed"
                      )}
                      title="Send"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 text-[11px] text-gray-400">Press Enter to send, Shift+Enter for a new line.</div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
