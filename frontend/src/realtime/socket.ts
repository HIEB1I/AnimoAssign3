// frontend/src/realtime/socket.ts
import { io, Socket } from "socket.io-client";

type SessionUser = {
  userId?: string;
  user_id?: string;
  id?: string;
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
  // Your project already uses this for REST calls
  const backend = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? "/api";

  // backend can be:
  // - "/api"
  // - "/staging/api"
  // - "http://localhost:8000/api"
  let basePath = backend;
  let absoluteOrigin: string | undefined;

  if (/^https?:\/\//i.test(backend)) {
    const u = new URL(backend);
    absoluteOrigin = u.origin;
    basePath = u.pathname || "/";
  }

  const apiPath = normalizePath(basePath); // e.g. "/api" or "/staging/api"
  const socketPath = `${apiPath}/socket.io`; // e.g. "/api/socket.io"

  // DEV: connect directly to backend host (avoid Vite websocket proxy issues)
  // PROD: use same-origin (no url), and only the path.
  const devOrigin =
    (import.meta.env.VITE_SOCKET_ORIGIN as string | undefined) || "http://localhost:8000";

  const url =
    absoluteOrigin ??
    (import.meta.env.DEV ? devOrigin : undefined);

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
}

export function getSocket(): Socket | null {
  const session = getSession();
  const userId = (session?.userId || session?.user_id || session?.id || "").toString().trim();
  if (!userId) return null;

  // If user changes (logout/login), recreate the socket cleanly
  if (socket && socketUserId && socketUserId !== userId) {
    resetSocket();
  }

  if (!socket) {
    const { url, path } = resolveSocketTarget();

    socketUserId = userId;

    // If url is undefined, Socket.IO uses current origin (good for production same-domain)
    socket = url
      ? io(url, {
          path,
          transports: ["websocket"],
          auth: {
            userId,
            email: (session?.email || session?.gmail || "").toString(),
          },
          autoConnect: true,
          reconnection: true,
        })
      : io({
          path,
          transports: ["websocket"],
          auth: {
            userId,
            email: (session?.email || session?.gmail || "").toString(),
          },
          autoConnect: true,
          reconnection: true,
        });

    socket.on("connect", () => console.log("[socket] connected", socket?.id));
    socket.on("disconnect", (reason) => console.log("[socket] disconnected", reason));
    socket.on("connect_error", (err) =>
      console.log("[socket] connect_error", (err as any)?.message || err)
    );
    socket.on("socket:ready", (msg) => console.log("[socket] ready", msg));
  }

  return socket;
}
