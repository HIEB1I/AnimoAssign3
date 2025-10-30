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
  career: string;                 // UGB / GSM as provided
  count: number;                  // ← backend guarantees this from preenlistment_count
  course_code?: string;
  campus_name?: "MANILA" | "LAGUNA";
  college_code?: string;
  term_number?: number;
  acad_year_start?: number;
  is_archived?: boolean;
  created_at?: string;
  updated_at?: string;
  acad_group?: string;            // CSV 'Acad Group' or college_code fallback
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
  Career: string;          // UGB / GSM
  "Acad Group": string;    // CCS (display)
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

export type ArchivesMetaResponse = { archives: ArchiveMetaItem[] };

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
// tiny qs helper
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

export async function addApoOfferingRow(
  userId: string,
  data: {
    batch_id: string;
    course_id: string;
    enrollment_cap?: number;
    remarks?: string;
    slot1?: { room_id?: string };
    slot2?: { room_id?: string };
  }
) {
  const url = `${API_BASE}/apo/courseofferings?` + qs({ userId, action: "addRow" });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function editApoOfferingRow(
  userId: string,
  data: {
    section_id: string;
    section_code?: string;
    enrollment_cap?: number;
    remarks?: string;
    slot1?: { room_id?: string };
    slot2?: { room_id?: string };
  }
) {
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

export async function forwardApoCourseOfferings(
  userId: string,
  data: { to: string; subject: string; message: string; attachment_html: string }
) {
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
  remarks?: string;            // may be empty
  submitted_at: string;
  acad_year_start?: number | string;
  term_number?: number;
  program_code?: string;
};

export type PetitionSubmitPayload = {
  department: string;
  courseCode: string;   // ONLY code
  reason: string;       // must be one of options.reasons
  studentNumber: string;
  degree: string;
};

export async function getStudentPetitions(userId: string): Promise<{ ok: boolean; petitions: PetitionView[] }> {
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
   ===============  OM: FACULTY MANAGEMENT  ================
   ========================================================= */
export type FacultyRow = {
  faculty_id: string;
  name: string;
  email: string;
  department: string;
  position?: string;
  teaching_units: string | number;
  faculty_type: string; // Full-Time | Part-Time
  status: string;       // Active | On Leave
};

export type FMOptions = {
  ok: boolean;
  departments: string[];
  facultyTypes: string[];
  academicYears: number[];
};

export type OmHeader = {
  ok: boolean;
  email?: string;
  role_id?: string;
  department_id?: string;
  profileName?: string;
  profileSubtitle?: string;
  message?: string;
};

export async function getOmHeader(userEmail?: string, userId?: string): Promise<OmHeader> {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "header", userEmail, userId },
  });
  return data as OmHeader;
}

export async function getFacultyOptions(): Promise<FMOptions> {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "options" },
  });
  return data;
}

export async function listFaculty(params: { department?: string; facultyType?: string; search?: string }) {
  const { department, facultyType, search } = params || {};
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "list", department, facultyType, search },
  });
  return data as { ok: boolean; rows: FacultyRow[] };
}

export async function getFacultyProfile(facultyId: string) {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "profile", facultyId },
  });
  return data as { ok: boolean; profile: any };
}

export async function getFacultySchedule(facultyId: string, termId?: string) {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "schedule", facultyId, termId },
  });
  return data as { ok: boolean; term_id: string; days: any[] };
}

export async function getFacultyHistory(facultyId: string, acadYearStart?: number) {
  const { data } = await axios.post(`${API_BASE}/om/facultymanagement`, {}, {
    params: { action: "history", facultyId, acadYearStart },
  });
  return data as { ok: boolean; acad_year_start: number; terms: Record<string, any[]> };
}

/* =========================================================
   ===============  OM: STUDENT PETITION  ==================
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

export async function getOMSPHeader(params: { userEmail?: string; userId?: string }) {
  const { userEmail, userId } = params || {};
  const { data } = await axios.post(`${API_BASE}/om/student-petition`, {}, {
    params: { action: "header", userEmail, userId },
  });
  return data as { ok: boolean; profileName?: string; profileSubtitle?: string };
}

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

export async function bulkForwardOMSP(course_ids: string[], status?: string) {
  const { data } = await axios.post(`${API_BASE}/om/student-petition`, { course_ids, status }, {
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
    preferred_kacs: string[]; // IDs (preferred) or names; backend normalizes
    mode?: { mode?: string; campus_id?: string } | { mode?: string; campus_id?: string }[]; // accepts single or array
    deloading_data?: { deloading_type?: string; units?: string | number }[];
    preferred_courses?: string[]; // <— add this
    notes?: string;
    has_new_prep?: boolean;
    is_finished?: boolean;
    term_id?: string;
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

