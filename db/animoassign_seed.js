
// animoassign_seed.js
// One-file seed script for ALL collections in the "animoassign" database.
// Run with:
//   mongosh "mongodb://<HOST>:<PORT>/?authSource=admin" -u <USER> -p '<PASS>' animoassign /path/to/animoassign_seed.js
// or if already authed:
//   mongosh animoassign /path/to/animoassign_seed.js

(function () {
  const dbName = db.getName() === "admin" ? "animoassign" : db.getName();
  const adb = db.getSiblingDB(dbName);
  const now = new Date();

  const uniqueKeyMap = {
    users: "user_id",
    user_roles: "role_id",
    campuses: "campus_id",
    departments: "department_id",
    kacs: "kac_id",
    courses: "course_id",
    terms: "term_id",
    rooms: "room_id",
    sections: "section_id",
    section_schedules: "schedule_id",
    student_profiles: "student_id",
    staff_profiles: "staff_id",
    faculty_profiles: "faculty_id",
    faculty_loads: "load_id",
    current_faculty_loads: "faculty_id",
    faculty_assignments: "assignment_id",
    plantilla_submissions: "plantilla_id",
    plantilla_reviews: "review_id",
    audit_logs: "log_id",
    notifications: "notification_id"
  };

  function upsertAll(collName, docs) {
    const key = uniqueKeyMap[collName];
    if (!key) throw new Error("No unique key configured for " + collName);
    const coll = adb.getCollection(collName);
    docs.forEach((doc) => {
      if (doc.created_at && typeof doc.created_at === "string") doc.created_at = new Date(doc.created_at);
      if (doc.updated_at && typeof doc.updated_at === "string") doc.updated_at = new Date(doc.updated_at);
      if (doc.timestamp && typeof doc.timestamp === "string") doc.timestamp = new Date(doc.timestamp);
      if (doc.review_date && typeof doc.review_date === "string") doc.review_date = new Date(doc.review_date);
      if (doc.start_date && typeof doc.start_date === "string") doc.start_date = new Date(doc.start_date);
      if (doc.end_date && typeof doc.end_date === "string") doc.end_date = new Date(doc.end_date);
      const filter = { [key]: doc[key] };
      coll.updateOne(filter, { $set: doc }, { upsert: true });
    });
    print(`✔ Seeded ${docs.length} docs into ${collName}`);
  }

  // ---------- DATA STARTS HERE ----------

  const campuses = [
    { campus_id: "CAMP_TAFT", campus_name: "DLSU Taft", address: "2401 Taft Ave, Malate, Manila" },
    { campus_id: "CAMP_LAG", campus_name: "DLSU Laguna", address: "Leandro V. Locsin Campus, Biñan, Laguna" }
  ];

  const departments = [
    { department_id: "DEPT_CCS", department_name: "College of Computer Studies", campus_id: "CAMP_TAFT", description: "CCS main department", created_at: now, updated_at: now },
    { department_id: "DEPT_CLA", department_name: "College of Liberal Arts", campus_id: "CAMP_TAFT", description: "CLA department", created_at: now, updated_at: now }
  ];

  const users = [
    { user_id: "USR001", email: "dean.ccs@dlsu.edu.ph", first_name: "John", last_name: "Dean", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR002", email: "chair.ccs@dlsu.edu.ph", first_name: "Jane", last_name: "Chair", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR003", email: "faculty.cs@dlsu.edu.ph", first_name: "Frank", last_name: "Faculty", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR004", email: "staff.ccs@dlsu.edu.ph", first_name: "Stacy", last_name: "Staff", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR101", email: "stud.2025@dlsu.edu.ph", first_name: "Sam", last_name: "Student", status: true, created_at: now, updated_at: now, last_login: now }
  ];

  const user_roles = [
    { role_id: "ROLE001", user_id: "USR001", role_type: "Dean", department_id: "DEPT_CCS", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE002", user_id: "USR002", role_type: "Chair", department_id: "DEPT_CCS", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE003", user_id: "USR003", role_type: "Faculty", department_id: "DEPT_CCS", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE004", user_id: "USR004", role_type: "Staff", department_id: "DEPT_CCS", is_active: true, created_at: now, updated_at: now }
  ];

  const kacs = [
    { kac_id: "KAC_CS", kac_code: "CS", kac_name: "Computer Science", program_area: "Computing", course_list: [], description: "CS Area", department_id: "DEPT_CCS" },
    { kac_id: "KAC_IT", kac_code: "IT", kac_name: "Information Technology", program_area: "Computing", course_list: [], description: "IT Area", department_id: "DEPT_CCS" }
  ];

  const courses = [
    { course_id: "COURSE_CS101", course_code: "CS101", course_title: "Introduction to Programming", kac_id: "KAC_CS", program_level: "Undergraduate", units: 3, owning_department: "DEPT_CCS", prerequisites: [], room_type: "lecture", min_enrollee: 10, max_enrollee: 45 },
    { course_id: "COURSE_CS201", course_code: "CS201", course_title: "Data Structures", kac_id: "KAC_CS", program_level: "Undergraduate", units: 3, owning_department: "DEPT_CCS", prerequisites: ["COURSE_CS101"], room_type: "lecture", min_enrollee: 10, max_enrollee: 45 },
    { course_id: "COURSE_IT150", course_code: "IT150", course_title: "Networking Fundamentals", kac_id: "KAC_IT", program_level: "Undergraduate", units: 3, owning_department: "DEPT_CCS", prerequisites: [], room_type: "lab", min_enrollee: 10, max_enrollee: 30 }
  ];

  const terms = [
    { term_id: "TERM_2025_T1", academic_year: "2025-2026", term_number: 1, start_date: "2025-09-01", end_date: "2025-12-15", status: "active" },
    { term_id: "TERM_2025_T2", academic_year: "2025-2026", term_number: 2, start_date: "2026-01-06", end_date: "2026-04-20", status: "planned" }
  ];

  const rooms = [
    { room_id: "ROOM_GOK402", room_code: "GOK-402", capacity: 45, type: "lecture", campus: "DLSU Taft", building: "Gokongwei Hall" },
    { room_id: "ROOM_GOKL201", room_code: "GOKL-201", capacity: 30, type: "lab", campus: "DLSU Taft", building: "Gokongwei Hall" }
  ];

  const sections = [
    { section_id: "SEC_CS101_A", section_code: "CS101-A", course_id: "COURSE_CS101", term_id: "TERM_2025_T1", campus_id: "CAMP_TAFT", department_id: "DEPT_CCS", min_enrollee: 10, max_enrollee: 45, created_at: now, updated_at: now },
    { section_id: "SEC_CS201_A", section_code: "CS201-A", course_id: "COURSE_CS201", term_id: "TERM_2025_T1", campus_id: "CAMP_TAFT", department_id: "DEPT_CCS", min_enrollee: 10, max_enrollee: 45, created_at: now, updated_at: now }
  ];

  const section_schedules = [
    { schedule_id: "SCH_CS101_A_M", section_id: "SEC_CS101_A", day: "Mon", start_time: "08:00", end_time: "09:30", room_id: "ROOM_GOK402", mode: "Face-to-Face", created_at: now, updated_at: now },
    { schedule_id: "SCH_CS101_A_W", section_id: "SEC_CS101_A", day: "Wed", start_time: "08:00", end_time: "09:30", room_id: "ROOM_GOK402", mode: "Face-to-Face", created_at: now, updated_at: now },
    { schedule_id: "SCH_CS201_A_T", section_id: "SEC_CS201_A", day: "Tue", start_time: "10:00", end_time: "11:30", room_id: "ROOM_GOKL201", mode: "Face-to-Face", created_at: now, updated_at: now }
  ];

  const student_profiles = [
    { student_id: "STU202501", enrolled: 18, batch_number: 123, status: "active", remarks: "", created_at: now, updated_at: now }
  ];

  const staff_profiles = [
    { staff_id: "STF001", user_id: "USR004", department_id: "DEPT_CCS", position_title: "Department Staff", created_at: now, updated_at: now }
  ];

  const faculty_profiles = [
    { faculty_id: "FAC001", user_id: "USR003", department_id: "DEPT_CCS", campus_id: ["CAMP_TAFT"], description: "CS Faculty" }
  ];

  const faculty_loads = [
    { load_id: "LOAD_T1_CCS_01", term_id: "TERM_2025_T1", department_id: "DEPT_CCS", status: "draft", created_at: now, updated_at: now }
  ];

  const current_faculty_loads = [
    { faculty_id: "FAC001", schedule_days: ["Mon", "Wed"], schedule_time: ["08:00-09:30", "08:00-09:30"], mode: "Face-to-Face", campus: "DLSU Taft", deloading_units: 3, prep_counts: 2 }
  ];

  const faculty_assignments = [
    { assignment_id: "ASG001", load_id: "LOAD_T1_CCS_01", faculty_id: "FAC001", course_id: "COURSE_CS101", section_id: "SEC_CS101_A", is_archived: false, created_at: now },
    { assignment_id: "ASG002", load_id: "LOAD_T1_CCS_01", faculty_id: "FAC001", course_id: "COURSE_CS201", section_id: "SEC_CS201_A", is_archived: false, created_at: now }
  ];

  const plantilla_submissions = [
    {
      plantilla_id: "PLANT001",
      load_id: "LOAD_T1_CCS_01",
      term_id: "TERM_2025_T1",
      current_status: "Draft",
      template_version: "v1",
      template_data: { header: { department: "DEPT_CCS" }, items: [{ course_id: "COURSE_CS101", section_id: "SEC_CS101_A", faculty_id: "FAC001" }] },
      current_assignee: "USR001",
      created_by: "USR003",
      created_at: now,
      version_number: 1,
      is_final: false
    }
  ];

  const plantilla_reviews = [
    {
      review_id: "REV001",
      plantilla_id: "PLANT001",
      reviewer_id: "USR001",
      reviewer_role: "Dean",
      action: "commented",
      comments: "Looks good, please finalize after enrollment freeze.",
      review_date: now
    }
  ];

  const audit_logs = [
    { log_id: "LOG001", user_id: "USR003", action: "seed_init", timestamp: now, old_value: "", new_value: "Inserted initial seed data" },
    { log_id: "LOG002", user_id: "USR002", action: "create_section", timestamp: now, old_value: "", new_value: "SEC_CS201_A" }
  ];

  const notifications = [
    { notification_id: "NOTIF001", user_id: "USR003", message: "Assigned to CS101-A", status: "unread", created_at: now },
    { notification_id: "NOTIF002", user_id: "USR002", message: "PLANT001 awaiting your review", status: "unread", created_at: now }
  ];

  // ---------- WRITE TO DB ----------
  upsertAll("campuses", campuses);
  upsertAll("departments", departments);
  upsertAll("users", users);
  upsertAll("user_roles", user_roles);
  upsertAll("kacs", kacs);
  upsertAll("courses", courses);
  upsertAll("terms", terms);
  upsertAll("rooms", rooms);
  upsertAll("sections", sections);
  upsertAll("section_schedules", section_schedules);
  upsertAll("student_profiles", student_profiles);
  upsertAll("staff_profiles", staff_profiles);
  upsertAll("faculty_profiles", faculty_profiles);
  upsertAll("faculty_loads", faculty_loads);
  upsertAll("current_faculty_loads", current_faculty_loads);
  upsertAll("faculty_assignments", faculty_assignments);
  upsertAll("plantilla_submissions", plantilla_submissions);
  upsertAll("plantilla_reviews", plantilla_reviews);
  upsertAll("audit_logs", audit_logs);
  upsertAll("notifications", notifications);

  print("\\n✅ Seeding complete for DB: " + dbName + "\\n");
})();
