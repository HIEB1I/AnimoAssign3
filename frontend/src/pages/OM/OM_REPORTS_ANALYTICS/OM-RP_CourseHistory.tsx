// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_CourseHistory.tsx
import { Link } from "react-router-dom";

export default function OM_RP_CourseHistory() {
  return (
    <div className="w-full px-8 py-8">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Course History</h1>
          <p className="text-sm text-gray-600">Section trends, pass rates, etc.</p>
        </div>
        <Link
          to="/om/home/reports-analytics"
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Back to Reports
        </Link>
      </header>

      <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
        Put your Course Profile visuals here.
      </div>
    </div>
  );
}
