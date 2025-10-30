// frontend/src/App.tsx
import { BrowserRouter, Route, Routes, Navigate, Outlet } from "react-router-dom";
import "./App.css";

// Pages
import Login from "./pages/Login/Login";
import AuthCallback from "./pages/Login/AuthCallback";
import OM_HomePage from "./pages/OM/OM_HomePage";
import OM_ProfilePage from "./pages/OM/OM_Profile";
import OM_FacultyManagement from "./pages/OM/OM_FacultyManagement";
import OM_CourseManagement from "./pages/OM/OM_CourseManagement";
import OM_FacultyForm from "./pages/OM/OM_FacultyForm";
import OM_StudentPetition from "./pages/OM/OM_StudentPetition";
import OM_ClassRetention from "./pages/OM/OM_ClassRetention";

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
          <Route path="/om/home" element={<OM_HomePage />} />
          <Route path="/om/profile" element={<OM_ProfilePage />} />
          <Route path="/om/faculty-management" element={<OM_FacultyManagement />} />
          <Route path="/om/course-management" element={<OM_CourseManagement />} />
          <Route path="/om/faculty-form" element={<OM_FacultyForm />} />
          <Route path="/om/student-petition" element={<OM_StudentPetition />} />
          <Route path="/om/class-retention" element={<OM_ClassRetention />} />
        </Route>

        {/* -------- APO -------- */}
        <Route element={<RequireAuth />}>
          <Route path="/apo/preenlistment" element={<APO_PreEnlistment />} />
          <Route path="/apo/courseofferings" element={<APO_CourseOfferings />} />
          <Route path="/apo/roomallocation" element={<APO_RoomAllocation />} />
          <Route path="/apo/inbox" element={<APO_Inbox />} />
        </Route>
        {/* -------- Student -------- */}
        <Route element={<RequireAuth />}>
          <Route path="/student/petition" element={<STUDENT_Petition />} />
        </Route>
        {/* -------- Faculty -------- */}
        <Route element={<RequireAuth />}>
          <Route path="/faculty/overview" element={<FACULTY_Overview />} />
          <Route path="/faculty/history" element={<div className="p-6">History (placeholder)</div>} />
          <Route path="/faculty/preferences" element={<div className="p-6">Preferences (placeholder)</div>} />
          <Route path="/faculty/inbox" element={<FACULTY_Inbox />} />
        </Route>
        {/* Fallback */}
        <Route path="*" element={<Navigate to="/Login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
