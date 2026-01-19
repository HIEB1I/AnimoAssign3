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

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  const session = getSession();
  const userId = (session?.userId || session?.user_id || session?.id || "").toString().trim();
  if (!userId) return null;

  // Create once per tab
  if (!socket) {
    socket = io({
      path: "/api/socket.io",
      transports: ["websocket"], // strict websocket (matches your requirement)
      auth: {
        userId,
        email: (session?.email || session?.gmail || "").toString(),
      },
      autoConnect: true,
    });

    socket.on("connect", () => console.log("[socket] connected", socket?.id));
    socket.on("disconnect", (reason) => console.log("[socket] disconnected", reason));
    socket.on("connect_error", (err) => console.log("[socket] connect_error", err?.message || err));
    socket.on("socket:ready", (msg) => console.log("[socket] ready", msg));
  }

  return socket;
}
