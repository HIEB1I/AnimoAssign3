// frontend/src/App.tsx
import { BrowserRouter, Route, Routes, Navigate, Outlet } from "react-router-dom";
import "./App.css";

// Pages
import Login from "./pages/Login/Login";
import OM_HomePage from "./pages/OM/OM_HomePage";
import OM_ProfilePage from "./pages/OM/OM_Profile";

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

        {/* Protected (after login) */}
        <Route element={<RequireAuth />}>
          <Route path="/om/home" element={<OM_HomePage />} />
          <Route path="/om/profile" element={<OM_ProfilePage />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/Login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
