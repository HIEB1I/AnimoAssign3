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
  const dbName = "animoassign_dev";
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
    preenlistment_count: "count_id",
    preenlistment_statistics: "stat_id"
  };

  function upsertAll(collName, docs) {
    const key = uniqueKeyMap[collName];
    const coll = adb.getCollection(collName);

    docs.forEach((doc) => {
      // Convert ISO date strings to Date objects where applicable
      ["created_at", "updated_at", "timestamp", "review_date", "start_date", "end_date"].forEach((field) => {
        if (doc[field] && typeof doc[field] === "string") {
          doc[field] = new Date(doc[field]);
        }
      });

      if (!key) throw new Error("No unique key configured for " + collName);
      const filter = { [key]: doc[key] };
      coll.updateOne(filter, { $set: doc }, { upsert: true });
    });

    print(`✔ Seeded ${docs.length} docs into ${collName}`);
  }

  // ---------- DATA STARTS HERE ----------

  const campuses = [
    { campus_id: "CMPS001", campus_name: "Manila Campus", address: "De La Salle University Manila, 2401 Taft Ave, Malate, Manila, 1004 Metro Manila" },
    { campus_id: "CMPS002", campus_name: "Laguna Campus", address: "De La Salle University – Laguna Campus, 727V+352, LTI Spine Road, Laguna Blvd, Biñan, Laguna" }
  ];

  const departments = [
    {
      department_id: "DEPT001",
      department_name: "Department of Software Technology",
      campus_id: "CMPS001",
      description:
        "The DLSU Department of Software Technology offers the Bachelor of Science in Computer Science Major in Software Technology (ST) program, which prepares students to be mature software engineers and researchers by integrating fundamental computing theories with applied software engineering principles.",
      created_at: now,
      updated_at: now
    },
    {
      department_id: "DEPT002",
      department_name: "Department of Information Technology",
      campus_id: "CMPS001",
      description:
        "The De La Salle University (DLSU) Information Technology (IT) Department, part of the College of Computer Studies, focuses on developing computing professionals who can analyze organizational needs and create effective technological solutions for businesses and other entities.",
      created_at: now,
      updated_at: now
    }
  ];

  const users = [
    { user_id: "USR001", email: "dean.ccs@dlsu.edu.ph", first_name: "John", last_name: "Dean", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR002", email: "chair.ccs@dlsu.edu.ph", first_name: "Jane", last_name: "Chair", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR003", email: "faculty.cs@dlsu.edu.ph", first_name: "Frank", last_name: "Faculty", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR004", email: "staff.ccs@dlsu.edu.ph", first_name: "Stacy", last_name: "Staff", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR101", email: "stud.2025@dlsu.edu.ph", first_name: "Sam", last_name: "Student", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR005", email: "hazel.ventura@dlsu.edu.ph", first_name: "Hazel", last_name: "Ventura", status: true, created_at: now, updated_at: now, last_login: now },
    { user_id: "USR006", email: "maricel.delaroca@dlsu.edu.ph", first_name: "Maricel", last_name: "DelaRoca", status: true, created_at: now, updated_at: now, last_login: now },
  ];

  const user_roles = [
    { role_id: "ROLE001", user_id: "USR001", role_type: "admin", department_id: "DEPT001", description: "System administrator with full system access", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE002", user_id: "USR001", role_type: "department_chair", department_id: "DEPT001", description: "Provost office staff with academic oversight responsibilities", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE003", user_id: "USR001", role_type: "dean", department_id: "DEPT001", description: "College dean with faculty and academic program management", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE004", user_id: "USR005", role_type: "apo", department_id: "DEPT001", description: "Academic Program Officer with curriculum coordination duties", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE005", user_id: "USR001", role_type: "department_chair", department_id: "DEPT001", description: "Department chairperson with departmental leadership responsibilities", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE006", user_id: "USR001", role_type: "office_assistant", department_id: "DEPT001", description: "Office Assistant with administrative support functions, previously called Department Secretary", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE007", user_id: "USR001", role_type: "office_manager", department_id: "DEPT001", description: "Office manager is assigned to allocate the faculty loads of the faculty members, previously the Department Vice Chair", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE008", user_id: "USR001", role_type: "gs_coordinator", department_id: "DEPT001", description: "Graduate Studies Coordinator", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE009", user_id: "USR001", role_type: "faculty", department_id: "DEPT001", description: "Faculty member with teaching and research responsibilities", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE010", user_id: "USR001", role_type: "student", department_id: "DEPT001", description: "Student with access to academic resources and courses", is_active: true, created_at: now, updated_at: now },
    { role_id: "ROLE011", user_id: "USR006", role_type: "apo", department_id: "DEPT002", description: "APO for DEPT002", is_active: true, created_at: now, updated_at: now },
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
    {
      pref_id: "PREF001",
      faculty_id: "FAC001",
      updated_at: "2024-08-30",
      preferred_days: ["M", "H"],
      preferred_slots: ["07:30-09:00", "09:15-10:45"],
      unavailable_days: ["F"],
      preferred_modalities: ["Onsite"],
      preferred_kacs: ["KAC001", "KAC003"]
    }
  ];

  // Added: import_rows
  const import_rows = [
    { row_id: "ROW0001", course_code: "CCPROG1", section: "S11" }
  ];

  // Added: import_runs
  const import_runs = [
    { import_id: "IMP20240901", source: "xlsx", entity: "sections", started_at: "2024-09-01T09:00:00", ended_at: "2024-09-01T09:00:10", status: "completed", created_by: "USR001" }
  ];

  // Added: leaves
  const leaves = [
    { leave_id: "LEAVE001", faculty_id: "FAC003", term_id: "TERM_2025_T1", leave_type: "Sabbatical", start_date: "2025-09-01", end_date: "2025-12-15", approval_status: "approved", is_active: false, created_at: "2025-05-01" }
  ];

  // Added: reports
  const reports = [
    { faculty_id: "string", term_id: "string" }
  ];

  // Added: student_petitions
  const student_petitions = [
    { petition_id: "PET001", student_id: "STU001", course_id: "COURSE_CCPROG1", term_id: "TERM_2025_T2", reason: "Need for graduation", status: "pending", created_at: "2025-06-15", updated_at: "2025-06-15" }
  ];

  const preenlistment_count = [
    // --- Manila Campus ---
    {
      count_id: "PRCNT0001",
      code: "1",
      career: "GSD",
      acad_group: "CCS",
      campus: "MANILA",
      course_code: "DIT661D",
      count: 5,
      campus_id: "CMPS001",
      user_id: "USR005",
      term_id: "TERM_2025_T1",
      created_at: now,
      updated_at: now
    },
    {
      count_id: "PRCNT0002",
      code: "2",
      career: "GSD",
      acad_group: "CCS",
      campus: "MANILA",
      course_code: "DIT709D",
      count: 5,
      campus_id: "CMPS001",
      user_id: "USR005",
      term_id: "TERM_2025_T1",
      created_at: now,
      updated_at: now
    },

    {
      count_id: "PRCNT0003",
      code: "",
      career: "UGB",
      acad_group: "CCS",
      campus: "LAGUNA",
      course_code: "AD-FUND",
      count: 1,
      campus_id: "CMPS002",
      user_id: "USR006",
      term_id: "TERM_2025_T1",
      created_at: now,
      updated_at: now
    },
    {
      count_id: "PRCNT0004",
      code: "",
      career: "UGB",
      acad_group: "CCS",
      campus: "LAGUNA",
      course_code: "ADANI-1",
      count: 1,
      campus_id: "CMPS002",
      user_id: "USR006",
      term_id: "TERM_2025_T1",
      created_at: now,
      updated_at: now
    },
  ];

  const preenlistment_statistics = [
    { stat_id: "PRSTAT0001", program: "BSIS", freshman: 62, sophomore: 47, junior: 40, senior: 33, term_id: "TERM_2025_T1", created_at: now, updated_at: now },
    { stat_id: "PRSTAT0002", program: "BSIT", freshman: 138, sophomore: 94, junior: 149, senior: 108, term_id: "TERM_2025_T1", created_at: now, updated_at: now },
    { stat_id: "PRSTAT0003", program: "BSCS-CSE", freshman: 84, sophomore: 29, junior: 27, senior: 26, term_id: "TERM_2025_T1", created_at: now, updated_at: now },
    { stat_id: "PRSTAT0004", program: "BSCS-NIS", freshman: 126, sophomore: 52, junior: 62, senior: 56, term_id: "TERM_2025_T1", created_at: now, updated_at: now },
    { stat_id: "PRSTAT0005", program: "BSCS-ST", freshman: 227, sophomore: 250, junior: 261, senior: 270, term_id: "TERM_2025_T1", created_at: now, updated_at: now },
    { stat_id: "PRSTAT0006", program: "BSMS-CS", freshman: 11, sophomore: 12, junior: 28, senior: 36, term_id: "TERM_2025_T1", created_at: now, updated_at: now },
    { stat_id: "PRSTAT0007", program: "BS IET-AD", freshman: 19, sophomore: 17, junior: 15, senior: 35, term_id: "TERM_2025_T1", created_at: now, updated_at: now },
    { stat_id: "PRSTAT0008", program: "BS IET-GD", freshman: 15, sophomore: 15, junior: 20, senior: 15, term_id: "TERM_2025_T1", created_at: now, updated_at: now }
  ];


  // ---------- WRITE TO DB ----------
  // Upsert users and roles first (required for pre-enlistment user_id resolution)
  upsertAll("users", users);
  upsertAll("user_roles", user_roles);

  // ---------- Remaining collections ----------
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
  upsertAll("reports", reports);
  upsertAll("rooms", rooms);
  upsertAll("section_schedules", section_schedules);
  upsertAll("sections", sections);
  upsertAll("staff_profiles", staff_profiles);
  upsertAll("student_petitions", student_petitions);
  upsertAll("student_profiles", student_profiles);
  upsertAll("terms", terms);
  upsertAll("preenlistment_count", preenlistment_count);
  upsertAll("preenlistment_statistics", preenlistment_statistics);

  print("\\n✅ Seeding complete for DB: " + dbName + "\\n");
})();
