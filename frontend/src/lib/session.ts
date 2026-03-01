// frontend/src/lib/session.ts
export type SessionUser = {
  userId?: string;
  user_id?: string;
  id?: string;
  email?: string;
  fullName?: string;
  roles?: string[];
  [k: string]: any;
};

export function getSessionUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem("animo.user");
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && typeof u === "object" ? (u as SessionUser) : null;
  } catch {
    return null;
  }
}

export function getSessionUserId(): string | null {
  const u = getSessionUser();
  const id = u?.userId || u?.user_id || u?.id || (u as any)?._id;
  if (!id) return null;
  const s = String(id).trim();
  return s ? s : null;
}
