// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_FacultyTeachingHistory.tsx
import { Link } from "react-router-dom";

export default function OM_RP_FacultyTeachingHistory() {
  return (
    <div className="w-full px-8 py-8">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Teaching History per Faculty</h1>
          <p className="text-sm text-gray-600">Historical sections handled per faculty</p>
        </div>
        <Link
          to="/om/home/reports-analytics"
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Back to Reports
        </Link>
      </header>

      {/* TODO: Replace with your actual report UI */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
        Put your Teaching History table/filters here.
      </div>
    </div>
  );
}
