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
    const dbName = "animoassign";
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
      programs: "program_id",
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
    
    const audit_logs = [    
        { log_id: "AL001", user_id: "USR001", action: "updated faculty profile name", timestamp: "2024-03-15T10:30:45.123Z", old_value: "Hazel", new_value: "Hazel Ventura" }
    ];

    const campuses = [
      { campus_id: "CMPS001", campus_name: "Manila", address: "De La Salle University Manila, 2401 Taft Ave, Malate, Manila, 1004 Metro Manila" },
      { campus_id: "CMPS002", campus_name: "Laguna", address: "De La Salle University – Laguna Campus, 727V+352, LTI Spine Road, Laguna Blvd, Biñan, Laguna" }
    ];
  
    const departments = [
        { department_id: "DEPT001", department_name: "Department of Software Technology", campus_id: "CMPS001", description: "The DLSU Department of Software Technology offers the Bachelor of Science in Computer Science Major in Software Technology (ST) program, which prepares students to be mature software engineers and researchers by integrating fundamental computing theories with applied software engineering principles.", created_at: now, updated_at: now },
        { department_id: "DEPT002", department_name: "Department of Information Technology", campus_id: "CMPS001", description: "The De La Salle University (DLSU) Information Technology (IT) Department, part of the College of Computer Studies, focuses on developing computing professionals who can analyze organizational needs and create effective technological solutions for businesses and other entities.", created_at: now, updated_at: now }
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
    
    // each role has their own independent role_type.
    // ROLE001 and ROLE002 can have both role_type = dean, but different depts = DEPT001 and DEPT002.
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
      { kac_id: "KAC001", kac_name: "Programming Foundations", kac_code: "PROGP", program_area: "CS", course_list: ["CRS001", "CRS002"], description: "Core programming KAC", department_id: "DEPT001" }
    ];
  
    const courses = [
      { course_id: "CRS001", course_code: ["ADANI-1"], course_title: "Animation 1 : Modeling and Rigging", kac_id: "", program_level: "", units: 3, department_id: "DEPT001", prerequisites: [], description: "Animation 1, Modelling and Rigging...", room_type: "Classroom", max_enrollee: 45, min_enrollee: 15, type_of_course: "Professional" },
      { course_id: "CRS002", course_code: ["ADANI-2"], course_title: "Animation 2 : Texturing and Lighting", kac_id: "", program_level: "", units: 3, department_id: "DEPT001", prerequisites: [], description: "Animation 2...", room_type: "Classroom", max_enrollee: 45, min_enrollee: 15, type_of_course: "Professional" }
    ];
  
    const terms = [    
        { term_id: "TERM_2024_T1", acad_year_start: "2024", term_number: 1, term_index: 1, start_date: "2024-09-02", end_date: "2024-12-09", status: "inactive" },
        { term_id: "TERM_2024_T2", acad_year_start: "2024", term_number: 2, term_index: 2, start_date: "2025-01-06", end_date: "2025-04-12", status: "inactive" },
        { term_id: "TERM_2024_T3", acad_year_start: "2024", term_number: 3, term_index: 3, start_date: "2025-05-05", end_date: "2025-08-13", status: "inactive" },
        { term_id: "TERM_2025_T1", acad_year_start: "2025", term_number: 1, term_index: 4, start_date: "2025-09-06", end_date: "2025-12-06", status: "active" },
        { term_id: "TERM_2025_T2", acad_year_start: "2025", term_number: 2, term_index: 5, start_date: "2026-01-05", end_date: "2026-04-11", status: "inactive" },
        { term_id: "TERM_2025_T3", acad_year_start: "2025", term_number: 3, term_index: 6, start_date: "2026-05-04", end_date: "2026-08-08", status: "inactive" }
    ];
  
    const rooms = [    
        { room_id: "ROOM001", room_number: "GK208", room_type: "Classroom", capacity: 40, building: "Gokongwei Hall", campus_id: "CMPS001", status: "available", created_at: now, updated_at: now },
        { room_id: "ROOM002", room_number: "GK306B", room_type: "Lab", capacity: 20, building: "Gokongwei Hall", campus_id: "CMPS001", status: "available", created_at: now, updated_at: now },
        { room_id: "ROOM003", room_number: "GK306A", room_type: "Lab", capacity: 20, building: "Gokongwei Hall", campus_id: "CMPS001", status: "available", created_at: now, updated_at: now }, 
        { room_id: "ROOM004", room_number: "LB108", room_type: "Classroom", capacity: 40, building: "George Ty Building", campus_id: "CMPS002", status: "available", created_at: now, updated_at: now },
        { room_id: "ROOM005", room_number: "UH203", room_type: "Lab", capacity: 20, building: "University Hall", campus_id: "CMPS002", status: "available", created_at: now, updated_at: now },
        { room_id: "ROOM006", room_number: "UH206", room_type: "Lab", capacity: 20, building: "University Hall", campus_id: "CMPS002", status: "available", created_at: now, updated_at: now },     
    ];
  
    const sections = [    
        { section_id: "SEC001", section_code: "S18", term_id: "TERM_2025_T1", enrollment_cap: 45, enrolled: 0, batch_number: 125, status: "active", remarks: "HYB", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00", course_id: "CRS017" },
        { section_id: "SEC002", section_code: "S19", term_id: "TERM_2025_T1", enrollment_cap: 45, enrolled: 0, batch_number: 125, status: "active", remarks: "HYB", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00", course_id: "CRS017" }
    ];
  
    const section_schedules = [    
        { schedule_id: "T4-SCH001A", section_id: "SEC001", day: "Monday", start_time: "730", end_time: "900", room_id: null, room_type: "Online", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { schedule_id: "T4-SCH001B", section_id: "SEC001", day: "Thursday", start_time: "730", end_time: "900", room_id: "ROOM007", room_type: "Classroom", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { schedule_id: "T4-SCH002A", section_id: "SEC002", day: "Monday", start_time: "1100", end_time: "1230", room_id: null, room_type: "Online", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { schedule_id: "T4-SCH002B", section_id: "SEC002", day: "Thursday", start_time: "1100", end_time: "1230", room_id: "ROOM013", room_type: "Classroom", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
    ];
  
    const student_profiles = [    
        { student_id: "STDNT001", user_id: "USER018", student_number: "12276888", department_id: "DEPT001", program_id: "PRGM001", updated_at: "2025-08-23T00:00:00+08:00" }
    ];
  
    const staff_profiles = [    
        { staff_id: "STFF001", user_id: "USR003", department_id: "DEPT001", position_title: "Office Assistant", updated_at: "2025-08-23T00:00:00+08:00" }
    ];
  
    const faculty_profiles = [    
        { faculty_id: "FAC001", user_id: "USR002", employment_type: "FT", min_units: 12, max_preps: 3, certifications: [], qualified_kacs: ["KAC006", "KAC008", "KAC012", "KAC013"], teaching_years: 10, updated_at: "2024-09-01T00:00:00+08:00", department_id: "DEPT001" },
        { faculty_id: "FAC002", user_id: "USR003", employment_type: "FT", min_units: 12, max_preps: 3, certifications: [], qualified_kacs: ["KAC003", "KAC006", "KAC020", "KAC022"], teaching_years: 4, updated_at: "2024-09-01T00:00:00+08:00", department_id: "DEPT001" },
        { faculty_id: "FAC003", user_id: "USR004", employment_type: "FT", min_units: 12, max_preps: 3, certifications: [], qualified_kacs: ["KAC001", "KAC004", "KAC006", "KAC017"], teaching_years: 5, updated_at: "2024-09-01T00:00:00+08:00", department_id: "DEPT001" }
    ];
  
    const faculty_loads = [    
        { load_id: "LOAD001", term_id: "TERM_2024_T1", department_id: "DEPT001", status: "approved", total_units: 234, created_by: "USR001", created_at: "2024-09-01T00:00:00+08:00", finalized_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { load_id: "LOAD002", term_id: "TERM_2024_T2", department_id: "DEPT001", status: "approved", total_units: 234, created_by: "USR001", created_at: "2024-09-01T00:00:00+08:00", finalized_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { load_id: "LOAD003", term_id: "TERM_2024_T3", department_id: "DEPT001", status: "approved", total_units: 234, created_by: "USR001", created_at: "2024-09-01T00:00:00+08:00", finalized_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { load_id: "LOAD004", term_id: "TERM_2025_T1", department_id: "DEPT001", status: "approved", total_units: 234, created_by: "USR001", created_at: "2024-09-01T00:00:00+08:00", finalized_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" }
    ];
  
    const faculty_assignments = [    
        { assignment_id: "ASG001", load_id: "LOAD004", section_id: "SEC001", faculty_id: "FAC006", created_at: "2024-09-01T00:00:00+08:00", is_archived: false },
        { assignment_id: "ASG002", load_id: "LOAD004", section_id: "SEC002", faculty_id: "FAC054", created_at: "2024-09-01T00:00:00+08:00", is_archived: false },
        { assignment_id: "ASG003", load_id: "LOAD004", section_id: "SEC003", faculty_id: "FAC054", created_at: "2024-09-01T00:00:00+08:00", is_archived: false },
        { assignment_id: "ASG004", load_id: "LOAD004", section_id: "SEC004", faculty_id: "FAC054", created_at: "2024-09-01T00:00:00+08:00", is_archived: false }
    ];
    
    // TODO: fact-check if all fields are still required
    const plantilla_submissions = [    
        { plantilla_id: "PLT001", load_id: "LOAD001", term_id: "TERM_2025_T1", current_status: "", plantilla_version: "v1", plantilla_data: "null", assignee_id: "USR003", created_by: "USR001", created_at: now, submission_version: 2, is_final: false }
    ];
    
    // TODO: fact-check if all fields are still required
    const plantilla_reviews = [    
        { review_id: "RVW001", plantilla_id: "PLT001", reviewer_id: "USR002", reviewer_role: "ROLE001", action: "approved", comments: "This looks good to me.", review_date: "2025-08-29T00:00:00+08:00" }
    ];
    
    const batches = [    
        { batch_id: "BATCH_ID125_BSIT", batch_code: "ID 125", program_id: "PROG_BSIT", curriculum_id: "IT_CURRICULUM_V1", intake_term_id: "TERM_2025_T1", grad_term_id: null, status: "active", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { batch_id: "BATCH_ID124_BSIT", batch_code: "ID 124", program_id: "PROG_BSIT", curriculum_id: "IT_CURRICULUM_V1", intake_term_id: "TERM_2024_T1", grad_term_id: null, status: "active", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { batch_id: "BATCH_ID123_BSIT", batch_code: "ID 123", program_id: "PROG_BSIT", curriculum_id: "IT_CURRICULUM_V1", intake_term_id: "TERM_2023_T1", grad_term_id: null, status: "active", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { batch_id: "BATCH_ID122_BSIT", batch_code: "ID 122", program_id: "PROG_BSIT", curriculum_id: "IT_CURRICULUM_V1", intake_term_id: "TERM_2022_T1", grad_term_id: null, status: "active", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" }
    ];
  
    // TODO: CLARIFY if this still needs to be stored.
    // or will be handled directly logically
    const business_rules = [    
        { rule_id: "BR001", rule_category: "assignment_validation", rule_name: "Subject Outside Expertise Check", rule_description: "Faculty is assigned to teach a subject outside their main area of expertise", rule_conditions: { check_type: "expertise_match", parameters: { faculty_expertise: "required", course_subject_area: "required" } }, rule_actions: null, priority_level: 1, created_at: "2024-01-15T09:00:00.000Z", updated_at: "2024-01-15T09:00:00.000Z" },
        { rule_id: "BR002", rule_category: "special_class_checker", rule_name: "Special Class Flag", rule_description: "Faculty is handling a special class.", rule_conditions: null, rule_actions: null, priority_level: null, created_at: "2024-01-15T09:00:00.000Z", updated_at: "2024-01-15T09:00:00.000Z" }
    ];
  
    const curricula = [    
        { curriculum_id: "IT_CURRICULUM_V1", program_id: "PROG_BSIT", version: 1, status: "active", created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" }
    ];
  
    const curriculum_courses = [    
        { cc_id: "CC_IT_V1_T01_001", curriculum_id: "IT_CURRICULUM_V1", course_code: "CCPROG1", units: 3, year_level: 1, term_number: 1, is_required: true, prereq_course_codes: [], created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { cc_id: "CC_IT_V1_T01_002", curriculum_id: "IT_CURRICULUM_V1", course_code: "MTH101A", units: 3, year_level: 1, term_number: 1, is_required: true, prereq_course_codes: [], created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { cc_id: "CC_IT_V1_T01_003", curriculum_id: "IT_CURRICULUM_V1", course_code: "CCICOMP", units: 3, year_level: 1, term_number: 1, is_required: true, prereq_course_codes: [], created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { cc_id: "CC_IT_V1_T02_004", curriculum_id: "IT_CURRICULUM_V1", course_code: "CCPROG2", units: 3, year_level: 1, term_number: 2, is_required: true, prereq_course_codes: [], created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { cc_id: "CC_IT_V1_T02_005", curriculum_id: "IT_CURRICULUM_V1", course_code: "ITCMSY1", units: 3, year_level: 1, term_number: 2, is_required: true, prereq_course_codes: [], created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" },
        { cc_id: "CC_IT_V1_T02_006", curriculum_id: "IT_CURRICULUM_V1", course_code: "ITMSORG", units: 3, year_level: 1, term_number: 2, is_required: true, prereq_course_codes: [], created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" }
    ];
  
    // units_deloaded -> is per term
    const deloadings = [    
        { deloading_id: "DLD001", faculty_id: "FAC001", type: "administrative", units_deloaded: 3, start_term_id: "TERM_2024_T1", end_term_id: "TERM_2024_T3", approval_status: "APPROVED", created_at: "2025-08-23T00:00:00+08:00", updated_at: "2025-08-23T00:00:00+08:00" }
    ];
    
    const enrollment_stats = [    
        { enrollmentstat_id: "STAT001", term_id: "TERM_2025_T1", campus_id: "CMPS001", program_id: "BSCS-ST", course_id: "CRS003", course_code: "CCPROG3", section_id: "SEC001", enrolled_count: 20, source: "MLS", import_id: "IMP003", imported_at: "2025-10-07T11:00:00+08:00" },
        { enrollmentstat_id: "STAT002", term_id: "TERM_2025_T1", campus_id: "CMPS001", program_id: "BSCS-ST", course_id: "CRS003", course_code: "CCPROG3", section_id: "SEC002", enrolled_count: 20, source: "MLS", import_id: "IMP003", imported_at: "2025-10-07T11:00:00+08:00" }
    ];
  
    // TODO: CLARIFY if need to keep in database. 
    const faculty_flags = [    
        { flag_id: "F001", assignment_id: "ASG01", rule_id: "RULE001", violation_type: "Outside Expertise", details: "Faculty assigned to teach a subject not aligned with their specialization.", flag_color: "Blue", flagged_at: "2025-08-23T00:00:00+08:00" }
    ];

  
    // removed 'has_new_prep' field. JUSTIFY relevance.
    const faculty_preferences = [    
        { pref_id: "PREF001", faculty_id: "FAC001", term: "TERM_2025_T1", preferred_units: 12, availability_days: ["MTH", "TF"], preferred_times: ["07:30 - 09:00", "09:15 - 10:45", "14:30 - 16:00", "16:15 - 17:45"], preferred_kacs: ["KAC001", "KAC002"], mode: "Hybrid - in Manila Campus Only", deloading_data: { type: "administrative deloading", units: 3 }, notes: "Faculty prefers lighter load in the mornings.", is_finished: true, submitted_at: "2025-08-25T00:00:00+08:00" }
    ];
    
    // import_runs -> temporary holder for imported files.
    // Need to JUSTIFY to retain. hawi
    const import_runs = [    
        { import_id: "IMP001", term_id: "TERM_2025_T1", source_type: "enlisted_courses", file_name: "enlisted_courses_TERM_2025_T1.csv", uploaded_by: "USR-OM-001", uploaded_at: "2025-10-07T10:32:00+08:00", status: "imported", total_rows: 4, valid_rows: 4, error_rows: 0, created_entities: { pre_enlistment_counts: 4 }, file_hash: "sha256:demo_hash_enlisted_trm002", notes: "UGB Manila + a few GSM rows from screenshot" }
    ];

    // import_rows -> holder per row of 'import_runs'.
    // Need to JUSTIFY to retain. hawi
    // stores RAW import file and NORMALIZED file. 
    // ex. RAW = CCPROG2; NORMALIZED = CRS007
    const import_rows = [    
        { import_id: "IMP001", row_index: 1446, raw: { Career: "UGB", AcadGroup: "CCS", Campus: "Manila", CourseCode: "CAP-IT0", Count: "24" }, normalized: { career: "UGB", acad_group: "CCS", campus_id: "CMPS001", course_code: "CAP-IT0", course_id: "CRS012", count: 24 }, status: "done", errors: [] },
        { import_id: "IMP001", row_index: 1447, raw: { Career: "UGB", AcadGroup: "CCS", Campus: "Manila", CourseCode: "CAP-IT1", Count: "5" }, normalized: { career: "UGB", acad_group: "CCS", campus_id: "CMPS001", course_code: "CAP-IT1", course_id: "CRS013", count: 5 }, status: "done", errors: [] }
    ];

    const leaves = [    
        { leave_id: "LV001", faculty_id: "FAC001", term_id: "TERM_2025_T1", start_date: "2025-01-10T00:00:00+08:00", end_date: "2025-04-15T00:00:00+08:00", approval_status: "APPROVED", is_active: false }
    ];
  
    // CLARIFY what needs to be stored. desc or pred? or
    const reports = [    
        { report_id: "RPT001", type: "petition_status", generated_by: "USR002", generated_date: "2025-08-23T00:00:00+08:00", data: { report_period: "Q1 2024", total_petitions: 48, course_breakdown: { CCPROG1: { petitions: 23, status: "pending", remarks: "N/A" }, CCPROG2: { petitions: 10, status: "rejected" }, EMTECH: { petitions: 15, status: "pending", remarks: "N/A" } } } }
    ];
  
    // 1 'student_petition' = 1 submission of the student
    const student_petitions = [    
        { petition_id: "PTTN001", student_id: "USR003", reason: "Out of Slots", remarks: "I need the slots to avoid being behind from my flowchart.", status: "PENDING", course_id: "CRS001", term_id: "TERM_2025_T1" }
    ];
    
    const programs = [    
        { program_id: "PROG_BSIT", department_id: "DEPT001", campus_id: "CMPS001", program_code: "BSIT", program_name: "BS Information Technology", is_active: true, created_at: "2024-09-01T00:00:00+08:00", updated_at: "2024-09-01T00:00:00+08:00" }
    ];

    const preenlistment_count = [
      { count_id: "PRCNT0001", campus_id: "CMPS001", course_id: "CRS001", user_id: "USR005", term_id: "TERM_2025_T1", preenlistment_code: "1", career: "GSD", acad_group: "CCS", campus_name: "MANILA", course_code: "DIT661D", count: 5, is_archived: false, created_at: now, updated_at: now },
      { count_id: "PRCNT0002", campus_id: "CMPS001", course_id: "CRS002", user_id: "USR005", term_id: "TERM_2025_T1", preenlistment_code: "2", career: "GSD", acad_group: "CCS", campus_name: "MANILA", course_code: "DIT709D", count: 5, is_archived: false, created_at: now, updated_at: now },
      { count_id: "PRCNT0003", campus_id: "CMPS002", course_id: "CRS003", user_id: "USR006", term_id: "TERM_2025_T1", preenlistment_code: "3", career: "UGB", acad_group: "CCS", campus_name: "LAGUNA", course_code: "AD-FUND", count: 1, is_archived: false, created_at: now, updated_at: now },
      { count_id: "PRCNT0004", campus_id: "CMPS002", course_id: "CRS004", user_id: "USR006", term_id: "TERM_2025_T1", preenlistment_code: "4", career: "UGB", acad_group: "CCS", campus_name: "LAGUNA", course_code: "ADANI-1", count: 1, is_archived: false, created_at: now, updated_at: now }
    ];
  
    const preenlistment_statistics = [
      { stat_id: "PRSTAT0001", program_id: "PROG_BSIS",  term_id: "TERM_2025_T1", program_code: "BSIS", freshman: 62, sophomore: 47, junior: 40, senior: 33, is_archived: false, created_at: now, updated_at: now },
      { stat_id: "PRSTAT0002", program_id: "PROG_BSIT",  term_id: "TERM_2025_T1", program_code: "BSIT", freshman: 138, sophomore: 94, junior: 149, senior: 108, is_archived: false, created_at: now, updated_at: now },
      { stat_id: "PRSTAT0003", program_id: "PROG_BSCS-CSE",  term_id: "TERM_2025_T1", program_code: "BSCS-CSE", freshman: 84, sophomore: 29, junior: 27, senior: 26,  is_archived: false, created_at: now, updated_at: now },
      { stat_id: "PRSTAT0004", program_id: "PROG_BSCS-NIS",  term_id: "TERM_2025_T1", program_code: "BSCS-NIS", freshman: 126, sophomore: 52, junior: 62, senior: 56, is_archived: false, created_at: now, updated_at: now },
      { stat_id: "PRSTAT0005", program_id: "PROG_BSCS-ST",  term_id: "TERM_2025_T1", program_code: "BSCS-ST", freshman: 227, sophomore: 250, junior: 261, senior: 270, is_archived: false, created_at: now, updated_at: now },
      { stat_id: "PRSTAT0006", program_id: "PROG_BSMS-CS",  term_id: "TERM_2025_T1", program_code: "BSMS-CS", freshman: 11, sophomore: 12, junior: 28, senior: 36, is_archived: false, created_at: now, updated_at: now },
      { stat_id: "PRSTAT0007", program_id: "PROG_BSIET-AD",  term_id: "TERM_2025_T1", program_code: "BS IET-AD", freshman: 19, sophomore: 17, junior: 15, senior: 35, is_archived: false, created_at: now, updated_at: now },
      { stat_id: "PRSTAT0008", program_id: "PROG_BSIET-GD",  term_id: "TERM_2025_T1", program_code: "BS IET-GD", freshman: 15, sophomore: 15, junior: 20, senior: 15, is_archived: false, created_at: now, updated_at: now }
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
  
