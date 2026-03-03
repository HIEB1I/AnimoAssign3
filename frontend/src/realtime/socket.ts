// frontend/src/realtime/socket.ts
import { io, Socket } from "socket.io-client";
import { emitAck } from "./ack";
import {
  attachInboxBadgeSocket,
  replaceInboxUnread,
  resetInboxBadgeSocket,
  resetInboxBadgeState,
} from "./inboxBadge";

type SessionUser = {
  userId?: string;
  user_id?: string;
  id?: string;
  _id?: string;
  email?: string;
  gmail?: string;
};

function getSession(): SessionUser | null {
  try {
    const raw = localStorage.getItem("animo.user");
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

function normalizePath(p: string): string {
  if (!p) return "";
  let out = p.trim();
  if (!out.startsWith("/")) out = "/" + out;
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function resolveSocketTarget(): { url?: string; path: string } {
  const backend = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? "/api";

  let basePath = backend;
  let absoluteOrigin: string | undefined;

  if (/^https?:\/\//i.test(backend)) {
    const u = new URL(backend);
    absoluteOrigin = u.origin;
    basePath = u.pathname || "/";
  }

  const apiPath = normalizePath(basePath);
  const socketPath = `${apiPath}/socket.io`;

  const devOrigin =
    (import.meta.env.VITE_SOCKET_ORIGIN as string | undefined) || "http://localhost:8000";

  const url = absoluteOrigin ?? (import.meta.env.DEV ? devOrigin : undefined);

  return { url, path: socketPath };
}

let socket: Socket | null = null;
let socketUserId: string | null = null;

export function resetSocket() {
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch {}
  }
  socket = null;
  socketUserId = null;
  resetInboxBadgeSocket();
  resetInboxBadgeState();
}

export function getSocket(): Socket | null {
  const session = getSession();
  const userId = (session?.userId || session?.user_id || session?.id || (session as any)?._id || "").toString().trim();
  if (!userId) return null;

  if (socket && socketUserId && socketUserId !== userId) {
    resetSocket();
  }

  if (!socket) {
    const { url, path } = resolveSocketTarget();
    socketUserId = userId;

    socket = url
      ? io(url, {
          path,
          transports: ["websocket", "polling"],
          withCredentials: true,
          auth: {
            ...( /^USR/i.test(userId) ? { userId } : {} ),
            email: (session?.email || session?.gmail || "").toString(),
          },
          autoConnect: true,
          reconnection: true,
        })
      : io({
          path,
          transports: ["websocket", "polling"],
          withCredentials: true,
          auth: {
            ...( /^USR/i.test(userId) ? { userId } : {} ),
            email: (session?.email || session?.gmail || "").toString(),
          },
          autoConnect: true,
          reconnection: true,
        });

    // ✅ Attach inbox badge listeners once
    attachInboxBadgeSocket(socket);


    const seedUnreadFromServer = async () => {
      try {
        if (!socket) return;
        const resp = await emitAck<any>(socket, "conversation_list", { limit: 50 });
        if (!resp?.ok) return;

        const convs = Array.isArray(resp?.conversations) ? resp.conversations : [];
        replaceInboxUnread(
          convs.map((c: any) => ({
            conversationId: String(c?.conversationId || c?.conversation_id || ""),
            unread: Number(c?.unread || 0),
          }))
        );
      } catch {
        // ignore seed errors
      }
    };

    socket.on("connect", () => {
      console.log("[socket] connected", socket?.id);
      // Refresh unread snapshot on (re)connect so the badge stays correct after reload.
      void seedUnreadFromServer();
    });

    socket.on("disconnect", (reason) => console.log("[socket] disconnected", reason));

    socket.on("connect_error", (err) =>
      console.log("[socket] connect_error", (err as any)?.message || err)
    );

    socket.on("socket:ready", (msg) => {
      console.log("[socket] ready", msg);
      try {
        const canonical = String((msg as any)?.userId || "").trim();
        if (canonical && /^USR/i.test(canonical)) {
          const raw = localStorage.getItem("animo.user");
          if (raw) {
            const u = JSON.parse(raw);
            const prev = String(u?.userId || u?.user_id || u?.id || u?._id || "").trim();
            if (prev !== canonical) {
              u.user_id = canonical;
              // keep userId consistent too (some screens read this field)
              if (!u.userId || !/^USR/i.test(String(u.userId))) u.userId = canonical;
              localStorage.setItem("animo.user", JSON.stringify(u));
            }
          }
        }
      } catch {}
      void seedUnreadFromServer();
    });
}

  return socket;
}
