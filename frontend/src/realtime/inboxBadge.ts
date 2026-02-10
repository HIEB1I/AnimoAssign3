// frontend/src/realtime/inboxBadge.ts
// Tiny global store for showing an "unread/new message" badge on the TopBar Inbox icon.
// - No Redux/Zustand
// - Driven by Socket.IO events (message_new / unread_update)
// - Seeded on socket connect via conversation_list

import { useEffect, useState } from "react";

export type InboxBadgeState = {
  unreadTotal: number;
  unreadByConversation: Record<string, number>;
};

let unreadByConversation = new Map<string, number>();
let listeners = new Set<(s: InboxBadgeState) => void>();

function snapshot(): InboxBadgeState {
  const obj: Record<string, number> = {};
  let total = 0;

  unreadByConversation.forEach((v, k) => {
    const n = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    // Only keep unread > 0 for the public snapshot, but keep zeros in the map
    // so that a later replace/seed doesn't "revive" stale values.
    if (n > 0) {
      obj[k] = n;
      total += n;
    }
  });

  return { unreadTotal: total, unreadByConversation: obj };
}

function emit() {
  const s = snapshot();
  listeners.forEach((fn) => fn(s));
}

export function subscribeInboxBadge(fn: (s: InboxBadgeState) => void): () => void {
  listeners.add(fn);
  fn(snapshot());
  return () => {
    listeners.delete(fn);
  };
}

export function useInboxBadge(): InboxBadgeState {
  const [state, setState] = useState<InboxBadgeState>(() => snapshot());
  useEffect(() => subscribeInboxBadge(setState), []);
  return state;
}

function normalizeUnread(n: any): number {
  const x = Number(n || 0);
  return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0;
}

/** Merge/update unread values for a list of conversations (does not clear missing conversations). */
export function seedInboxUnread(list: Array<{ conversationId: string; unread: number }>) {
  let changed = false;

  for (const x of list || []) {
    const cid = String(x?.conversationId || "").trim();
    if (!cid) continue;

    const next = normalizeUnread(x.unread);
    const prev = unreadByConversation.get(cid) ?? 0;

    if (prev !== next) {
      unreadByConversation.set(cid, next);
      changed = true;
    }
  }

  if (changed) emit();
}

/** Replace the entire unread map from a fresh server snapshot. */
export function replaceInboxUnread(list: Array<{ conversationId: string; unread: number }>) {
  const nextMap = new Map<string, number>();

  for (const x of list || []) {
    const cid = String(x?.conversationId || "").trim();
    if (!cid) continue;
    nextMap.set(cid, normalizeUnread(x.unread));
  }

  unreadByConversation = nextMap;
  emit();
}

export function setConversationUnread(conversationId: string, unread: number) {
  const cid = String(conversationId || "").trim();
  if (!cid) return;

  const next = normalizeUnread(unread);
  const prev = unreadByConversation.get(cid) ?? 0;
  if (prev === next) return;

  unreadByConversation.set(cid, next);
  emit();
}

export function clearConversationUnread(conversationId: string) {
  setConversationUnread(conversationId, 0);
}

export function bumpConversationUnread(conversationId: string, delta: number = 1) {
  const cid = String(conversationId || "").trim();
  if (!cid) return;

  const cur = unreadByConversation.get(cid) ?? 0;
  const d = Number.isFinite(delta) ? Math.floor(delta) : 1;
  const next = Math.max(0, cur + d);

  unreadByConversation.set(cid, next);
  emit();
}

// -----------------------------
// Socket integration (attach once)
// -----------------------------

let attached = false;

export function attachInboxBadgeSocket(socket: any) {
  if (!socket || attached) return;
  attached = true;

  socket.on("unread_update", (u: any) => {
    const cid = String(u?.conversationId || "").trim();
    if (!cid) return;
    setConversationUnread(cid, u?.unread);
  });

  socket.on("message_new", (m: any) => {
    // Fast UI: bump immediately; backend will soon send unread_update with exact count.
    const cid = String(m?.conversationId || "").trim();
    if (!cid) return;
    bumpConversationUnread(cid, 1);
  });
}

export function resetInboxBadgeSocket() {
  attached = false;
}

/** Clear all unread state (used on logout / user switch). */
export function resetInboxBadgeState() {
  unreadByConversation = new Map<string, number>();
  emit();
}
