// frontend/src/api.ts
import axios from "axios";

/**
 * BASE is set by Vite:
 *  - dev: "/"
 *  - staging build: "/staging/"
 *  - prod build: "/"
 */
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");

function join(a: string, b: string) {
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

/**
 * Resolve a service base:
 * - If override is absolute (http/https), use it as-is.
 * - Else, join it under BASE (so "/staging/" -> "/staging/api").
 * - If no override is provided, use the given default path.
 */

function resolveBase(override: string | undefined, defaultPath: string): string {
  if (override && /^https?:\/\//i.test(override)) return override.replace(/\/+$/, "");
  const path = (override && override.length ? override : defaultPath)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return join(BASE, path);
}

// Final service bases (work everywhere without edits)
export const API_BASE = resolveBase(
  import.meta.env.VITE_BACKEND_URL as string | undefined,
  "api"
);
export const ANALYTICS_BASE = resolveBase(
  import.meta.env.VITE_ANALYTICS_URL as string | undefined,
  "analytics"
);

// Optional axios instance if you use axios elsewhere
export const api = axios.create({ baseURL: API_BASE });
// DONT REMOVE ABOVE

// ---------- Feature calls ----------

export type LoginResponse = { userId: string; email: string; fullName: string; roles: string[] };

export async function login(email: string): Promise<LoginResponse> {
  const r = await fetch(join(API_BASE, "login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
export async function fetchOmHome(userId: string) {
  const r = await fetch(join(API_BASE, `om/home?userId=${encodeURIComponent(userId)}`));
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchOmProfile(userId: string) {
  const r = await fetch(join(API_BASE, `om/profile?userId=${encodeURIComponent(userId)}`));
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------------- APO: Pre Enlistment ----------------
export type PreenlistmentCountDoc = {
  count_id: string;
  preenlistment_code?: string;
  career: string;
  acad_group: string;
  campus_name: "MANILA" | "LAGUNA";
  course_code: string;
  count: number;
  campus_id?: "CMPS001" | "CMPS002";
  course_id?: string;
  user_id: string;
  term_id: string;
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type PreenlistmentStatDoc = {
  stat_id: string;
  program_code: string;
  program_id?: string;
  freshman: number;
  sophomore: number;
  junior: number;
  senior: number;
  term_id: string;
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type TermMeta = {
  term_id: string;
  ay_label: string;
  term_number?: number;
  is_current?: boolean;
  campus_label?: string;   // NEW: provided by backend
};

export type ApoPreenlistmentResponse = {
  count: PreenlistmentCountDoc[];
  statistics: PreenlistmentStatDoc[];
  meta?: TermMeta;
  archiveMeta?: TermMeta;
  [k: string]: unknown;
};

export type CountCsvRow = {
  Code?: string;
  Career: string;
  "Acad Group": string;
  Campus: "MANILA" | "LAGUNA";
  "Course Code": string;
  Count: number | string;
};

export type StatCsvRow = {
  Program: string;
  FRESHMAN: number | string;
  SOPHOMORE: number | string;
  JUNIOR: number | string;
  SENIOR: number | string;
};

export type ArchiveMetaItem = {
  term_id: string;
  ay_label: string;
  courses?: number;
  programs?: number;
};

export type ArchivesMetaResponse = { archives: ArchiveMetaItem[] };

export async function getApoPreenlistment(
  userId: string,
  termId?: string,
  scope: "active" | "archive" | "archivesMeta" = "active"
): Promise<ApoPreenlistmentResponse> {
  const params = new URLSearchParams({ userId, scope });
  if (termId) params.set("termId", termId);
  const r = await fetch(join(API_BASE, `apo/preenlistment?${params.toString()}`));
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function getApoPreenlistmentMeta(userId: string): Promise<ArchivesMetaResponse> {
  const params = new URLSearchParams({ userId, scope: "archivesMeta" });
  const r = await fetch(join(API_BASE, `apo/preenlistment?${params.toString()}`));
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function importApoPreenlistment(
  userId: string,
  countRows: CountCsvRow[],
  statRows: StatCsvRow[],
  termId?: string,
  opts?: { replaceCount?: boolean; replaceStats?: boolean }
) {
  const qs = new URLSearchParams({
    userId,
    action: "import",
    replaceCount: String(!!opts?.replaceCount),
    replaceStats: String(!!opts?.replaceStats),
  });
  if (termId) qs.set("termId", termId);
  const r = await fetch(join(API_BASE, `apo/preenlistment?${qs.toString()}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ countRows, statRows }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function archiveApoPreenlistment(userId: string, termId?: string) {
  const qs = new URLSearchParams({ userId, action: "archive" });
  if (termId) qs.set("termId", termId);
  const r = await fetch(join(API_BASE, `apo/preenlistment?${qs.toString()}`), { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------------- APO: Room Allocation ----------------
export type Day = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";

export type RoomDoc = {
  room_id: string; room_number: string; room_type: string; capacity: number; building: string; campus_id: string; status: string;
};
export type SectionDoc = { section_id: string; section_code: string; course_id?: string; course_code?: string; };
export type SectionScheduleDoc = {
  schedule_id: string; section_id: string; day: Day; start_time: string; end_time: string; room_id?: string | null; time_band: string;
};
export type RoomScheduleCell = {
  schedule_id?: string; section_id?: string | null; day: Day; start_time?: string; end_time?: string; time_band: string; room_id?: string | null;
  section_code?: string; course_code?: string; label?: string; faculty?: string; allowed?: boolean;
};
export type RoomWithSchedule = RoomDoc & { schedule: RoomScheduleCell[] };

export type RoomAllocationResponse = {
  campus: { campus_id: string; campus_name: string };
  term_id: string;
  buildings: string[];
  timeBands: string[];
  rooms: RoomWithSchedule[];
  sections: SectionDoc[];
  sectionSchedules: SectionScheduleDoc[];
  facultyBySection: Record<string, { faculty_id: string; user_id: string; faculty_name: string }>;
  courses?: { course_id: string; course_code: string[] | string }[];
};

const base = API_BASE.replace(/\/$/, "");

export async function getApoRoomAllocation(userId: string): Promise<RoomAllocationResponse> {
  const r = await fetch(`${base}/apo/roomallocation?${new URLSearchParams({ userId }).toString()}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function addRoom(userId: string, data: { building: string; room_number: string; room_type: string; capacity: number }) {
  const r = await fetch(`${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "addRoom" }).toString()}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateRoom(userId: string, data: { room_id: string; capacity?: number; room_type?: string; status?: string }) {
  const r = await fetch(`${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "updateRoom" }).toString()}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function setRoomAvailability(userId: string, data: { room_id: string; day: Day; time_bands: string[] }) {
  const r = await fetch(`${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "setAvailability" }).toString()}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function assignRoom(userId: string, data: { room_id: string; section_id: string; day: Day; time_band: string }) {
  const r = await fetch(`${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "assign" }).toString()}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function unassignRoom(userId: string, data: { room_id: string; section_id: string; day: Day; time_band: string }) {
  const r = await fetch(`${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "unassign" }).toString()}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function removeRoom(userId: string, payload: { room_id: string }) {
  const r = await fetch(`${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "removeRoom" }).toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------------- STUDENT: Petition ----------------
// Fetch petitions
export async function getStudentPetitions(userId: string) {
  const res = await axios.post(`${API_BASE}/student/petition`, {}, {
    params: { userId, action: "fetch" },
  });
  return res.data;
}

// Fetch dropdown options
export async function getStudentOptions(userId: string) {
  const res = await axios.post(`${API_BASE}/student/petition`, {}, {
    params: { userId, action: "options" },
  });
  return res.data;
}

// Fetch profile info (auto-fill)
export async function getStudentProfile(userId: string) {
  const res = await axios.post(`${API_BASE}/student/petition`, {}, {
    params: { userId, action: "profile" },
  });
  return res.data;
}

// Submit petition
export async function submitStudentPetition(userId: string, data: any) {
  const res = await axios.post(`${API_BASE}/student/petition`, data, {
    params: { userId, action: "submit" },
  });
  return res.data;
}

// --- Faculty Overview ---
export async function getFacultyOverview(userId: string) {
  try {
    const res = await axios.get(`${API_BASE}/faculty/overview`, { params: { userId } });
    return res.data;
  } catch (err: any) {
    const msg = err?.response?.data?.detail || err?.message || "Request failed";
    return { ok: false, message: msg };
  }
}