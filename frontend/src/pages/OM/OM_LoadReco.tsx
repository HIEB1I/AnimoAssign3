// frontend/src/pages/OM/OM_LoadReco.tsx
import { useEffect, useState } from "react";
import { getOneFacultyProfile, type FacultyProfile } from "../../api";


export default function OM_LoadReco() {
  const [data, setData] = useState<FacultyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await getOneFacultyProfile();
        setData(res);
      } catch (e: any) {
        setErr(e?.message || "Failed to fetch");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">OM • Load Recommendation (preview)</h1>

      {loading && <p>Loading…</p>}
      {err && <p className="text-red-600">Error: {err}</p>}

      {!loading && !err && (
        <pre className="rounded-xl bg-gray-100 p-4 overflow-x-auto text-sm">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
