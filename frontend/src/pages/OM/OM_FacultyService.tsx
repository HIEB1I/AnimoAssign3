// frontend/src/pages/OM/OM_FacultyService.tsx
// -----------------------------------------------------------------------------
// OM mirror of CHAIR_FacultyService.
//
// We reuse the battle-tested CHAIR_FacultyService UI/logic, but expose it to OM
// through a dedicated OM route + sidebar tab.
//
// IMPORTANT (OM):
// - Department context is derived from the logged-in user's profile/session,
//   similar to OM_LoadAssignment (no manual department picker).
// -----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import CHAIR_FacultyService from "../CHAIR/CHAIR_FacultyService";
import { getOmLoadAssignmentProfile } from "@/api";

export default function OM_FacultyService() {
  const session = useMemo(() => {
    try {
      const raw = localStorage.getItem("animo.user");
      return raw ? (JSON.parse(raw) as any) : null;
    } catch {
      return null;
    }
  }, []);

  const userId =
    (session as any)?.userId ||
    (session as any)?.user_id ||
    (session as any)?.id ||
    "";

  const [deptName, setDeptName] = useState<string>("");

  useEffect(() => {
    (async () => {
      // Prefer API-derived dept (same approach as OM_LoadAssignment), fallback to session fields.
      const fallbackDept = String(
        (session as any)?.dept_name ??
          (session as any)?.dept_label ??
          (session as any)?.deptName ??
          (session as any)?.department?.dept_name ??
          ""
      ).trim();

      if (!userId) {
        setDeptName(fallbackDept);
        return;
      }

      try {
        const p = await getOmLoadAssignmentProfile(userId);
        const dept = String(
          p?.dept_name ??
            (session as any)?.dept_name ??
            (session as any)?.dept_label ??
            (session as any)?.deptName ??
            (session as any)?.department?.dept_name ??
            ""
        ).trim();

        setDeptName(dept || fallbackDept);
      } catch {
        setDeptName(fallbackDept);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return (
    <div className="space-y-4">
      {/* Mirror the CHAIR faculty service UI, pinning department from OM context. */}
      <CHAIR_FacultyService chairDepartmentName={deptName || undefined} />
    </div>
  );
}
