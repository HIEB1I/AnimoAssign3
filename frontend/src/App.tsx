// frontend/src/App.tsx
import { BrowserRouter, Route, Routes, Navigate, Outlet } from "react-router-dom";
import "./App.css";

// Pages
import Login from "./pages/Login/Login";
import OM_HomePage from "./pages/OM/OM_HomePage";
import OM_ProfilePage from "./pages/OM/OM_Profile";
import OM_desc from "./pages/OM/OM_desc";
import OM_desc2 from "./pages/OM/OM_desc2";
import OM_desc3 from "./pages/OM/OM_desc3";
import OM_pred1 from "./pages/OM/OM_pred1";
import OM_pred2 from "./pages/OM/OM_pred2";

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
          <Route path="/om/desc" element={<OM_desc />} />
          <Route path="/om/desc2" element={<OM_desc2 />} />
          <Route path="/om/desc3" element={<OM_desc3 />} />
          <Route path="/om/pred1" element={<OM_pred1 />} />
          <Route path="/om/pred2" element={<OM_pred2 />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/Login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
