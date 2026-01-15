// frontend/src/api.ts
import axios, { AxiosError } from "axios";

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

/* =========================================================
   ===============  LOGIN (Email and Password)  ============
   ========================================================= */
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

/* =========================================================
   ===============  LOGIN (Google Auth)  ===================
   ========================================================= */
// Types kept for localStorage consumers
// export type LoginResponse = { userId: string; email: string; fullName: string; roles: string[] };
// export function googleStartUrl(returnTo: string) {
//   return join(API_BASE, `auth/google/start?return_to=${encodeURIComponent(returnTo)}`);
// }

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

// Descriptive #2 (use ANALYTICS_BASE, not absolute path)
export async function fetchCourseProfile(query: string) {
  const url = `${ANALYTICS_BASE.replace(/\/+$/, "")}/course-profile-for?query=${encodeURIComponent(
    query
  )}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json();
}

// Descriptive #3
export async function fetchDeloadingsByTerm(
  anchorTermId?: string,
  direction: "current" | "next" | "prev" = "current"
) {
  const params = new URLSearchParams();
  if (anchorTermId) params.set("anchor_term_id", anchorTermId);
  if (direction) params.set("direction", direction);

  const url = `${ANALYTICS_BASE.replace(/\/+$/, "")}/deloadings/by-term?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json();
}

// Predictive #1 (updated)
export async function fetchFacultyAvailabilityHeatmap<T = unknown>(params?: {
  course_id?: string;
  dept_id?: string;
  threshold?: number; // default handled server-side (e.g., 0.50)
}): Promise<T> {
  const qs = new URLSearchParams();
  if (params?.course_id) qs.set("course_id", params.course_id);
  if (params?.dept_id) qs.set("dept_id", params.dept_id);
  if (params?.threshold !== undefined) qs.set("threshold", String(params.threshold));

  const url =
    `${ANALYTICS_BASE.replace(/\/+$/, "")}/faculty-availability-heatmap` +
    (qs.toString() ? `?${qs.toString()}` : "");

  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as T;
}

// Predictive #2
export async function fetchPTRisk(params: {
  department_id?: string;
  overload_allowance_units?: number; // 0 or 3
  history_terms_for_experience?: number; // default 3
  include_only_with_preferences?: boolean; // default false
  allow_fallback_without_sections?: boolean; // default false
}) {
  const base = (typeof ANALYTICS_BASE !== "undefined" ? ANALYTICS_BASE : API_BASE).replace(
    /\/+$/,
    ""
  );
  const sp = new URLSearchParams();
  if (params.department_id) sp.set("department_id", params.department_id);
  if (params.overload_allowance_units != null)
    sp.set("overload_allowance_units", String(params.overload_allowance_units));
  if (params.history_terms_for_experience != null)
    sp.set("history_terms_for_experience", String(params.history_terms_for_experience));
  if (params.include_only_with_preferences != null)
    sp.set("include_only_with_preferences", String(params.include_only_with_preferences));
  if (params.allow_fallback_without_sections != null)
    sp.set("allow_fallback_without_sections", String(params.allow_fallback_without_sections));

  const url = `${base}/pt-risk?${sp.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/* =========================================================
   ===============  Load Recommendation ===================
   ========================================================= */
export type FacultyProfile = {
  _id?: string;
  faculty_id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  department_id?: string;
  [k: string]: any;
};

// Communicated with OM_LoadReco.tsx & analytics reco
export async function getOneFacultyProfile(): Promise<FacultyProfile> {
  // Resolve under current BASE (handles /staging/ automatically)
  const url = join(BASE, "/analytics/om/loadreco");
  const { data } = await axios.get(url);
  return data;
}

export type Status = "" | "Confirmed" | "Pending" | "Unassigned" | "Conflict";

export type Row = {
  id: string;
  course: string;
  title: string;
  units: number | "";
  section: string;
  faculty: string;
  day1: string; begin1: string; end1: string; room1: string;
  day2: string; begin2: string; end2: string; room2: string;
  capacity: number | "";
  status: Status;
  conflictNote?: string;
  editable?: boolean;
};


export type LoadAssignmentResponse = {
  term: string;
  rows: Row[];
};

// // Automatically generate load recommendations (auto-assign)
// export async function runOmAutoAssign({ user_id, department_id }: {user_id: string; department_id?: string}) {
//   const base = (typeof API_BASE !== "undefined" ? API_BASE : "").replace(/\/+$/,"");
//   const url = `${base}/om/load-assignment/run?user_id=${encodeURIComponent(user_id)}${department_id ? `&department_id=${encodeURIComponent(department_id)}` : ""}`;
//   const r = await fetch(url, { method: "POST" });
//   if (!r.ok) throw new Error(await r.text());
//   return r.json() as Promise<{ term: string; rows: Row[] }>;
// }

/* =========================================================
   ===============  ADMIN: MANAGEMENT  =====================
   ========================================================= */

export type AdminUserRow = {
  id: number;
  fullName: string;
  email: string;
  status: "Active" | "Inactive";
  role: string;
  department: string;
  joinedDate: string;
};

export type AdminLogRow = {
  id: number;
  user: string;
  action: string;
  details: string;
  timestamp: string;
};

export type AdminOptions = {
  ok: boolean;
  roles: string[];
  departments: string[];
};

export type AdminProfile = {
  ok: boolean;
  first_name: string;
  last_name: string;
};

/**
 * Fetch all admin users (with resolved roles and departments)
 */
export async function getAdminUsersList(userId: string) {
  const { data } = await axios.post(
    `${API_BASE}/admin/manage`,
    {},
    { params: { userId, action: "fetch" } }
  );
  return (data?.users ?? []) as AdminUserRow[];
}

/**
 * Retrieve audit logs for Admin → Logs table.
 */
export async function getAdminLogs(userId: string) {
  const { data } = await axios.post(
    `${API_BASE}/admin/manage`,
    {},
    { params: { userId, action: "logs" } }
  );
  return (data?.logs ?? []) as AdminLogRow[];
}

/**
 * Get dropdown options for roles and departments.
 */
export async function getAdminOptions(userId: string) {
  const { data } = await axios.post(
    `${API_BASE}/admin/manage`,
    {},
    { params: { userId, action: "options" } }
  );
  return data as AdminOptions;
}

/**
 * Fetch minimal admin profile (for greetings or headers).
 */
export async function getAdminProfile(userId: string) {
  const { data } = await axios.post(
    `${API_BASE}/admin/manage`,
    {},
    { params: { userId, action: "profile" } }
  );
  return data as AdminProfile;
}

/**
 * Submit new admin user entry.
 * Mirrors backend validation and structure.
 */
export async function submitAdminUser(
  userId: string,
  payload: {
    lastName: string;
    firstName: string;
    middleInitial?: string; // display-only; ignored by backend
    email: string;
    status: "Active" | "Inactive";
    role?: string;
    department?: string; // e.g. "ST" for Science & Tech
  }
) {
  const { data } = await axios.post(
    `${API_BASE}/admin/manage`,
    payload,
    { params: { userId, action: "submit" } }
  );
  return data as { ok: boolean; user: AdminUserRow };
}

/* =========================================================
   ===============  APO: PRE-ENLISTMENT  ===================
   ========================================================= */
export type PreenlistmentCountDoc = {
  count_id: string;
  term_id: string;
  college_id?: string;
  campus_id?: string;
  course_id?: string;
  preenlistment_code?: string;
  career: string; // UGB / GSM as provided
  count: number; // ← backend guarantees this from preenlistment_count
  course_code?: string;
  campus_name?: "MANILA" | "LAGUNA";
  college_code?: string;
  term_number?: number;
  acad_year_start?: number;
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
  acad_group?: string; // CSV 'Acad Group' or college_code fallback
};

export type PreenlistmentStatDoc = {
  stat_id: string;
  term_id: string;
  program_id?: string;
  campus_id?: string;
  enrollment?: number;
  freshman: number;
  sophomore: number;
  junior: number;
  senior: number;
  term_number?: number;
  acad_year_start?: number;
  program_code?: string;
  programs?: { program_code?: string };
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type TermMeta = {
  term_id: string;
  ay_label: string;
  term_number?: number;
  acad_year_start?: number;
  is_current?: boolean;
  campus_label?: string;
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
  Career: string; // UGB / GSM
  "Acad Group": string; // CCS (display)
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
  ENROLLMENT?: number | string;
};

export type ArchiveMetaItem = {
  term_number?: number;
  term_id: string;
  ay_label: string;
  courses?: number;
  programs?: number;
};

export type ArchivesMetaResponse = {
archives: ArchiveMetaItem[];

  // NEW – matches what the backend sends & what your UI reads
  planningTerm?: TermMeta | null;
  activeTerm?: TermMeta | null;
};
export function campusFromRoles(roles: string[] = []): "MANILA" | "LAGUNA" | null {
  const r = roles.map((s) => s.toLowerCase());
  if (r.some((x) => x.includes("apo") && x.includes("manila"))) return "MANILA";
  if (r.some((x) => x.includes("apo") && x.includes("laguna"))) return "LAGUNA";
  return null;
}

export async function getApoPreenlistment(
  userId: string,
  termId?: string,
  scope: "active" | "archive" | "archivesMeta" = "active",
  campusName?: "MANILA" | "LAGUNA"
): Promise<ApoPreenlistmentResponse> {
  const params = new URLSearchParams({ userId, scope });
  if (termId) params.set("termId", termId);
  if (campusName) params.set("campus", campusName);
  const url = join(API_BASE, `apo/preenlistment?${params.toString()}`);
  const { data } = await axios.get(url);
  return data;
}

export async function getApoPreenlistmentMeta(
  userId: string,
  campusName?: "MANILA" | "LAGUNA"
): Promise<ArchivesMetaResponse> {
  const params = new URLSearchParams({ userId, scope: "archivesMeta" });
  if (campusName) params.set("campus", campusName);
  const url = join(API_BASE, `apo/preenlistment?${params.toString()}`);
  const { data } = await axios.get(url);
  return data;
}

export async function importApoPreenlistment(
  userId: string,
  countRows: CountCsvRow[],
  statRows: StatCsvRow[],
  termId?: string,
  opts?: { replaceCount?: boolean; replaceStats?: boolean },
  campusName?: "MANILA" | "LAGUNA"
) {
  const qs = new URLSearchParams({
    userId,
    action: "import",
    replaceCount: String(!!opts?.replaceCount),
    replaceStats: String(!!opts?.replaceStats),
  });
  if (termId) qs.set("termId", termId);
  if (campusName) qs.set("campus", campusName);
  const url = join(API_BASE, `apo/preenlistment?${qs.toString()}`);
  const { data } = await axios.post(url, { countRows, statRows });
  return data;
}

export async function archiveApoPreenlistment(
  userId: string,
  termId?: string,
  campusName?: "MANILA" | "LAGUNA"
) {
  const qs = new URLSearchParams({ userId, action: "archive" });
  if (termId) qs.set("termId", termId);

  // campus is still sent for role/scope resolution, but backend archives BOTH campuses
  if (campusName) qs.set("campus", campusName);

  const url = join(API_BASE, `apo/preenlistment?${qs.toString()}`);
  const { data } = await axios.post(url);
  return data;
}
export async function reactivateApoPreenlistment(
  userId: string,
  termId: string,
  campusName?: "MANILA" | "LAGUNA"
) {
  const qs = new URLSearchParams({ userId, action: "reactivate", termId });
  if (campusName) qs.set("campus", campusName);
  const url = join(API_BASE, `apo/preenlistment?${qs.toString()}`);
  const { data } = await axios.post(url);
  return data;
}

/* =========================================================
   ===============  APO: COURSE OFFERINGS  =================
   ========================================================= */

// --- Electives result typing (global pool comes from backend) ---
export type SpecificElective = {
  course_id: string;
  course_code: string | string[];
  course_title: string;
};

export type ApoOfferingsResponse = {
  rows: any[];
  course_options_by_group?: Record<string, any[]>;
  all_specific_electives?: SpecificElective[]; // backend may omit; we’ll default it
  [k: string]: any;
};

export type SlotPayload = {
  room_id?: string | null;
  day?: string; // "Monday" .. "Saturday"
  start_time?: string; // "HHMM" or "HH:MM" (we normalize to HHMM when posting)
  end_time?: string; // "HHMM" or "HH:MM"
};

export type EditRowPayload = {
  section_id: string;
  course_id?: string;

  section_code?: string;
  enrollment_cap?: number | null | "";
  remarks?: string;

  // for quick inline assignment updates
  faculty_name?: string;

  slot1?: SlotPayload;
  slot2?: SlotPayload;

  update_course?: { course_code?: string; course_title?: string };

  // Electives handling (placeholder -> specific course)
  for_placeholder_course_id?: string;
  specific_course_id?: string;

  faculty_user_id?: string | null;
  faculty_id?: string | null;

  override?: boolean;
  override_token?: string;
  override_reason?: string;
  auto_override?: boolean;
};

export type AddRowPayload = {
  batch_id: string;
  program_id: string;

  // one of these paths will be used:
  course_id?: string;                       // normal (non-elective) OR placeholder w/o resolving
  for_placeholder_course_id?: string;       // elective: placeholder (e.g. ITELEC1)
  specific_course_id?: string;              // elective: chosen specific (e.g. ISDESTH)

  section_code?: string;
  enrollment_cap?: number | "";
  remarks?: string;

  // optional inline schedule + faculty (unchanged)
  slot1?: SlotPayload;
  slot2?: SlotPayload;
  faculty_user_id?: string | null;
  faculty_id?: string | null;
  faculty_name?: string;

  // GE/relaxed rules
  auto_override?: boolean;                  // <-- ADD THIS

  // overrides (unchanged)
  override?: boolean;
  override_token?: string;
  override_reason?: string;
};

/* ------------------------ qs helper ------------------------ */
function q(obj: Record<string, any>) {
  const params = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return params ? `?${params}` : "";
}

/* --------------------- low-level HTTP ---------------------- */
async function get<T>(url: string): Promise<T> {
  const { data } = await axios.get<T>(url);
  return data;
}
async function post<T>(url: string, body?: any): Promise<T> {
  const { data } = await axios.post<T>(url, body);
  return data;
}

/* ------------------ small utils / coercers ----------------- */
function _clone<T>(x: T): T {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

function _normTime(t?: any): string | undefined {
  if (t == null) return undefined;
  const s = String(t).trim();
  if (!s) return undefined;
  if (/^\d{4}$/.test(s)) return s;
  // accept "HH:MM" or "H:MM"
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hh = m[1].padStart(2, "0");
    const mm = m[2];
    return `${hh}${mm}`;
  }
  // fallback: strip non-digits and pad if it looks like time
  const digits = s.replace(/\D+/g, "");
  if (digits.length === 3) return `0${digits}`; // "730" -> "0730"
  if (digits.length === 4) return digits;
  return undefined;
}

/** Normalize room sentinel values and number-ish fields before POSTing. Also normalize slot times. */
function _coerceOnline<T extends Record<string, any>>(payload: T): T {
  const out = _clone(payload);
  const o = out as unknown as Record<string, any>; // ← use this for writes

  // Normalize slots
  const slots = ["slot1", "slot2"] as const;
  for (const key of slots) {
    if (o[key]) {
      const slot: Record<string, any> = { ...o[key] };

      // Normalize room: "" -> null (explicit clear)
      if (Object.prototype.hasOwnProperty.call(slot, "room_id")) {
        slot.room_id = slot.room_id === "" ? null : slot.room_id;
      }

      // Normalize times to HHMM (delete if invalid)
      if (Object.prototype.hasOwnProperty.call(slot, "start_time")) {
        const n = _normTime(slot.start_time);
        if (n != null) slot.start_time = n;
        else delete slot.start_time;
      }
      if (Object.prototype.hasOwnProperty.call(slot, "end_time")) {
        const n = _normTime(slot.end_time);
        if (n != null) slot.end_time = n;
        else delete slot.end_time;
      }

      // NEW: drop purely-empty placeholders (only { room_id: null })
      if (Object.keys(slot).length === 1 && "room_id" in slot && slot.room_id === null) {
        delete o[key];
        continue;
      }

      const hasKeys = Object.keys(slot).length > 0;
      if (hasKeys) o[key] = slot;  // write via `o`
      else delete o[key];          // delete via `o`
    }
  }

  // Normalize enrollment_cap (allow "" to mean clear/null)
  if ("enrollment_cap" in o) {
    const cap = o.enrollment_cap;
    if (cap === "" || cap === undefined) {
      o.enrollment_cap = null;
    } else if (typeof cap !== "number") {
      const n = Number(cap);
      o.enrollment_cap = Number.isFinite(n) ? n : null;
    }
  }

  return out; // ← IMPORTANT
}


/** Backward-compat + safe defaults for auto-override */
function _applyAutoOverride<T extends Record<string, any>>(payload: T): T {
  const out = _clone(payload);
  // --- CHANGE #1: provide safe defaults ---
  if ((out as any).auto_override == null) {
    (out as any).auto_override = true;
  }
  if ((out as any).override_reason == null) {
    (out as any).override_reason = "Proceed (UI)";
  }
  // Legacy flag still respected if present
  if ((out as any).auto_approve != null) {
    (out as any).auto_override = (out as any).auto_approve;
  }
  return out;
}
/** If choosing a specific elective, never send course_id alongside it. */
function _sanitizeElectiveIntent<
  T extends { specific_course_id?: string; course_id?: string; for_placeholder_course_id?: string }
>(payload: T): T {
  const out = _clone(payload);
  // Normalize empty strings to undefined
  if ((out as any).specific_course_id === "") delete (out as any).specific_course_id;
  if ((out as any).for_placeholder_course_id === "") delete (out as any).for_placeholder_course_id;

  // Avoid conflicting intent: drop course_id if a specific elective is chosen
  if ((out as any).specific_course_id) {
    delete (out as any).course_id;
  }
  return out;
}

/* ---------------------- shared types ----------------------- */
export type ApiConflict = {
  override_token: string;
  violations: { code: string; level?: string; message: string; data?: any }[];
  preview_changes?: any;
};

type GateError = { code?: "NEEDS_IMPORT" | "APPROVAL_REQUIRED"; message?: string };

export type OfferingsQuery = {
  view?: "offerings" | "curriculum";
  level?: string;
  department_id?: string;
  batch_id?: string;
  program_id?: string;
    /** Which term to use on the backend: 
   *  - "active"   = current term (e.g., TERM0014)
   *  - "planning" = next term used for loading (e.g., TERM0015)
   */
  term_mode?: "active" | "planning";
};
function normalizeLevelForQuery(level?: string) {
  const s = String(level || "").trim().toLowerCase();
  if (!s || s === "all levels") return undefined;
  if (/(^ug\b)|undergrad|undergraduate/.test(s)) return "UG";
  if (/^gs\b|gsm|grad|graduate/.test(s)) return "GS";
  return undefined;
}

/* Robustly unwrap conflict payload whether server nests under detail.conflict or directly under detail */
function _extractConflict(e: AxiosError<any>): ApiConflict | null {
  const root = e.response?.data ?? {};
  const detail = root.detail ?? root; // accept both shapes
  const raw = detail.conflict ?? detail; // conflict may be nested or be the actual object
  const token = raw.override_token ?? detail.override_token ?? root.override_token;
  const violations = raw.violations ?? detail.violations ?? root.violations;
  const preview = raw.preview_changes ?? raw.preview ?? detail.preview_changes ?? root.preview_changes;
  if (!token && !Array.isArray(violations)) return null;
  return {
    override_token: token || "",
    violations: Array.isArray(violations) ? violations : [],
    preview_changes: preview,
  };
}

/* ===================== Course Offerings API ===================== */

export async function getApoCourseOfferings(
  userId: string,
  opts: OfferingsQuery = {}
): Promise<ApoOfferingsResponse> {
  const { level, ...rest } = opts;
  const level_code = normalizeLevelForQuery(level);
  const url = `${API_BASE}/apo/courseofferings${q({ userId, ...rest, level, level_code })}`;

  const data = await get<ApoOfferingsResponse>(url);

  // Safe default + light coercion for course_code (string[] -> first string)
  const list = Array.isArray(data.all_specific_electives) ? data.all_specific_electives : [];
  data.all_specific_electives = list.map((e) => ({
    ...e,
    course_code: Array.isArray(e.course_code) ? (e.course_code[0] ?? "") : (e.course_code ?? ""),
  }));

  return data;
}
export function electivesToOptions(resp?: ApoOfferingsResponse) {
  const arr = resp?.all_specific_electives ?? [];
  return arr.map((e) => ({
    value: e.course_id,
    label: `${e.course_code} — ${e.course_title}`,
  }));
}
/** Add row (capacity defaults server-side to courses.max_enrollee if not provided). */
export async function addApoOfferingRow(
  userId: string,
  payload: AddRowPayload
): Promise<{ ok: true; section_id: string } | { conflict: ApiConflict }> {
  const url = `${API_BASE}/apo/courseofferings${q({ userId, action: "addRow" })}`;

  // NEW: make elective intent unambiguous before coercion/override defaults
  const sanitized = _sanitizeElectiveIntent(payload);

  const body = _coerceOnline(_applyAutoOverride(sanitized));
  try {
    return await post<{ ok: true; section_id: string }>(url, body);
  } catch (e) {
    // (keep the rest of your conflict handling exactly as-is)
    const err = e as AxiosError<any>;
    if (err.response?.status === 409) {
      const conflict = _extractConflict(err);
      if (conflict && (body as any).auto_override) {
        try {
          return await post<{ ok: true; section_id: string }>(url, {
            ...(body as any),
            override: true,
            override_token: conflict.override_token,
            override_reason: (body as any).override_reason || "Auto-override add",
          });
        } catch (e2) {
          const err2 = e2 as AxiosError<any>;
          if (err2.response?.status === 409) {
            const conflict2 = _extractConflict(err2);
            if (conflict2) return { conflict: conflict2 };
            const d2 = err2.response?.data?.detail as GateError | undefined;
            if (d2) throw new Error(d2.message || "Action blocked by planning rules.");
          }
          throw err2;
        }
      }
      if (conflict) return { conflict };
      const d = err.response?.data?.detail as GateError | undefined;
      if (d) throw new Error(d.message || "Action blocked by planning rules.");
    }
    throw err;
  }
}


/** Edit row (capacity updates will be saved to sections.enrollment_cap). */
export async function editApoOfferingRow(
  userId: string,
  payload: EditRowPayload
): Promise<{ ok: true; section_id: string } | { conflict: ApiConflict }> {
  const url = `${API_BASE}/apo/courseofferings${q({ userId, action: "editRow" })}`;

  // NEW: make elective intent unambiguous before coercion/override defaults
  const sanitized = _sanitizeElectiveIntent(payload);

  const body = _coerceOnline(_applyAutoOverride(sanitized));
  try {
    return await post(url, body);
  } catch (e) {
    // (keep the rest exactly as-is)
    const err = e as AxiosError<any>;
    if (err.response?.status === 409) {
      const conflict = _extractConflict(err);
      if (conflict && (body as any).auto_override) {
        try {
          return await post(url, {
            ...(body as any),
            override: true,
            override_token: conflict.override_token,
            override_reason: (body as any).override_reason || "Proceed with seat-deficit override",
          });
        } catch (e2) {
          const err2 = e2 as AxiosError<any>;
          if (err2.response?.status === 409) {
            const conflict2 = _extractConflict(err2);
            if (conflict2) return { conflict: conflict2 };
            const d2 = err2.response?.data?.detail as GateError | undefined;
            if (d2) throw new Error(d2.message || "Action blocked by planning rules.");
          }
          throw err2;
        }
      }
      if (conflict) return { conflict };
      const d = err.response?.data?.detail as GateError | undefined;
      if (d) throw new Error(d.message || "Action blocked by planning rules.");
    }
    throw err;
  }
}


export type DeleteRowPayload = {
  section_id: string;
  override?: boolean;
  override_token?: string;
  override_reason?: string;
};

export async function deleteApoOfferingRow(
  userId: string,
  payload: DeleteRowPayload
): Promise<{ ok: true; deleted: number } | { conflict: ApiConflict }> {
  try {
    const url = `${API_BASE}/apo/courseofferings${q({ userId, action: "deleteRow" })}`;
    return await post(url, _coerceOnline(payload));
  } catch (e) {
    const err = e as AxiosError<any>;
    if (err.response?.status === 409) {
      const conflict = _extractConflict(err);
      if (conflict) return { conflict };
      const d = err.response?.data?.detail as GateError | undefined;
      if (d) throw new Error(d.message || "Action blocked by planning rules.");
    }
    throw err;
  }
}

/* ---- Plan routing ---- */
export function forwardApoCourseOfferings(
  userId: string,
  payload: {
    to?: string;
    subject?: string;
    message?: string;
    exclude_conflicts?: boolean; // <-- add this
  }
) {
  return axios
    .post(join(API_BASE, `/apo/forward/${userId}`), payload)
    .then(r => r.data);
}


export async function approveApoOfferingsPlan(
  userId: string
): Promise<{ ok: true; applied: number }> {
  const url = `${API_BASE}/apo/courseofferings${q({ userId, action: "approvePlan" })}`;
  return post(url);
}

/* ---- Curriculum ops (used in offerings "Curriculum" view) ---- */
export async function curriculumAddCourse(
  userId: string,
  payload: {
    program_id: string;
    batch_id: string;
    course_id?: string;
    new_course?: {
      course_code: string;
      course_title: string;
      department_id: string;
      /** label or code; backend accepts both */
      program_level: string;
      units?: number;
    };
  }
): Promise<{ ok: true; course_id: string }> {
  const url = `${API_BASE}/apo/courseofferings${q({ userId, action: "curriculumAddCourse" })}`;
  return post(url, payload);
}

export async function curriculumEditCourse(
  userId: string,
  payload: {
    program_id: string;
    batch_id: string;
    old_course_id: string;
    new_course_id?: string;
    update_course?: { course_title?: string; program_level?: string; units?: number | null };
  }
): Promise<{ ok: true; course_id: string }> {
  const url = `${API_BASE}/apo/courseofferings${q({ userId, action: "curriculumEditCourse" })}`;
  return post(url, payload);
}

export async function curriculumRemoveCourse(
  userId: string,
  payload: { program_id: string; batch_id: string; course_id: string }
): Promise<{ ok: true; removed: number }> {
  const url = `${API_BASE}/apo/courseofferings${q({ userId, action: "curriculumRemoveCourse" })}`;
  return post(url, payload);
}

/* ---- Electives helper endpoints (placeholder → specific) ---- */
export async function getElectiveOptions(
  userId: string,
  placeholder_course_id?: string
): Promise<{ ok: boolean; options: Array<{ course_id: string; course_code: string | string[]; course_title: string }> }> {
  const url = `${API_BASE}/apo/courseofferings${q({
    userId,
    action: "electiveOptions",
    placeholder_course_id,
  })}`;
  return get(url);
}

/* ---- Eligible rooms for a section (capacity + room_type guard) ---- */
export type EligibleRoomsParams = {
  section_id?: string;

  /** Preferred: server reads this as a minimum seat requirement */
  min_capacity?: number;
  /** Back-compat from the caller: we’ll map this to min_capacity */
  enrollment_cap?: number;

  /** Preferred: server expects this key */
  required_type?: string;
  /** Back-compat from the caller: we’ll map this to required_type */
  room_type?: string;

  campus_id?: string;

  // time filter for clash checks
  day?: string;
  /** Back-compat from the caller; we’ll emit as `start` */
  start_time?: string;
  /** Back-compat from the caller; we’ll emit as `end` */
  end_time?: string;

  /** IDs to ignore when checking conflicts (CSV or array) */
  exclude_schedule_ids?: string | string[];
};

export async function getEligibleRoomsForOffering(
  userId: string,
  params: EligibleRoomsParams
): Promise<{ ok: boolean; rooms: Array<{ room_id: string; room_number: string; room_type: string; capacity: number; building?: string }> }> {
  const qp: Record<string, any> = { ...params };

  // --- Times: send server's expected keys `start` / `end`
  const s = _normTime(qp.start ?? qp.start_time);
  const e = _normTime(qp.end ?? qp.end_time);
  if (s) qp.start = s;
  if (e) qp.end = e;
  delete qp.start_time;
  delete qp.end_time;

  // --- Capacity/type: accept either naming, send server's expected keys
  qp.required_type = qp.required_type ?? qp.room_type ?? undefined;
  qp.min_capacity = qp.min_capacity ?? qp.enrollment_cap ?? undefined;
  delete qp.room_type;
  delete qp.enrollment_cap;

  // --- Day normalization: accept "TH" or "H" for Thursday; backend is tolerant but we help it.
  const rawDay = String(qp.day || "").toUpperCase().trim();
  qp.day = rawDay === "TH" ? "H" : rawDay; // keep M T W H F S

  // --- Exclusions: ensure comma-separated string
  if (Array.isArray(qp.exclude_schedule_ids)) {
    qp.exclude_schedule_ids = qp.exclude_schedule_ids.join(",");
  }

  const url = `${API_BASE}/apo/courseofferings${q({
    userId,
    action: "eligibleRooms",
    campus_id: qp.campus_id,
    day: qp.day,
    start: qp.start,
    end: qp.end,
    required_type: qp.required_type,
    min_capacity: qp.min_capacity,
    exclude_schedule_ids: qp.exclude_schedule_ids,
  })}`;

  return get(url);
}

export async function searchCourseCatalog(
  userId: string,
  params: { q?: string; limit?: number; department_id?: string; program_level?: string } = {}
) {
  // Use the POST /apo/courseofferings action that the backend wired for searching
  const url = `${API_BASE}/apo/courseofferings${q({
    userId,
    action: "search_catalog",   // <-- match backend action
  })}`;

  // Backend reads filters from JSON body
  const body: any = {};
  if (params.q != null) body.q = params.q;
  if (params.limit != null) body.limit = params.limit;
  if (params.department_id) body.department_id = params.department_id;
  if (params.program_level) body.program_level = params.program_level;

  const data = await post<{
    ok: boolean;
    results: Array<{
      course_id: string;
      course_code: string | string[];
      course_title: string;
      department_id?: string;
      program_level?: string;
      units?: number | null;
      type_of_course?: string | null;
    }>;
  }>(url, body);

  return data;
}

export async function createCatalogCourse(userId: string, payload: CreateCoursePayload) {
  const url = join(API_BASE, "apo/courseofferings"); // same base/path family as catalog.search
  const { data } = await axios.post(
    `${url}?userId=${encodeURIComponent(userId)}&action=catalog.create`,
    payload
  );
  return data; // { ok: true, course: {...} }
}
export async function editCatalogCourse(
  userId: string,
  payload: EditCoursePayload
): Promise<{ ok: boolean; course_id: string }> {
  const { course_id, course_code, course_title, units } = payload;

  // Build the shape expected by backend's `curriculumEditCourse` global-update path:
  // { old_course_id, update_course: { ... } }
  const body: any = {
    old_course_id: course_id,
    update_course: {},
  };

  if (Array.isArray(course_code)) {
    body.update_course.course_code = course_code;
  }
  if (typeof course_title === "string") {
    body.update_course.course_title = course_title;
  }
  if (units !== undefined) {
    body.update_course.units = units;
  }

  const url = `${API_BASE}/apo/courseofferings${q({
    userId,
    action: "curriculumEditCourse",   // <-- reuse existing backend action
  })}`;

  return post<{ ok: true; course_id: string }>(url, body);
}

// --- Types ---
export type CreateCoursePayload = {
  department_id: string;
  program_level: "UGS" | "GS";           // UGS = Undergraduate, GS = Graduate Studies
  course_code: string;
  course_title: string;
  units?: number | null;
  type_of_course?: string | null;        // e.g., "Elective Course", "GE", "Major"
  description?: string;
  room_type?: string | null;             // e.g., "Classroom", "Comlab"
  capacity?: number | null;              // max_enrollee
  min_enrollee?: number | null;
};
export type EditCoursePayload = {
  course_id: string;
  course_code?: string[];     // stored as array in DB
  course_title?: string;
  units?: number | null;
};
export type CourseCatalogItem = {
  course_id: string;
  course_code: string | string[];
  course_title: string;
  department_id?: string;
  program_level?: string;                // "UGS" | "GS" | human label
  units?: number | null;
  type_of_course?: string | null;
};
// type near your other APO types (optional helper)
export interface CurriculumCsvRow {
  batch_code: string;
  program_level: string;
  program_code: string;
  term_number: number;
  acad_year_start: number;
  campus_name: string;
  course_codes: string[];
}

export interface ImportCurriculumCsvPayload {
  rows: any[];
  term_id: string;
  campus_name: string;
}

export interface ImportCurriculumCsvResponse {
  ok: boolean;
  imported?: number;
  created_batches?: string[];
  curricula?: { batch_id: string; curriculum_id: string; course_count: number }[];
  errors?: any[]; // backend may also send row-level errors
}

export async function importCurriculumCsv(
  userId: string,
  payload: ImportCurriculumCsvPayload
): Promise<ImportCurriculumCsvResponse> {
  const res = await fetch(
    `/api/apo/courseofferings?userId=${encodeURIComponent(
      userId
    )}&action=import_curriculum_csv`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      text || `CSV import failed with status ${res.status} ${res.statusText}`
    );
  }

  return (await res.json()) as ImportCurriculumCsvResponse;
}

/* =========================================================
   ===============  APO: ROOM ALLOCATION  ==================
   ========================================================= */
export type Day = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";
export type RoomType = "Classroom" | "ComLab";

export type RoomDoc = {
  room_id: string;
  room_number: string;
  room_type: RoomType | string;
  capacity: number;
  building: string;
  campus_id: string;
  status: string;
};
export type SectionDoc = {
  section_id: string;
  section_code: string;
  course_id?: string;
  course_code?: string;
};
export type SectionScheduleDoc = {
  schedule_id: string;
  section_id: string;
  day: Day;
  start_time: string;
  end_time: string;
  room_id?: string | null;
  time_band: string;
};
export type RoomScheduleCell = {
  schedule_id?: string;
  section_id?: string | null;
  day: Day;
  time_band: string;
  allowed?: boolean;
  // section_ids that pass room_type + capacity checks for this cell
  eligible_section_ids?: string[];
};

export type RoomWithSchedule = RoomDoc & { schedule: RoomScheduleCell[] };

export type RoomAllocationResponse = {
  campus: { campus_id: string; campus_name: string };
  term_id: string;
  term_number?: number;
  acad_year_start?: number;
  buildings: string[];
  timeBands: string[];
  rooms: RoomWithSchedule[];
  sections: SectionDoc[];
  sectionSchedules: SectionScheduleDoc[];
  facultyBySection: Record<
    string,
    { faculty_id: string; user_id: string; faculty_name: string }
  >;
  courses?: { course_id: string; course_code: string[] | string }[];
};

const base = API_BASE.replace(/\/$/, "");

export async function getApoRoomAllocation(
  userId: string,
  termId?: string
): Promise<RoomAllocationResponse> {
  const params = new URLSearchParams({ userId });

  // IMPORTANT: send the planning term so backend uses it
  if (termId) {
    // backend query param name is exactly "termId"
    params.set("termId", termId);
  }

  const r = await fetch(`${base}/apo/roomallocation?${params.toString()}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function addRoom(
  userId: string,
  data: { building: string; room_number: string; room_type: RoomType; capacity: number }
) {
  const r = await fetch(
    `${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "addRoom" }).toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function updateRoom(
  userId: string,
  data: { room_id: string; capacity?: number; room_type?: RoomType; status?: string }
) {
  const r = await fetch(
    `${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "updateRoom" }).toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function setRoomAvailability(
  userId: string,
  data: { room_id: string; day: Day; time_bands: string[] }
) {
  const r = await fetch(
    `${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "setAvailability" }).toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function assignRoom(
  userId: string,
  data: { room_id: string; section_id: string; day: Day; time_band: string; term_id?: string }
) {
  const r = await fetch(
    `${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "assign" }).toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function unassignRoom(
  userId: string,
  data: { room_id: string; section_id: string; day: Day; time_band: string }
) {
  const r = await fetch(
    `${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "unassign" }).toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function removeRoom(userId: string, payload: { room_id: string }) {
  const r = await fetch(
    `${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "removeRoom" }).toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
  );
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/* =========================================================
   ===============  STUDENT: PETITION  =====================
   ========================================================= */
export type StudentOptions = {
  ok: boolean;
  departments: string[];
  courses: { course_code: string; course_title: string; dept_name: string }[];
  programs: { program_id: string; program_code: string }[];
  reasons: string[];
  statuses: string[];
};

export type PetitionView = {
  petition_id: string;
  user_id: string;
  course_id: string | null;
  course_code: string;
  course_title: string;
  reason: string;
  status: string;
  remarks?: string; // may be empty
  submitted_at: string;
  acad_year_start?: number | string;
  term_number?: number;
  program_code?: string;
};

export type PetitionSubmitPayload = {
  department: string;
  courseCode: string; // ONLY code
  reason: string; // must be one of options.reasons
  studentNumber: string;
  degree: string;
};

export async function getStudentPetitions(
  userId: string
): Promise<{ ok: boolean; petitions: PetitionView[] }> {
  const { data } = await axios.post(`${API_BASE}/student/petition`, {}, {
    params: { userId, action: "fetch" },
  });
  return data;
}

export async function getStudentOptions(userId: string): Promise<StudentOptions> {
  const { data } = await axios.post(`${API_BASE}/student/petition`, {}, {
    params: { userId, action: "options" },
  });
  return data;
}

export async function getStudentProfile(userId: string): Promise<{
  ok: boolean; first_name: string; last_name: string; student_number: string; program_code?: string;
}> {
  const { data } = await axios.post(`${API_BASE}/student/petition`, {}, {
    params: { userId, action: "profile" },
  });
  return data;
}

export async function submitStudentPetition(
  userId: string,
  payload: PetitionSubmitPayload
): Promise<{ ok: boolean; petition: PetitionView }> {
  const { data } = await axios.post(`${API_BASE}/student/petition`, payload, {
    params: { userId, action: "submit" },
  });
  return data;
}

/* =========================================================
   ===============  STUDENT: SPECIAL CLASS  =================
   ========================================================= */


export type SpecialClassOptions = {
  ok: boolean;
  departments: string[];
  courses: { course_code: string; course_title: string; units?: number; dept_name: string }[];
  programs: { program_id: string; program_code: string }[];
  reasons: string[];
  statuses: string[];
};

export type SpecialClassView = {
  special_id: string;
  user_id: string;
  course_id: string | null;

  course_code: string;
  course_title: string;
  department_name?: string;

  // submission info (kept minimal; not shown in status card to avoid clutter)
  student_number?: number | string;
  units_remaining?: number;
  graduating_after_term?: boolean;
  course_units?: number;

  reason: string;
  reason_other?: string;

  status: string;
  remarks?: string;
  submitted_at: string;

  acad_year_start?: number | string;
  term_number?: number;
  program_code?: string;

  // ✅ schedule table fields
  section_id?: string | null;
  section_code?: string;

  faculty_name?: string;

  day1?: string;
  begin1?: string;
  end1?: string;
  room1?: string;

  day2?: string;
  begin2?: string;
  end2?: string;
  room2?: string;

  enrollment_cap?: number;
  enrolled?: number;
  section_remarks?: string;

  schedule_summary?: string;
};

export type SpecialClassSubmitPayload = {
  studentNumber: string;
  degree: string;

  unitsRemaining: number;
  graduatingAfterTerm: boolean;

  courseCode: string;
  units: number;

  reason: string;
  reasonOther?: string;

  department: string;

  agree: boolean;
};

export async function getStudentSpecialClasses(
  userId: string
): Promise<{ ok: boolean; applications: SpecialClassView[] }> {
  const { data } = await axios.post(
    `${API_BASE}/student/specialclass`,
    {},
    { params: { userId, action: "fetch" } }
  );
  return data;
}

export async function getStudentSpecialClassOptions(userId: string): Promise<SpecialClassOptions> {
  const { data } = await axios.post(
    `${API_BASE}/student/specialclass`,
    {},
    { params: { userId, action: "options" } }
  );
  return data;
}

export async function getStudentSpecialClassProfile(
  userId: string
): Promise<{ ok: boolean; first_name: string; last_name: string; student_number: string; program_code?: string }> {
  const { data } = await axios.post(
    `${API_BASE}/student/specialclass`,
    {},
    { params: { userId, action: "profile" } }
  );
  return data;
}

export async function submitStudentSpecialClass(
  userId: string,
  payload: SpecialClassSubmitPayload
): Promise<{ ok: boolean; application: SpecialClassView }> {
  const { data } = await axios.post(`${API_BASE}/student/specialclass`, payload, {
    params: { userId, action: "submit" },
  });
  return data;
}

// =========================================================
// ============  STUDENT: COURSE OFFERINGS  =================
// =========================================================

export type StudentCourseOfferingsOptions = {
  ok: boolean;
  term?: { term_id?: string; acad_year_start?: number | string; term_number?: number | string };
  courses: { course_id?: string; course_code: string; course_title?: string; units?: number }[];
  message?: string;
};

export type CourseOfferingsSearchPayload = {
  courseCode: string;
};

export type CourseOfferingSchedule = {
  day?: string;
  start_time?: string;
  end_time?: string;
  room_number?: string;
  room_type?: string;
};

export type CourseOfferingSection = {
  section_id: string;
  section_code: string;
  enrollment_cap?: number;
  enrolled?: number;
  is_open?: boolean;
  faculty_name?: string; // ✅ MUST BE faculty_name
  remarks?: string;
  schedules: CourseOfferingSchedule[];
};

export type CourseOfferingsSearchResponse = {
  ok: boolean;
  term?: { term_id?: string; acad_year_start?: number | string; term_number?: number | string };
  course?: { course_code: string; course_title?: string; units?: number };
  sections: CourseOfferingSection[];
};

export async function getStudentCourseOfferingsOptions(
  userId: string
): Promise<StudentCourseOfferingsOptions> {
  const { data } = await axios.post(
    `${API_BASE}/student/course-offerings`,
    {},
    { params: { userId, action: "options" } }
  );
  return data;
}

export async function searchStudentCourseOfferings(
  userId: string,
  payload: CourseOfferingsSearchPayload
): Promise<CourseOfferingsSearchResponse> {
  const { data } = await axios.post(
    `${API_BASE}/student/course-offerings`,
    payload,
    { params: { userId, action: "search" } }
  );
  return data;
}

/* =========================================================
   ==============  OM: SHARED HEADER (Topbar)  =============
   ========================================================= */
export type OmHeader = {
  ok: boolean;
  email?: string;
  role_id?: string;
  department_id?: string;
  profileName?: string;
  profileSubtitle?: string; // “Role | Department”
  message?: string;
};

export async function getOmHeader(userEmail?: string, userId?: string): Promise<OmHeader> {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "header", userEmail, userId },
  });
  return data as OmHeader;
}

/* =========================================================
   ==============  OM: FACULTY DIRECTORY  ==================
   ========================================================= */
export type FacultyRow = {
  faculty_id: string;
  name: string;
  email: string;
  department: string;
  position?: string;
  teaching_units: string | number;
  faculty_type: string; // Full-Time | Part-Time
  status: string; // Active | On Leave
};

export type FMOptions = {
  ok: boolean;
  departments: string[];
  facultyTypes: string[];
  academicYears: number[];
  activeTerm?: { term_id: string; term_number: number; acad_year_start: number } | null;
};

// NEW: payload for add / update faculty
export type FacultyUpsertPayload = {
  first_name: string;
  last_name: string;
  email: string;
  department: string;              // department.dept_name
  employment_type: "FT" | "PT";    // faculty_profiles.employment_type
  certifications?: string | string[];
  teaching_years?: number;
};

export async function getFacultyOptions(): Promise<FMOptions> {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "options" },
  });
  return data;
}

export async function listFaculty(params: {
  department?: string;
  facultyType?: string;
  search?: string;
}) {
  const { department, facultyType, search } = params || {};
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "list", department, facultyType, search },
  });
  return data as { ok: boolean; rows: FacultyRow[] };
}

// NEW: create faculty (users → role_assignments → faculty_profiles)
export async function addFacultyEntry(payload: FacultyUpsertPayload) {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, payload, {
    params: { action: "add" },
  });
  return data as { ok: boolean; faculty_id?: string; user_id?: string };
}

// NEW: update faculty basic info
export async function updateFacultyEntry(
  facultyId: string,
  payload: Partial<FacultyUpsertPayload>
) {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, payload, {
    params: { action: "update", facultyId },
  });
  return data as { ok: boolean };
}

/** Profile now returns an array: course_coordinator_of: [{ code, title }] */
export async function getFacultyProfile(facultyId: string) {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "profile", facultyId },
  });
  return data as {
    ok: boolean;
    profile: {
      faculty_id: string;
      name: string;
      email: string;
      department: string;
      faculty_type: string;
      status: string;
      position?: string;
      admin_position?: string;
      course_coordinator_of?: Array<{ code: string; title?: string }>;
      load?: { teaching?: number; admin?: number; research?: number; faculty_units?: number };
    };
  };
}

export async function getFacultySchedule(
  facultyId: string,
  termId?: string
): Promise<{ ok: boolean; term_id: string | null; teaching_load: any[] }> {
  const { data } = await axios.post(
    `${API_BASE}/om/facultymanagement`,
    {},
    { params: { action: "schedule", facultyId, termId } }
  );
  // Normalize to always provide teaching_load array
  const tl = Array.isArray(data?.teaching_load) ? data.teaching_load : [];
  return { ok: !!data?.ok, term_id: data?.term_id ?? null, teaching_load: tl };
}

export async function getFacultyHistory(
  facultyId: string,
  termOrAy?: string | number
): Promise<{ ok: boolean; term_id: string | null; teaching_history: Array<{
  code: string;
  title: string;
  section: string;
  mode?: string | null;
  day1?: string | null;
  room1?: string | null;
  day2?: string | null;
  room2?: string | null;
  time?: string | null;
  term?: string | null;
}> }> {
  const params: Record<string, any> = { action: "history", facultyId };
  if (typeof termOrAy === "number") params.acadYearStart = termOrAy; // AY start (e.g., 2024)
  else if (typeof termOrAy === "string" && termOrAy) params.termId = termOrAy;

  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, { params });

  // Normalize backend response ({ terms: Record<string, any[]> }) to teaching_history[]
  const teaching_history: Array<any> = [];
  const termsObj = data?.terms || {};
  Object.entries(termsObj).forEach(([termKey, list]) => {
    const termMatch = /Term\s*([123])/i.exec(termKey);
    const termLabel = termMatch ? `Term ${termMatch[1]}` : termKey.includes("Term") ? termKey : "Term 1";
    (list as any[]).forEach((r) => {
      teaching_history.push({
        code: r.code ?? r.course_code ?? "",
        title: r.title ?? r.course_title ?? "",
        section: r.section ?? r.section_code ?? "",
        mode: r.mode ?? "",
        day1: r.day1 ?? "",
        room1: r.room1 ?? "",
        day2: r.day2 ?? "",
        room2: r.room2 ?? "",
        time: r.time ?? r.schedule ?? "",
        term: termLabel,
      });
    });
  });

  return {
    ok: !!data?.ok,
    term_id: (data?.term_id ?? null) as string | null,
    teaching_history,
  };
}

/* =========================================================
   ==============  OM: COURSE MANAGEMENT  =================
   ========================================================= */

export type CMCourseRow = {
  course_id: string;
  kac: string; // derived from kacs.course_list
  code: string; // joined course_code(s)
  title: string;
  units: number | string;
  coordinator_name: string; // back-compat (joined string)
  coordinator_email: string; // back-compat (first email)
  coordinators?: { name: string; email?: string }[]; // full list
  composition: string[]; // from sections -> assignments -> profiles -> users (active term)
  syllabus: string;
};

export type CMOptions = {
  ok: boolean;
  clusters: string[];
  activeTerm?: { term_id: string; acad_year_start?: number; term_number?: number };
};

export async function getCMOptions(userEmail?: string, userId?: string): Promise<CMOptions> {
  const { data } = await axios.post(`${API_BASE}/om/course-management`, {}, {
    params: { action: "options", userEmail, userId },
  });
  return data as CMOptions;
}

export async function listCMCourses(params: {
  userEmail?: string;
  userId?: string;
  cluster?: string;
  search?: string;
}) {
  const { userEmail, userId, cluster, search } = params || {};
  const { data } = await axios.post(`${API_BASE}/om/course-management`, {}, {
    params: { action: "list", userEmail, userId, cluster, search },
  });
  return data as { ok: boolean; rows: CMCourseRow[]; term?: any };
}

export async function getCMHeader(userEmail?: string, userId?: string) {
  const { data } = await axios.post(`${API_BASE}/om/course-management`, {}, {
    params: { action: "header", userEmail, userId },
  });
  return data as { ok: boolean; profileName?: string; profileSubtitle?: string };
}

// === CHAIR: COURSE MANAGEMENT (mirrors OM) ===
export async function getChairCMOptions(userEmail?: string, userId?: string): Promise<CMOptions> {
  const { data } = await axios.post(`${API_BASE}/chair/course-management`, {}, {
    params: { action: "options", userEmail, userId },
  });
  return data as CMOptions;
}

export async function listChairCMCourses(params: {
  userEmail?: string; userId?: string; cluster?: string; search?: string;
}) {
  const { userEmail, userId, cluster, search } = params || {};
  const { data } = await axios.post(`${API_BASE}/chair/course-management`, {}, {
    params: { action: "list", userEmail, userId, cluster, search },
  });
  return data as { ok: boolean; rows: CMCourseRow[]; term?: any };
}

export async function getChairCMHeader(userEmail?: string, userId?: string) {
  const { data } = await axios.post(`${API_BASE}/chair/course-management`, {}, {
    params: { action: "header", userEmail, userId },
  });
  return data as { ok: boolean; profileName?: string; profileSubtitle?: string };
}


/* =========================================================
   ==============  OM: FACULTY FORM  ===================
   ========================================================= */
export type OMFOptions = {
  ok: boolean;
  departments: string[];
  facultyTypes: string[];
  activeTerm: {
    term_id?: string;
    acad_year_start?: number;
    term_number?: number;
    label?: string;
    submission_deadline?: string; // ISO
  };
  // NEW: drives the countdown banner (same shape as backend payload)
  prefs_window?: {
    openISO?: string;
    deadlineISO?: string;
    term_id?: string;
  };
};


export type OMFRow = {
  faculty_id: string;
  name: string;
  email: string;
  department: string;
  type: string; // Full-Time | Part-Time
  submission_date?: string; // ISO (undefined => N/A)
  status: string; // Submitted | Not Submitted
};

export async function getOMFOptions(): Promise<OMFOptions> {
  const { data } = await axios.post(`${API_BASE}/om/facultyforms`, {}, { params: { action: "options" } });
  return data;
}

export async function listOMFFaculty(params: {
  department?: string;
  facultyType?: string;
  status?: string;
  search?: string;
  termId?: string;
}) {
  const { department, facultyType, status, search, termId } = params || {};
  const { data } = await axios.post(`${API_BASE}/om/facultyforms`, {}, {
    params: { action: "list", department, facultyType, status, search, termId },
  });
  return data as { ok: boolean; rows: OMFRow[] };
}

export async function getOMFPreference(facultyId: string, termId?: string) {
  const { data } = await axios.post(`${API_BASE}/om/facultyforms`, {}, {
    params: { action: "view", facultyId, termId },
  });
  return data as {
    ok: boolean;
    preference: {
      faculty_id: string;
      name: string;
      email: string;
      teaching?: { preferred_units?: number; deloading?: any };
      location_mode?: { mode?: any };
      schedule?: { days?: string[]; times?: string[] };
      specialization?: { courses?: string[] };
      submission?: { status?: string; date?: string; notes?: string };
    };
  };
}

export async function startOMFWindow(args: { termId?: string; durationDays?: number } = {}) {
  const params: any = { action: "startWindow" };
  if (args.termId) params.termId = args.termId;
  if (args.durationDays != null) params.durationDays = args.durationDays;

  const { data } = await axios.post(`${API_BASE}/om/facultyforms`, {}, { params });
  return data as {
    ok: boolean;
    prefs_window?: { openISO?: string; deadlineISO?: string; term_id?: string };
  };
}

/* =========================================================
   ==============  OM: STUDENT PETITION  ===================
   ========================================================= */
export type OMPetitionRow = {
  course_id: string;
  course_code: string;
  course_title: string;
  count: number;
  status: string;
  remarks?: string;
};

export type OMPetitionOptions = {
  ok: boolean;
  statuses: string[];
  activeTerm: { term_id: string; acad_year_start?: number; term_number?: number };
};

export async function getOMSPOptions() {
  const { data } = await axios.post(`${API_BASE}/om/student-petition`, {}, {
    params: { action: "options" },
  });
  return data as OMPetitionOptions;
}

export async function listOMSP(params: { status?: string; search?: string }) {
  const { status = "", search = "" } = params || {};
  const { data } = await axios.post(`${API_BASE}/om/student-petition`, {}, {
    params: { action: "list", status, search },
  });
  return data as { ok: boolean; rows: OMPetitionRow[]; term_id: string };
}

export async function updateOMSPCourse(course_id: string, payload: { status?: string; remarks?: string }) {
  const { data } = await axios.post(`${API_BASE}/om/student-petition`, payload, {
    params: { action: "update", courseId: course_id },
  });
  return data as { ok: boolean; matched: number; modified: number };
}
/* =========================================================
   ==============  OM: SPECIAL CLASS  ======================
   ========================================================= */

export type OMSCFaultyOpt = {
  faculty_id: string;
  faculty_name: string;
  department_id?: string;
};

export type DayCode = "M" | "T" | "W" | "H" | "F" | "S";

export type OMSCSchedulePreset = {
  schedule_id: string; // section_id-based (stable)
  section_id: string;
  section_code?: string;

  label: string; // e.g. "M 0730-0900; W 0900-1200"
  faculty_id?: string | null;
  faculty_name?: string;

  day1: DayCode | "";
  begin1: string;
  end1: string;
  day2: DayCode | "";
  begin2: string;
  end2: string;
};

export type OMSpecialClassRow = {
  special_id: string;
  term_id: string;
  user_id: string;

  student_name?: string;
  student_number?: number | string;

  course_id: string;
  course_code?: string;
  course_title?: string;
  course_department?: string;

  program_id?: string;
  program_code?: string;

  reason?: string;
  reason_other?: string;

  status?: string;
  remarks?: string;

  faculty_id?: string | null;
  faculty_name?: string;

  section_id?: string | null;

  section_code?: string;

  day1?: DayCode | "";
  begin1?: string;
  end1?: string;
  day2?: DayCode | "";
  begin2?: string;
  end2?: string;

  submitted_at?: string;
};

export type OMSpecialClassDetail = OMSpecialClassRow & {
  department_id?: string;
  department_name?: string;

  course_units?: number | string;
  units_remaining?: number | string;
  graduating_after_term?: boolean;

  schedule_text?: string;
  schedule_entries?: Array<{ day: string; start_time: string; end_time: string }>;

  updated_at?: string;
};

export type OMSpecialClassOptions = {
  ok: boolean;
  statuses: string[];
  activeTerm?: { term_id: string; term_number: number; acad_year_start: number } | null;
  facultyOptions?: OMSCFaultyOpt[];
};

// ---------- OM: Special Class endpoints ----------
export async function getOMSC_Options(): Promise<OMSpecialClassOptions> {
  const { data } = await api.get(`/om/specialclass`, {
    params: { action: "options" },
  });
  return data as OMSpecialClassOptions;
}

export async function listOMSC(params: {
  termId?: string;
  status?: string;
  q?: string;
}): Promise<{ ok: boolean; rows: OMSpecialClassRow[]; term_id?: string }> {
  const { data } = await api.post(`/om/specialclass`, null, {
    params: { action: "list", ...params },
  });
  return data as { ok: boolean; rows: OMSpecialClassRow[]; term_id?: string };
}

export async function getOMSC_SchedulePresets(
  course_id: string,
  term_id?: string
): Promise<{ ok: boolean; presets: OMSCSchedulePreset[] }> {
  const { data } = await api.get(`/om/specialclass`, {
    params: { action: "schedulePresets", course_id, term_id },
  });
  return data as { ok: boolean; presets: OMSCSchedulePreset[] };
}

export async function updateOMSC(
  special_id: string,
  payload: Partial<OMSpecialClassRow>
): Promise<{ ok: boolean; matched: number; modified: number }> {
  const { data } = await api.post(`/om/specialclass`, payload, {
    params: { action: "update", specialId: special_id },
  });
  return data as { ok: boolean; matched: number; modified: number };
}

export async function getOMSC_Detail(
  special_id: string,
  termId?: string
): Promise<{ ok: boolean; row: OMSpecialClassDetail }> {
  const { data } = await api.post(`/om/specialclass`, null, {
    params: { action: "detail", specialId: special_id, ...(termId ? { termId } : {}) },
  });
  return data as { ok: boolean; row: OMSpecialClassDetail };
}

/** If backend returns JSON error while we requested binary, decode it nicely */
async function tryDecodePdfError(err: any): Promise<string | null> {
  try {
    const ab: ArrayBuffer | undefined = err?.response?.data;
    if (!ab || !(ab instanceof ArrayBuffer)) return null;
    const text = new TextDecoder().decode(new Uint8Array(ab));
    // maybe JSON: {"detail":"..."}
    const j = JSON.parse(text);
    return j?.detail ? String(j.detail) : text;
  } catch {
    return null;
  }
}

/**
 * ✅ Export Special Class PDF
 * Backend: POST /om/specialclass?action=exportPdf
 *
 * Supports:
 * - Query params: { termId?, status?, q?, specialId? } for filtered/single export
 * - Body payload: { special_ids: string[] } for exporting selected rows
 *
 * Returns: PDF Blob
 */
export async function exportOMSC_Pdf(args: {
  termId?: string;
  status?: string;
  q?: string;
  specialId?: string;
  special_ids?: string[];
}): Promise<Blob> {
  const { special_ids, ...queryParams } = args || {};

  try {
    const res = await api.post(
      `/om/specialclass`,
      special_ids && special_ids.length > 0 ? { special_ids } : null,
      {
        params: { action: "exportPdf", ...queryParams },
        responseType: "arraybuffer", // ✅ important for readable errors
        headers: { Accept: "application/pdf" },
      }
    );

    return new Blob([res.data], { type: "application/pdf" });
  } catch (err: any) {
    const decoded = await tryDecodePdfError(err);
    if (decoded) {
      // attach a nicer message
      err.message = decoded;
    }
    throw err;
  }
}

/** ✅ Helper: trigger browser download */
export function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}


/* =========================================================
   ==============  OM: CLASS RETENTION  ====================
   ========================================================= */

export type OMCRRow = {
  retention_id: string;
  term_id: string;
  course_id: string;
  section_id: string;
  // derived/display
  faculty_id?: string | null;     // derived from faculty_assignments
  student_units?: number | null;
  faculty_units?: number | null;
  status?: string;
  term_label?: string;
  course_code?: string;
  course_title?: string;
  section_code?: string;
  enrolled?: number | null;
  faculty_name?: string;          // LASTNAME, FIRSTNAME (ALL CAPS) or UNASSIGNED
};

export type OMCROptions = {
  ok: boolean;
  statuses: string[];
  activeTerm?: { term_id: string; term_number: number; acad_year_start: number } | null;
  activeTermLabel?: string;
};

export type OMCRCourseOpt = { course_id: string; course_code: string; course_title: string };
export type OMCRSectionOpt = {
  section_id: string;
  section_code: string;
  enrolled?: number | null;
  faculty_id?: string | null;
  faculty_name?: string;          // LASTNAME, FIRSTNAME or UNASSIGNED
};

// ---------- OM: Class Retention endpoints ----------
export async function getOMCR_Options(): Promise<OMCROptions> {
  const { data } = await api.get(`/om/classretention`, {
    params: { action: "options" },
  });
  return data as OMCROptions;
}

export async function listOMCR(params: {
  term_id?: string;
  status?: string;
  q?: string;
}): Promise<{ ok: boolean; rows: OMCRRow[] }> {
  const { data } = await api.get(`/om/classretention`, {
    params: { action: "list", ...params },
  });
  return data as { ok: boolean; rows: OMCRRow[] };
}

export async function getOMCR_CourseOptions(term_id?: string): Promise<{ ok: boolean; options: OMCRCourseOpt[] }> {
  const { data } = await api.get(`/om/classretention`, {
    params: { action: "courseOptions", term_id },
  });
  return data as { ok: boolean; options: OMCRCourseOpt[] };
}

export async function getOMCR_SectionOptions(
  course_id: string,
  term_id?: string
): Promise<{ ok: boolean; options: OMCRSectionOpt[] }> {
  const { data } = await api.get(`/om/classretention`, {
    params: { action: "sectionOptions", course_id, term_id },
  });
  return data as { ok: boolean; options: OMCRSectionOpt[] };
}

export async function saveOMCR(
  payload: Partial<OMCRRow>
): Promise<{ ok: boolean; retention_id: string }> {
  const copy = { ...payload };
  // faculty is auto-derived on backend — do not send
  delete (copy as any).faculty_id;
  const { data } = await api.post(`/om/classretention`, copy, { params: { action: "save" } });
  return data as { ok: boolean; retention_id: string };
}

export async function deleteOMCR(retention_id: string): Promise<{ ok: boolean }> {
  const { data } = await api.post(`/om/classretention`, { retention_id }, { params: { action: "delete" } });
  return data as { ok: boolean };
}

/* =========================================================
   ==============  CHAIR: STUDENT PETITIONS  ===============
   ========================================================= */

export type ChairPetitionRow = {
  course_id: string;
  course_code: string;
  course_title: string;
  count: number;
  status: string;
  remarks?: string;
};

export type ChairPetitionOptions = {
  ok: boolean;
  statuses: string[];
  activeTerm: { term_id: string; acad_year_start?: number; term_number?: number };
};

export async function getChairSPOptions() {
  const { data } = await axios.post(`${API_BASE}/chair/student-petitions`, {}, {
    params: { action: "options" },
  });
  return data as ChairPetitionOptions;
}

export async function listChairSP(params: { status?: string; search?: string; userId?: string } = {}) {
  const { status = "", search = "", userId } = params;
  const { data } = await axios.post(`${API_BASE}/chair/student-petitions`, {}, {
    params: { action: "list", status, search, userId },
  });
  return data as { ok: boolean; rows: ChairPetitionRow[]; term_id: string };
}

export async function updateChairSPCourse(course_id: string, payload: { status?: string; remarks?: string }) {
  const { data } = await axios.post(`${API_BASE}/chair/student-petitions`, payload, {
    params: { action: "update", courseId: course_id },
  });
  return data as { ok: boolean; matched: number; modified: number };
}

export async function bulkForwardChairSP(course_ids: string[], status?: string) {
  const { data } = await axios.post(`${API_BASE}/chair/student-petitions`, { course_ids, status }, {
    params: { action: "bulkForward" },
  });
  return data as { ok: boolean; matched: number; modified: number; status: string };
}


/* =========================================================
   ===============  FACULTY: OVERVIEW  =====================
   ========================================================= */
export async function getFacultyOverviewList(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/overview`, {}, {
    params: { userId, action: "fetch" },
  });
  return data;
}

export async function getFacultyOverviewProfile(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/overview`, {}, {
    params: { userId, action: "profile" },
  });
  return data;
}

export async function getFacultyOverviewOptions(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/overview`, {}, {
    params: { userId, action: "options" },
  });
  return data;
}

// (Deprecated alias; safe to remove later)
export async function getFacultyOverview(userId: string) {
  return getFacultyOverviewList(userId);
}

/* =========================================================
   ===============  FACULTY: HISTORY  ======================
   ========================================================= */
// Mirrors Student Petition API shape (POST + ?action=*)

export type FacultyHistoryRow = {
  // Stored IDs (not all may exist in sample data)
  assignment_id: string;
  faculty_id: string;
  section_id: string;
  term_id?: string;
  course_id?: string;
  room_id?: string | null;

  // Display-ready (joined/derived by backend)
  course_code?: string | string[];
  course_title?: string;
  section_code?: string;
  day_time?: string; // e.g. "M 07:30–09:00; H 07:30–09:00"
  room_label?: string; // "A1101 (Classroom)" or "Online" / "TBA"
  campus_name?: string; // MUST be present even if Online/TBA
  term_label?: string; // e.g. "AY 2024–2025 T1"
  created_at?: string; // for sorting on UI
};

export type FacultyHistoryProfile = {
  faculty_id: string;
  faculty_name?: string;
  department_id?: string;
};

export type FacultyHistoryOptions = {
  statuses?: string[];
};

export async function getFacultyHistoryList(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/history`, {}, {
    params: { userId, action: "fetch" },
  });
  return data as FacultyHistoryRow[];
}

export async function getFacultyHistoryProfile(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/history`, {}, {
    params: { userId, action: "profile" },
  });
  return data as FacultyHistoryProfile;
}

export async function getFacultyHistoryOptions(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/history`, {}, {
    params: { userId, action: "options" },
  });
  return data as FacultyHistoryOptions;
}

// kept for architecture parity; real writes likely not needed here
export async function submitFacultyHistory(userId: string, payload: Record<string, unknown>) {
  const { data } = await axios.post(`${API_BASE}/faculty/history`, payload, {
    params: { userId, action: "submit" },
  });
  return data as FacultyHistoryRow;
}

/* =========================================================
   ============  FACULTY: PREFERENCES  =====================
   ========================================================= */
export async function getFacultyPreferencesList(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/preferences`, {}, {
    params: { userId, action: "fetch" },
  });
  return data;
}
export async function getFacultyPreferencesOptions(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/preferences`, {}, {
    params: { userId, action: "options" },
  });
  return data;
}
export async function getFacultyPreferencesProfile(userId: string) {
  const { data } = await axios.post(`${API_BASE}/faculty/preferences`, {}, {
    params: { userId, action: "profile" },
  });
  return data;
}

export async function submitFacultyPreferences(
  userId: string,
  payload: {
    preferred_units: number;
    availability_days: string[];
    preferred_times: string[];
    preferred_kacs: string[]; // IDs or names; backend normalizes

    // Accept single object (preferred) or legacy array-of-objects.
    mode?:
      | { mode?: string; campus_id?: string | string[] }
      | Array<{ mode?: string; campus_id?: string | string[] }>;

    deloading_data?: { deloading_type?: string; units?: string | number; detail?: string }[];
    preferred_courses?: string[];
    notes?: string;
    has_new_prep?: boolean;
    is_finished?: boolean;
    term_id?: string;

    // Optional extras your page is sending (safe for backend to ignore)
    on_break?: boolean;
    break_reason?: string;
    break_return_date?: string;
    employment_type?: "FT" | "PT";
  }
) {
  const { data } = await axios.post(`${API_BASE}/faculty/preferences`, payload, {
    params: { userId, action: "submit" },
  });
  return data;
}

/* =========================================================
   ==============  OM: LOAD ASSIGNMENT  ====================
   ========================================================= */
export type OmLoadRow = {
  id: string;
  course: string;
  title: string;
  units: number | "";
  section: string;
  faculty: string;
  faculty_id?: string;
  day1: string;
  begin1: string;
  end1: string;
  room1: string;
  day2: string;
  begin2: string;
  end2: string;
  room2: string;
  capacity: number | "";
  mode?: string;
  status?: "" | "Confirmed" | "Pending" | "Unassigned" | "Conflict";
  conflictNote?: string;
  editable?: boolean;
};

// export async function getOmLoadAssignmentList(userId: string) {
//   const { data } = await axios.post(`${API_BASE}/om/loadassignment`, {}, {
//     params: { userId, action: "fetch" },
//   });
//   return data as { term?: string; rows: OmLoadRow[] };
// }

// export async function getOmLoadAssignmentOptions(userId: string) {
//   const { data } = await axios.post(`${API_BASE}/om/loadassignment`, {}, {
//     params: { userId, action: "options" },
//   });
//   return data;
// }

export async function getOmLoadAssignmentProfile(userId: string) {
  const { data } = await axios.post(`${API_BASE}/om/loadassignment`, {}, {
    params: { userId, action: "profile" },
  });
  return data;
}

export async function submitOmLoadAssignment(
  userId: string,
  payload: { rows: OmLoadRow[] },
  action: "submit" | "approve" | "save" = "submit"
) {
  const { data } = await axios.post(`${API_BASE}/om/loadassignment`, payload, {
    params: { userId, action },
  });
  return data as {
    ok: boolean;
    rows?: OmLoadRow[];
    approved?: number;
    term?: string;
  };
}

type Faculty = {
  faculty_id: string;
  faculty_name_display: string;
};

/** List all sections for the current term (no algorithm) */
export async function getOmLoadAssignmentList(user_id: string) {
  const base = (typeof API_BASE !== "undefined" ? API_BASE : "").replace(/\/+$/, "");
  const url = `${base}/om/load-assignment/list?user_id=${encodeURIComponent(user_id)}`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ term: string; rows: OmLoadRow[] }>;
}

/** Auto-assign algorithm run (fill faculty/day/time/room) */
export async function runOmAutoAssign(params: {
  user_id: string;
  department_id?: string;
}) {
  const base = (typeof API_BASE !== "undefined" ? API_BASE : "").replace(/\/+$/, "");
  const qs = new URLSearchParams({ user_id: params.user_id });
  if (params.department_id) qs.set("department_id", params.department_id);
  const url = `${base}/om/load-assignment/run?${qs.toString()}`;
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{ term: string; rows: OmLoadRow[] }>;
}

export async function getAllFaculty() {
  const base = (typeof API_BASE !== "undefined" ? API_BASE : "").replace(/\/+$/, "");
  const url = `${base}/om/load-assignment/faculty-all`;

  const { data } = await axios.get(url);
  return data.faculty as Faculty[];
}

/* =========================================================
   ==============  OM: Reports & Analytics  ====================
   ========================================================= */

// Descriptive 1: Faculty Teaching History
export async function fetchOmRpFacultyTeachingHistory(params: {
  search?: string;
  acad_year_start?: number;
}) {
  const base = (ANALYTICS_BASE || API_BASE).replace(/\/+$/, "");
  const sp = new URLSearchParams();
  if (params?.search) sp.set("search", params.search);
  if (typeof params?.acad_year_start === "number")
    sp.set("acad_year_start", String(params.acad_year_start));
  const url = `${base}/faculty-teaching-history?${sp.toString()}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<{
    ok: boolean;
    acad_year_start: number | null;
    ay_label: string;
    rows: Array<{
      faculty_id: string;
      faculty_name: string;
      ay_label: string;
      term: "Term 1" | "Term 2" | "Term 3" | string;
      code: string;
      title: string;
      section: string;
      mode?: string | null;
      day1?: string | null;
      room1?: string | null;
      day2?: string | null;
      room2?: string | null;
      time?: string | null;
    }>;
    meta?: { academicYears?: number[] };
  }>;
}

/* =========================================================
   ===============  CHAIR: MODULES (placeholders)  =========
   ========================================================= */

export async function getChairHeader(userId?: string) {
  const params: Record<string, any> = { action: "header" };
  if (userId) params.userId = userId;

  const { data } = await axios.post(
    `${API_BASE}/chair/facultymanagement`,
    {}, // empty body; backend reads only from query params
    { params }
  );
  return data;
}

export async function chairFacultyList(userId: string) {
  const { data } = await api.post(`/chair/faculty-management`, {}, {
    params: { userId, action: "fetch" },
  });
  return data as { ok: boolean; rows: any[] };
}

export async function chairCourseList(userId: string) {
  const { data } = await api.post(`/chair/course-management`, {}, {
    params: { userId, action: "fetch" },
  });
  return data as { ok: boolean; rows: any[] };
}

export async function chairFacultyService(userId: string) {
  const { data } = await api.post(`/chair/faculty-service`, {}, {
    params: { userId, action: "fetch" },
  });
  return data as { ok: boolean; services: any[] };
}

// frontend/src/api.ts
// -----------------------------------------------------------------------------
// ADDITIONS for Faculty Service (kept near the other CHAIR helpers)
// -----------------------------------------------------------------------------

export type ToDept =
  | "Department of Computer Technology"
  | "Department of Information Technology"
  | "Department of Literature"
  | "Department of Software Technology";
export type DayShort = "M" | "T" | "W" | "H" | "F" | "S";
export type FacultyLite = {
  faculty_id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
};

export type FacultyServiceRow = {
  id?: string;
  fs_id?: string;
  course_code: string;
  course_title: string;
  units: number | null;
  from_department: string; 
  to_department: ToDept;
  faculty: FacultyLite;
  day1: DayShort | "";
  begin1: string | "";
  end1: string | "";
  day2: DayShort | "";
  begin2: string | "";
  end2: string | "";
  remarks: string;
  status?: "draft" | "sent" | "responded" | "rejected";
  created_at?: string;
  updated_at?: string;
};

export async function getFSOptions(params?: { q?: string; toDepartment?: ToDept; requesterDepartment?: string }) {
  const sp = new URLSearchParams();
  if (params?.q) sp.set("q", params.q);
  if (params?.toDepartment) sp.set("toDepartment", params.toDepartment);
  if (params?.requesterDepartment) sp.set("requesterDepartment", params.requesterDepartment);
  const { data } = await api.get(`/chair/faculty-service/options?${sp.toString()}`);
  return data as {
    ok: boolean;
    courses: Array<{ code: string; title: string; units?: number }>;
    departments: ToDept[];
    timeBegins: string[]; // renamed: begin options only
    days: DayShort[];
    facultyOptions?: Array<{ faculty_id: string; first_name: string; last_name: string; email?: string; label: string }>;
  };
}


export async function listFacultyService(params?: {
  status?: string;
  dept?: string;
  search?: string;
  box?: "sent" | "received"; 
}) {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.dept) sp.set("dept", params.dept);
  if (params?.search) sp.set("search", params.search);
  if (params?.box) sp.set("box", params.box); 

  const { data } = await api.get(`/chair/faculty-service/list?${sp.toString()}`);
  return data as { ok: boolean; rows: FacultyServiceRow[] };
}


export async function createFacultyService(payload: {
  course_code: string;
  course_title?: string;
  units?: number | null;
  to_department: ToDept;
  from_department?: string; // NEW
}) {
  const { data } = await api.post(`/chair/faculty-service/create`, payload);
  return data as { ok: boolean; row: FacultyServiceRow };
}


export async function sendFacultyService(fs_id: string) {
  const { data } = await api.post(`/chair/faculty-service/send/${encodeURIComponent(fs_id)}`);
  return data as { ok: boolean; row: FacultyServiceRow };
}

export async function respondFacultyService(fs_id: string, payload: {
  faculty: FacultyLite;
  day1?: DayShort | "";
  begin1?: string | "";
  end1?: string | "";
  day2?: DayShort | "";
  begin2?: string | "";
  end2?: string | "";
  remarks?: string;
}) {
  const { data } = await api.post(`/chair/faculty-service/respond/${encodeURIComponent(fs_id)}`, payload);
  return data as { ok: boolean; row: FacultyServiceRow };
}

export async function rejectFacultyService(fs_id: string, payload?: { remarks?: string }) {
  const { data } = await api.post(`/chair/faculty-service/reject/${encodeURIComponent(fs_id)}`, payload || {});
  return data as { ok: boolean; row: FacultyServiceRow };
}



export async function chairClassRetention(userId: string) {
  const { data } = await api.post(`/chair/class-retention`, {}, {
    params: { userId, action: "fetch" },
  });
  return data as { ok: boolean; rows: any[] };
}

export async function chairStudentPetitions(userId: string) {
  const { data } = await api.post(`/chair/student-petitions`, {}, {
    params: { userId, action: "fetch" },
  });
  return data as { ok: boolean; rows: any[] };
}

// ===== Role switching helpers (frontend only) =====
export type ActiveRole = "chair" | "faculty";

export function getActiveRole(): ActiveRole | null {
  try {
    const v = localStorage.getItem("animo.activeRole");
    return v === "chair" || v === "faculty" ? v : null;
  } catch {
    return null;
  }
}

export function setActiveRole(role: ActiveRole) {
  try {
    localStorage.setItem("animo.activeRole", role);
  } catch {}
}

export function userHasRole(role: string): boolean {
  try {
    const u = JSON.parse(localStorage.getItem("animo.user") || "null");
    const roles: string[] = Array.isArray(u?.roles) ? u.roles.map((r: string) => r.toLowerCase()) : [];
    return roles.includes(role.toLowerCase());
  } catch {
    return false;
  }
}

export function userIsChair(): boolean {
  try {
    const u = JSON.parse(localStorage.getItem("animo.user") || "null");
    const roles: string[] = Array.isArray(u?.roles) ? u.roles : [];
    return roles.some((r) => /chair/i.test(String(r)));
  } catch {
    return false;
  }
}


/** Update coordinators & teaching team by names. Backend resolves user/faculty IDs. */
export async function updateChairCoursePeople(
  course_id: string,
  payload: {
    coordinators?: { first_name: string; last_name: string }[];
    teaching_team?: { first_name: string; last_name: string }[];
    userId?: string;
    userEmail?: string;
  }
): Promise<{
  ok: boolean;
  updated?: number;
  message?: string;
  coordinators?: { name: string; email?: string }[];
  teaching_team?: { name: string }[];
}> {
  const params: Record<string, any> = { action: "editPeople", courseId: course_id };
  if (payload.userId) params.userId = payload.userId;
  if (payload.userEmail) params.userEmail = payload.userEmail;
  const { data } = await axios.post(`${API_BASE}/chair/course-management`, payload, { params });
  return data;
}

// === CHAIR: FACULTY DIRECTORY (mirrors OM but different base path) ===

export async function getChairFacultyOptions(): Promise<FMOptions> {
  const { data } = await axios.post(`${API_BASE}/chair/facultymanagement`, {}, {
    params: { action: "options" },
  });
  return data;
}

export async function listChairFaculty(params: {
  department?: string;
  facultyType?: string;
  search?: string;
}) {
  const { department, facultyType, search } = params || {};
  const { data } = await axios.post(`${API_BASE}/chair/facultymanagement`, {}, {
    params: { action: "list", department, facultyType, search },
  });
  return data as { ok: boolean; rows: FacultyRow[] };
}

export async function addChairFacultyEntry(payload: FacultyUpsertPayload) {
  const { data } = await axios.post(`${API_BASE}/chair/facultymanagement`, payload, {
    params: { action: "add" },
  });
  return data as { ok: boolean; faculty_id?: string; user_id?: string };
}

export async function getChairFacultySchedule(
  facultyId: string,
  termId?: string
) {
  const { data } = await axios.post(`${API_BASE}/chair/facultymanagement`, {}, {
    params: { action: "schedule", facultyId, termId },
  });
  return data;
}

export async function getChairFacultyHistory(
  facultyId: string,
  termOrAy?: string | number
) {
  const params: Record<string, any> = { action: "history", facultyId };
  if (typeof termOrAy === "number") params.acadYearStart = termOrAy;
  else if (typeof termOrAy === "string" && termOrAy) params.termId = termOrAy;

  const { data } = await axios.post(`${API_BASE}/chair/facultymanagement`, {}, { params });
  return data;
}

export async function updateChairFacultyEntry(
  facultyId: string,
  payload: FacultyUpsertPayload
) {
  const { data } = await axios.post(
    `${API_BASE}/chair/facultymanagement`,
    payload, // body is the payload itself
    {
      params: {
        action: "update",
        facultyId,
      },
    }
  );
  return data as { ok: boolean };
}
