import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import AnalyticsPage from "./pages/AnalyticsPage";
import LandingPage from "./pages/LandingPage";
import SearchRecordsPage from "./pages/SearchRecordsPage";
import SubmitRecordPage from "./pages/SubmitRecordPage";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <div className="app-shell">
        <nav className="app-nav">
          <Link to="/" className="app-nav__brand">
            Animo Demo
          </Link>
          <div className="app-nav__links">
            <Link to="/submit">Submit</Link>
            <Link to="/search">Search</Link>
            <Link to="/analytics">Analytics</Link>
          </div>
        </nav>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/submit" element={<SubmitRecordPage />} />
            <Route path="/search" element={<SearchRecordsPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}