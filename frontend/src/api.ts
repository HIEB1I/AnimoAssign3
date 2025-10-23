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
function resolveBase(
  override: string | undefined,
  defaultPath: string
): string {
  if (override && /^https?:\/\//i.test(override)) {
    return override.replace(/\/+$/, "");
  }
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

export type LoginResponse = {
  userId: string;
  email: string;
  fullName: string;
  roles: string[];
};

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

// ---------- APO: single-route preenlistment ----------
export type PreenlistmentCountDoc = {
  count_id: string;
  code: string;
  career: string;
  acad_group: string;
  campus: "MANILA" | "LAGUNA";
  course_code: string;
  count: number;
  campus_id: "CMPS001" | "CMPS002";
  apo_user_id: string;
  term_id: string;
  created_at?: string;
  updated_at?: string;
};

export type PreenlistmentStatDoc = {
  stat_id: string;
  program: string;
  freshman: number;
  sophomore: number;
  junior: number;
  senior: number;
  term_id: string;
  created_at?: string;
  updated_at?: string;
};

export type ApoPreenlistmentResponse = {
  count: PreenlistmentCountDoc[];
  statistics: PreenlistmentStatDoc[];
};

// CSV headers EXACTLY like your files
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

export async function getApoPreenlistment(
  userId: string,
  termId = "TERM_2025_T1"
): Promise<ApoPreenlistmentResponse> {
  const r = await fetch(
    join(API_BASE, `apo/preenlistment?userId=${encodeURIComponent(userId)}&termId=${encodeURIComponent(termId)}`)
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function importApoPreenlistment(
  userId: string,
  countRows: CountCsvRow[],
  statRows: StatCsvRow[],
  termId = "TERM_2025_T1",
  opts?: { replaceCount?: boolean; replaceStats?: boolean }
) {
  const qs = new URLSearchParams({
    userId,
    termId,
    replaceCount: String(!!opts?.replaceCount),
    replaceStats: String(!!opts?.replaceStats),
  });
  const r = await fetch(join(API_BASE, `apo/preenlistment?${qs.toString()}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ countRows, statRows }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
