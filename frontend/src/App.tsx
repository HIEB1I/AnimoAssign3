import { BrowserRouter, Route, Routes } from "react-router-dom";
import AnalyticsPage from "./pages/Analytics.jsx";
import DataSearchPage from "./pages/DataSearch.jsx";
import MainPage from "./pages/Main.jsx";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <Routes>
          <Route path="/" element={<MainPage />} />
          <Route path="/search" element={<DataSearchPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}