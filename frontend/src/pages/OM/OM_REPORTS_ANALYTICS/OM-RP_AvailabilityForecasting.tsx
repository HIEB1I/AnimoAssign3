// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_AvailabilityForecasting.tsx
import { Link } from "react-router-dom";

export default function OM_RP_AvailabilityForecasting() {
  return (
    <div className="w-full px-8 py-8">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Faculty Availability Forecasting</h1>
          <p className="text-sm text-gray-600">Projected availability by time band</p>
        </div>
        <Link
          to="/om/home/reports-analytics"
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          ← Back to Reports
        </Link>
      </header>

      <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
        Put your forecasting widgets here.
      </div>
    </div>
  );
}

