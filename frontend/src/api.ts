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

// Descriptive #1
export async function fetchTeachingHistory(facultyId: string) {
  const base = (ANALYTICS_BASE || API_BASE).replace(/\/+$/, "");
  const url = `${base}/teaching-history?faculty_id=${encodeURIComponent(facultyId)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Descriptive #2
export async function fetchCourseProfiles(termId: string) {
  const url = `${API_BASE.replace(/\/+$/, "")}/course-profiles?term_id=${encodeURIComponent(termId)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Descriptive #3
export async function fetchDeloadingUtilization(term?: string) {
  const base = (ANALYTICS_BASE || API_BASE).replace(/\/+$/, "");
  const url = `${base}/deloading-utilization${term ? `?term_id=${encodeURIComponent(term)}` : ""}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Predictive #1

// Predictive #2
export async function fetchPTRisk(params: {
  department_id?: string;
  overload_allowance_units?: number;       // 0 or 3
  history_terms_for_experience?: number;   // default 3
  include_only_with_preferences?: boolean; // default false
  allow_fallback_without_sections?: boolean; // default false
}) {
  const base = (typeof ANALYTICS_BASE !== "undefined" ? ANALYTICS_BASE : API_BASE).replace(/\/+$/, "");
  const sp = new URLSearchParams();
  if (params.department_id) sp.set("department_id", params.department_id);
  if (params.overload_allowance_units != null) sp.set("overload_allowance_units", String(params.overload_allowance_units));
  if (params.history_terms_for_experience != null) sp.set("history_terms_for_experience", String(params.history_terms_for_experience));
  if (params.include_only_with_preferences != null) sp.set("include_only_with_preferences", String(params.include_only_with_preferences));
  if (params.allow_fallback_without_sections != null) sp.set("allow_fallback_without_sections", String(params.allow_fallback_without_sections));

  const url = `${base}/analytics/pt-risk?${sp.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
