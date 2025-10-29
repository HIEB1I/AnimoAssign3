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


// Optional: build a start URL (used by Login.tsx directly, but you can import this too)
// export function googleStartUrl(returnTo: string) {
// return join(API_BASE, `auth/google/start?return_to=${encodeURIComponent(returnTo)}`);
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

// Descriptive #2
export async function fetchCourseProfile(query: string) {
  const url = `${ANALYTICS_BASE.replace(/\/+$/, "")}/course-profile-for?query=${encodeURIComponent(query)}`;
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




/* =========================================================
   ===============  APO: PRE-ENLISTMENT  ===================
   ========================================================= */
export type PreenlistmentCountDoc = {
  // IDs (stored)
  count_id: string;
  term_id: string;
  college_id?: string;
  campus_id?: string;
  course_id?: string;

  // Business (stored)
  preenlistment_code?: string;
  career: string;

  // Derived/display (joined or aliased)
  count: number; // alias of preenlistment_count from backend
  course_code?: string; // from courses
  campus_name?: "MANILA" | "LAGUNA"; // from campuses
  college_code?: string; // from colleges
  term_number?: number; // from terms
  acad_year_start?: number; // from terms

  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;

  // Display-only aid for table (equals colleges.college_code; not stored)
  acad_group?: string;
};

export type PreenlistmentStatDoc = {
  // IDs (stored)
  stat_id: string;
  term_id: string;
  program_id?: string;
  campus_id?: string;

  // Numbers (stored)
  enrollment?: number;
  freshman: number;
  sophomore: number;
  junior: number;
  senior: number;

  // Joined display fields (not stored)
  term_number?: number;
  acad_year_start?: number;
  // backend may send nested "programs.program_code"
  program_code?: string;
  programs?: { program_code?: string };

  // Misc
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
  campus_label?: string; // Provided by backend
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
  "Acad Group": string; // not stored; for convenience in CSV only
  Campus: "MANILA" | "LAGUNA";
  "Course Code": string;
  Count: number | string;
};

export type StatCsvRow = {
  Program: string; // program_code
  FRESHMAN: number | string;
  SOPHOMORE: number | string;
  JUNIOR: number | string;
  SENIOR: number | string;
  ENROLLMENT?: number | string; // optional; backend computes if missing
};

export type ArchiveMetaItem = {
  term_number?: number;
  term_id: string;
  ay_label: string;
  courses?: number;
  programs?: number;
};

export type ArchivesMetaResponse = { archives: ArchiveMetaItem[] };

/**
 * Derive campus from roles array (expects strings like "apo ccs-manila" / "apo ccs-laguna")
 */
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
  if (campusName) qs.set("campus", campusName);
  const url = join(API_BASE, `apo/preenlistment?${qs.toString()}`);
  const { data } = await axios.post(url);
  return data;
}

/* =========================================================
   ===============  APO: COURSE OFFERINGS  ==================
   ========================================================= */
// ---------- tiny qs helper for other endpoints ----------
type Queryish = Record<string, string | number | boolean | undefined>;

function qs(q: Queryish) {
  const u = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    u.set(k, String(v));
  });
  return u.toString();
}

export async function getApoCourseOfferings(
  userId: string,
  filters?: { level?: string; department_id?: string; batch_id?: string; program_id?: string }
) {
  const url = `${API_BASE}/apo/courseofferings?` + qs({ userId, ...filters });
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function addApoOfferingRow(userId: string, data: {
  batch_id: string;
  course_id: string;
  enrollment_cap?: number;
  remarks?: string;
  slot1?: { day: string; start_time: string; end_time: string; room_id?: string };
  slot2?: { day: string; start_time: string; end_time: string; room_id?: string };
  faculty_id?: string;
}) {
  const url = `${API_BASE}/apo/courseofferings?` + qs({ userId, action: "addRow" });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function editApoOfferingRow(userId: string, data: {
  section_id: string;
  enrollment_cap?: number;
  remarks?: string;
  slot1?: { day: string; start_time: string; end_time: string; room_id?: string };
  slot2?: { day: string; start_time: string; end_time: string; room_id?: string };
  faculty_id?: string;
}) {
  const url = `${API_BASE}/apo/courseofferings?` + qs({ userId, action: "editRow" });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteApoOfferingRow(userId: string, data: { section_id: string }) {
  const url = `${API_BASE}/apo/courseofferings?` + qs({ userId, action: "deleteRow" });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function importApoOfferingsCSV(userId: string, file: File) {
  const url = `${API_BASE}/apo/courseofferings?` + qs({ userId, action: "importCSV" });
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(url, { method: "POST", body: fd });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function forwardApoCourseOfferings(userId: string, data: {
  to: string;
  subject: string;
  message: string;
  attachment_html: string;
}) {
  const url = `${API_BASE}/apo/courseofferings?` + qs({ userId, action: "forward" });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
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
  data: { room_id: string; section_id: string; day: Day; time_band: string }
) {
  const r = await fetch(
    `${base}/apo/roomallocation?${new URLSearchParams({ userId, action: "assign" }).toString()}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }
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
  reasons: string[];   // from config in student_petitions
  statuses: string[];  // from config in student_petitions
};

export type PetitionSubmitPayload = {
  department: string;
  courseCode: string;   // ONLY code
  reason: string;       // must be one of options.reasons
  studentNumber: string;
};

export async function getStudentPetitions(userId: string) {
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

export async function getStudentProfile(userId: string) {
  const { data } = await axios.post(`${API_BASE}/student/petition`, {}, {
    params: { userId, action: "profile" },
  });
  return data;
}

export async function submitStudentPetition(userId: string, payload: PetitionSubmitPayload) {
  const { data } = await axios.post(`${API_BASE}/student/petition`, payload, {
    params: { userId, action: "submit" },
  });
  return data;
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
  day_time?: string;          // e.g. "M 07:30–09:00; H 07:30–09:00"
  room_label?: string;        // "A1101 (Classroom)" or "Online" / "TBA"
  campus_name?: string;       // MUST be present even if Online/TBA
  term_label?: string;        // e.g. "AY 2024–2025 T1"
  created_at?: string;        // for sorting on UI
};

export type FacultyHistoryProfile = {
  faculty_id: string;
  faculty_name?: string;
  department_id?: string;
};

export type FacultyHistoryOptions = {
  // keep minimal; extend later if needed
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
    preferred_kacs: string[];       // KAC codes or IDs
    mode?: { mode?: string; campus_id?: string };
    notes?: string;
    has_new_prep?: boolean;
    is_finished?: boolean;
    term_id?: string;               // optional; server falls back to active term
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
  day1: string;
  begin1: string;
  end1: string;
  room1: string;
  day2: string;
  begin2: string;
  end2: string;
  room2: string;
  capacity: number | "";
  status?: "" | "Confirmed" | "Pending" | "Unassigned" | "Conflict";
  conflictNote?: string;
};

export async function getOmLoadAssignmentList(userId: string) {
  const { data } = await axios.post(`${API_BASE}/om/loadassignment`, {}, {
    params: { userId, action: "fetch" },
  });
  return data as { term?: string; rows: OmLoadRow[] };
}

export async function getOmLoadAssignmentOptions(userId: string) {
  const { data } = await axios.post(`${API_BASE}/om/loadassignment`, {}, {
    params: { userId, action: "options" },
  });
  return data;
}

export async function getOmLoadAssignmentProfile(userId: string) {
  const { data } = await axios.post(`${API_BASE}/om/loadassignment`, {}, {
    params: { userId, action: "profile" },
  });
  return data;
}

export async function submitOmLoadAssignment(
  userId: string,
  payload: { rows: OmLoadRow[] }
) {
  const { data } = await axios.post(`${API_BASE}/om/loadassignment`, payload, {
    params: { userId, action: "submit" },
  });
  return data as { ok: boolean; rows: OmLoadRow[] };
}

