
// animoassign_seed.js
// One-file seed script for ALL collections in the "animoassign" database.
// Run with:
//   mongosh "mongodb://<HOST>:<PORT>/?authSource=admin" -u <USER> -p '<PASS>' animoassign /path/to/animoassign_seed.js
// or if already authed:
//   mongosh animoassign /path/to/animoassign_seed.js

// ----------
// [hawi]: updating dummy data - current data gpt-generated
// ----------

(function () {
  const dbName = db.getName() === "admin" ? "animoassign" : db.getName();
  const adb = db.getSiblingDB(dbName);
  const now = new Date();

  const uniqueKeyMap = {
      audit_logs: "log_id",
      batches: "batch_id",
      business_rules: "rule_id",
      campuses: "campus_id",
      courses: "course_id",
      curricula: "curriculum_id",
      curriculum_courses: "cc_id",
      deloadings: "deloading_id",
      departments: "department_id",
      enrollment_stats: "stat_id",
      faculty_assignments: "assignment_id",
      faculty_flags: "flag_id",
      faculty_loads: "load_id",
      faculty_preferences: "pref_id",
      faculty_profiles: "faculty_id",
      import_rows: "row_id",
      import_runs: "import_id",
      kacs: "kac_id",
      leaves: "leave_id",
      plantilla_reviews: "review_id",
      plantilla_submissions: "plantilla_id",
      pre_enlistment_counts: "count_id",
      reports: "report_id",
      rooms: "room_id",
      section_schedules: "schedule_id",
      sections: "section_id",
      staff_profiles: "staff_id",
      student_petitions: "petition_id",
      student_profiles: "student_id",
      terms: "term_id",
      user_roles: "role_id",
      users: "user_id",
  };




  function

      upsertAll(collName, docs) {
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
      { user_id: "USR002", google_id: "", email: "chair.ccs@dlsu.edu.ph", first_name: "Jane", last_name: "Chair", status: true, profile_image: "", created_at: "2024-09-01T00:00:00+08:00", last_login: "2024-09-01T00:00:00+08:00" },
      { user_id: "USR003", google_id: "", email: "arnulfo.azcarraga@dlsu.edu.ph", first_name: "Arnulfo", last_name: "Azcarraga", status: true, profile_image: "", created_at: "2024-09-01T00:00:00+08:00", last_login: "2024-09-01T00:00:00+08:00" }
  ];

  const user_roles = [
      { role_id: "ROLE001", user_id: "USR001", role_type: "Dean", department_id: "DEPT_CCS", is_active: true, created_at: now, updated_at: now },
      { role_id: "ROLE002", user_id: "USR002", role_type: "Chair", department_id: "DEPT_CCS", is_active: true, created_at: now, updated_at: now },
      { role_id: "ROLE003", user_id: "USR003", role_type: "Faculty", department_id: "DEPT_CCS", is_active: true, created_at: now, updated_at: now },
      { role_id: "ROLE004", user_id: "USR004", role_type: "Staff", department_id: "DEPT_CCS", is_active: true, created_at: now, updated_at: now }
  ];

  const kacs = [
      { kac_id: "KAC001", kac_name: "Programming Foundations", kac_code: "PROGP", program_area: "CS", course_list: ["CRS001", "CRS002"], description: "Core programming KAC", department_id: "DEPT_CCS" }
  ];

  const courses = [
      { course_id: "CRS001", course_code: ["ADANI-1"], course_title: "Animation 1 : Modeling and Rigging", kac_id: "", program_level: "", units: 3, owning_department: "ST", prerequisites: [], description: "Animation 1, Modelling and Rigging...", room_type: "Classroom", max_enrollee: 45, min_enrollee: 15, type_of_course: "Professional" },
      { course_id: "CRS002", course_code: ["ADANI-2"], course_title: "Animation 2 : Texturing and Lighting", kac_id: "", program_level: "", units: 3, owning_department: "ST", prerequisites: [], description: "Animation 2...", room_type: "Classroom", max_enrollee: 45, min_enrollee: 15, type_of_course: "Professional" }
  ];

  const terms = [
      { term_id: "TERM_2025_T1", acad_year_start: 2025, term_number: 1, term_index: 1, start_date: "2025-09-01", end_date: "2025-12-15", status: "active" }
  ];

  const rooms = [
      { room_id: "A1708", room_number: "A1708", capacity: 45, description: "Computer Lab", building: "Andrew", campus_id: "CMPS001", status: "active", updated_at: "2024-09-01T00:00:00+08:00" }
  ];

  const sections = [
      { section_id: "SEC_CS101_A", section_code: "CS101-A", course_id: "CRS001", term_id: "TERM_2025_T1", enrollment_cap: 45, enrolled: 38, batch_number: 123, status: "active", remarks: "HYB", created_at: now, updated_at: now },
      { section_id: "SEC_CS201_A", section_code: "CS201-A", course_id: "CRS002", term_id: "TERM_2025_T1", enrollment_cap: 45, enrolled: 35, batch_number: 123, status: "active", remarks: "", created_at: now, updated_at: now }
  ];

  const section_schedules = [
      { schedule_id: "SCH_CS101_A_M", section_id: "SEC_CS101_A", day: "M", start_time: "730", end_time: "900", room_id: "Online", room_type: "Online", created_at: now, updated_at: now },
      { schedule_id: "SCH_CS101_A_H", section_id: "SEC_CS101_A", day: "H", start_time: "915", end_time: "1045", room_id: "A1708", room_type: "Classroom", created_at: now, updated_at: now }
  ];

  const student_profiles = [
      { student_id: "STU202501", enrolled: 18, batch_number: 123, status: "active", remarks: "", created_at: now, updated_at: now }
  ];

  const staff_profiles = [
      { staff_id: "STF001", user_id: "USR004", department_id: "DEPT_CCS", position_title: "Department Staff", created_at: now, updated_at: now }
  ];

  const faculty_profiles = [
      { faculty_id: "FAC001", user_id: "USR003", employment_type: "FT", min_units: 12, max_preps: 3, certifications: [], qualified_kacs: ["KAC001", "KAC003"], teaching_years: 5, updated_at: "2024-09-01T00:00:00+08:00", department_id: "DEPT_CCS" }
  ];

  const faculty_loads = [
      { load_id: "LOAD_T1_CCS_01", term_id: "TERM_2025_T1", department_id: "DEPT_CCS", status: "draft", total_units: 6, created_by: "USR003", created_at: now, finalized_at: "", updated_at: now }
  ];
  const faculty_assignments = [
      { assignment_id: "ASG001", load_id: "LOAD_T1_CCS_01", section_id: "SEC_CS101_A", faculty_id: "FAC001", created_at: "2025-06-01T09:00:00+08:00", is_archived: false },
      { assignment_id: "ASG002", load_id: "LOAD_T1_CCS_01", section_id: "SEC_CS201_A", faculty_id: "FAC001", created_at: "2025-06-01T09:05:00+08:00", is_archived: false }
  ];

  const plantilla_submissions = [
      { department: "DEPT_CCS" },
      { course_id: "COURSE_CS101", section_id: "SEC_CS101_A", faculty_id: "FAC001" }
  ];

  const plantilla_reviews = [
      { review_id: "REV001", plantilla_id: "PLANT001", reviewer_id: "USR001", reviewer_role: "Dean", action: "commented", comments: "Looks good, please finalize after enrollment freeze.", review_date: now }
  ];

  const audit_logs = [
      { log_id: "LOG001", user_id: "USR003", action: "seed_init", timestamp: now, old_value: "", new_value: "Inserted initial seed data" },
      { log_id: "LOG002", user_id: "USR002", action: "create_section", timestamp: now, old_value: "", new_value: "SEC_CS201_A" }
  ];
  // Added: batches
  const batches = [
      { batch_id: "BATCH001", curriculum_id: "CURR001", batch_code: "ST-2024-REG", year_level: 1, term_number: 1, created_at: "2024-06-01", updated_at: "2024-06-01" }
  ];

  // Added: business_rules
  const business_rules = [
      { rule_id: "RULE_MIN_UNITS_FT", category: "loads", key: "min_units_ft", value_int: 12, is_active: true, updated_at: "2024-09-01" }
  ];

  // Added: curricula
  const curricula = [
      { curriculum_id: "CURR001", curriculum_code: "BSCS-2021", owning_dept: "ST", effectivity_start: "2021-08-01", effectivity_end: null, created_at: "2021-06-01", updated_at: "2024-09-01" }
  ];

  // Added: curriculum_courses
  const curriculum_courses = [
      { cc_id: "CC001", curriculum_id: "CURR001", course_id: "COURSE_CCPROG1", year_level: 1, term_number: 1, type_of_course: "Core", prerequisite: [], prerequisite_to: ["COURSE_CCPROG2"], is_elective: false, created_at: "2024-09-01", updated_at: "2024-09-01" }
  ];

  // Added: deloadings
  const deloadings = [
      { deloading_id: "DLD001", faculty_id: "FAC001", term_start: "TERM_2024_T3", term_end: "TERM_2025_T1", type: "Research", units: 3, status: "approved", reason: "Project grant", created_at: "2024-05-15", updated_at: "2024-05-15" }
  ];

  // Added: enrollment_stats
  const enrollment_stats = [
      { stat_id: "ENR001", section_id: "SEC_CCPROG1_S11", snapshot_at: "2024-08-20T10:00:00", enrolled: 38, capacity: 45, waitlisted: 2, created_at: "2024-08-20" }
  ];

  // Added: faculty_flags
  const faculty_flags = [
      { flag_id: "FF001", faculty_id: "FAC001", term_id: "TERM_2025_T1", flag_code: "OVERLOAD", severity: "warning", details: "Assigned 16 units", is_active: true, created_at: "2025-07-01" }
  ];

  // Added: faculty_preferences
  const faculty_preferences = [
      { pref_id: "PREF001", faculty_id: "FAC001", updated_at: "2024-08-30", preferred_days: ["M", "H"], preferred_slots: ["07:30-09:00", "09:15-10:45"], unavailable_days: ["F"], preferred_modalities: ["Onsite"], preferred_kacs: ["KAC001", "KAC003"] }
  ];

  // Added: import_rows
  const import_rows = [
      { course_code: "CCPROG1", section: "S11" }
  ];

  // Added: import_runs
  const import_runs = [
      { import_id: "IMP20240901", source: "xlsx", entity: "sections", started_at: "2024-09-01T09:00:00", ended_at: "2024-09-01T09:00:10", status: "completed", created_by: "USR001" }
  ];

  // Added: leaves
  const leaves = [
      { leave_id: "LEAVE001", faculty_id: "FAC003", term_id: "TERM_2025_T1", leave_type: "Sabbatical", start_date: "2025-09-01", end_date: "2025-12-15", approval_status: "approved", is_active: false, created_at: "2025-05-01" }
  ];

  // Added: pre_enlistment_counts
  const pre_enlistment_counts = [
      { count_id: "PEC001", course_id: "COURSE_CCPROG1", term_id: "TERM_2025_T1", total_interest: 120, notes: "High demand", created_at: "2025-07-15" }
  ];

  // Added: reports
  const reports = [
      { faculty_id: "string", term_id: "string" }
  ];

  // Added: student_petitions
  const student_petitions = [
      { petition_id: "PET001", student_id: "STU001", course_id: "COURSE_CCPROG1", term_id: "TERM_2025_T2", reason: "Need for graduation", status: "pending", created_at: "2025-06-15", updated_at: "2025-06-15" }
  ];

  // ---------- WRITE TO DB ----------    

  upsertAll("audit_logs", audit_logs);
  upsertAll("batches", batches);
  upsertAll("business_rules", business_rules);
  upsertAll("campuses", campuses);
  upsertAll("courses", courses);
  upsertAll("curricula", curricula);
  upsertAll("curriculum_courses", curriculum_courses);
  upsertAll("deloadings", deloadings);
  upsertAll("departments", departments);
  upsertAll("enrollment_stats", enrollment_stats);
  upsertAll("faculty_assignments", faculty_assignments);
  upsertAll("faculty_flags", faculty_flags);
  upsertAll("faculty_loads", faculty_loads);
  upsertAll("faculty_preferences", faculty_preferences);
  upsertAll("faculty_profiles", faculty_profiles);
  upsertAll("import_rows", import_rows);
  upsertAll("import_runs", import_runs);
  upsertAll("kacs", kacs);
  upsertAll("leaves", leaves);
  upsertAll("plantilla_reviews", plantilla_reviews);
  upsertAll("plantilla_submissions", plantilla_submissions);
  upsertAll("pre_enlistment_counts", pre_enlistment_counts);
  upsertAll("reports", reports);
  upsertAll("rooms", rooms);
  upsertAll("section_schedules", section_schedules);
  upsertAll("sections", sections);
  upsertAll("staff_profiles", staff_profiles);
  upsertAll("student_petitions", student_petitions);
  upsertAll("student_profiles", student_profiles);
  upsertAll("terms", terms);
  upsertAll("user_roles", user_roles);
  upsertAll("users", users);

  print("\\n✅ Seeding complete for DB: " + dbName + "\\n");
})();