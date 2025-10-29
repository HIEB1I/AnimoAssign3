// frontend/src/App.tsx
import { BrowserRouter, Route, Routes, Navigate, Outlet } from "react-router-dom";
import "./App.css";

// Pages
import Login from "./pages/Login/Login";
import AuthCallback from "./pages/Login/AuthCallback";

// ---------------- OM ----------------
import OM_LoadAssignment from "./pages/OM/OM_LoadAssignment";
import OM_FacultyMgt from "./pages/OM/OM_FacultyMgt";
import OM_CourseMgt from "./pages/OM/OM_CourseMgt";
import OM_ReportsAnalytics from "./pages/OM/OM_ReportsAnalytics";
import OM_FacultyForm from "./pages/OM/OM_FacultyForm";
import OM_StudentPetition from "./pages/OM/OM_StudentPetition";
import OM_ClassRetention from "./pages/OM/OM_ClassRetention";

import OM_Inbox from "./pages/OM/OM_Inbox";
import OM_desc from "./pages/OM/OM_desc";
import OM_desc2 from "./pages/OM/OM_desc2";
import OM_desc3 from "./pages/OM/OM_desc3";
import OM_pred1 from "./pages/OM/OM_pred1";
import OM_pred2 from "./pages/OM/OM_pred2";
import OM_LoadReco from "./pages/OM/OM_LoadReco";

// ---------------- APO ----------------
import APO_PreEnlistment from "./pages/APO/APO_PreEnlistment";
import APO_CourseOfferings from "./pages/APO/APO_CourseOfferings";
import APO_RoomAllocation from "./pages/APO/APO_RoomAllocation";
import APO_Inbox from "./pages/APO/APO_Inbox";

// ---------------- Student ----------------
import STUDENT_Petition from "./pages/STUDENT/STUDENT_Petition";

// ---------------- Faculty ----------------
import FACULTY_Overview from "./pages/FACULTY/FACULTY_Overview";
import FACULTY_Inbox from "./pages/FACULTY/FACULTY_Inbox";
import FACULTY_History from "./pages/FACULTY/FACULTY_History";
import FACULTY_Preferences from "./pages/FACULTY/FACULTY_Preferences";

// Admin
import ADMIN from "./pages/ADMIN/ADMIN";
import ADMIN_Inbox from "./pages/ADMIN/ADMIN_Inbox";

const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

// Simple auth gate: requires localStorage "animo.user"
function RequireAuth() {
  let ok = false;
  try {
    ok = Boolean(JSON.parse(localStorage.getItem("animo.user") || "null"));
  } catch {
    ok = false;
  }
  return ok ? <Outlet /> : <Navigate to="/Login" replace />;
}

export default function App() {
  return (
    <BrowserRouter basename={base}>
      <Routes>
        {/* Default -> login */}
        <Route path="/" element={<Navigate to="/Login" replace />} />

        {/* Public */}
        <Route path="/Login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        
        {/* Protected (after login) */}
        <Route element={<RequireAuth />}>
          <Route path="/om/desc" element={<OM_desc />} />
          <Route path="/om/desc2" element={<OM_desc2 />} />
          <Route path="/om/desc3" element={<OM_desc3 />} />
          <Route path="/om/pred1" element={<OM_pred1 />} />
          <Route path="/om/pred2" element={<OM_pred2 />} />
          <Route path="/om/loadreco" element={<OM_LoadReco />} />

          <Route path="/om/load-assignment" element={<OM_LoadAssignment />} />
          <Route path="/om/faculty-management" element={<OM_FacultyMgt />} />
          {<Route path="/om/inbox" element={<OM_Inbox />} /> }
          <Route path="/om/course-management" element={<OM_CourseMgt />} />
          <Route path="/om/reports-analytics" element={<OM_ReportsAnalytics />} />
          <Route path="/om/faculty-form" element={<OM_FacultyForm />} />
          <Route path="/om/student-petition" element={<OM_StudentPetition />} />
          <Route path="/om/class-retention" element={<OM_ClassRetention />} />
        
          {/* APO */}
          <Route path="/apo/preenlistment" element={<APO_PreEnlistment />} />
          <Route path="/apo/courseofferings" element={<APO_CourseOfferings />} />
          <Route path="/apo/roomallocation" element={<APO_RoomAllocation />} />
          <Route path="/apo/inbox" element={<APO_Inbox />} />

          {/* Student */}
          <Route path="/student/petition" element={<STUDENT_Petition />} />

          {/* Faculty */}
          <Route path="/faculty/overview" element={<FACULTY_Overview />} />
          <Route path="/faculty/history" element={<FACULTY_History />} />
          <Route path="/faculty/preferences" element={<FACULTY_Preferences />} />
          <Route path="/inbox" element={<FACULTY_Inbox />} />

          {/* Admin */}
          <Route path="/admin" element={<ADMIN />} />
          <Route path="/admin/inbox" element={<ADMIN_Inbox />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/Login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
