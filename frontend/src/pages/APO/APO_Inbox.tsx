import { useEffect, useMemo, useState } from "react";
import axios from "axios";

import InboxShell from "@/pages/shared/InboxShell";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import { API_BASE } from "@/api";

type SessionUser = {
  userId?: string;
  fullName?: string;
  roles?: string[];
};

function inferRoleTitle(user: SessionUser | null): string {
  const roles = Array.isArray(user?.roles) ? user!.roles! : [];
  if (
    roles.some(
      (r) => /^apo\b/i.test(String(r)) || /academic\s*programming\s*officer/i.test(String(r))
    )
  ) {
    return "Academic Programming Officer";
  }
  return roles[0] ? String(roles[0]) : "User";
}

function normCampusLabel(v: any): string {
  const s = String(v || "").trim();
  if (!s) return "";
  const up = s.toUpperCase();
  if (up === "MANILA") return "Manila";
  if (up === "LAGUNA") return "Laguna";
  // Already title-case in DB for many installs
  return s;
}

function APOInboxMain() {
  const user = useMemo(() => {
    try {
      const raw = localStorage.getItem("animo.user");
      return raw ? (JSON.parse(raw) as SessionUser) : null;
    } catch {
      return null;
    }
  }, []);

  const fullName = (user?.fullName || "APO").trim() || "APO";
  const roleTitle = inferRoleTitle(user);

  const [campusLabel, setCampusLabel] = useState<string>("");

  // Fetch campus label from backend (same source as Course Offerings).
  // Login payload does not include campus, so we must resolve it here.
  useEffect(() => {
    const userId = user?.userId;
    if (!userId) return;

    const cacheKey = `apo.campusLabel.${userId}`;
    try {
      const cached = normCampusLabel(localStorage.getItem(cacheKey));
      if (cached) setCampusLabel(cached);
    } catch {
      // ignore
    }

    (async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/apo/courseofferings`, {
          params: { userId, action: "meta" },
        });

        const resolved = normCampusLabel(data?.campus?.campus_name);
        if (resolved) {
          setCampusLabel(resolved);
          try {
            localStorage.setItem(cacheKey, resolved);
          } catch {
            // ignore
          }
        }
      } catch {
        // If this fails, we still render the page; campus is just a label.
      }
    })();
  }, [user?.userId]);

  const roleLine = campusLabel ? `${roleTitle} | ${campusLabel}` : roleTitle;

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role={roleLine} inboxPath="/apo/inbox" />
      <Tabs
        mode="nav"
        items={[
          { label: "Pre-Enlistment", to: "/apo/preenlistment" },
          { label: "Course Offerings", to: "/apo/courseofferings" },
          { label: "Room Allocation", to: "/apo/roomallocation" },
        ]}
      />

      <InboxShell
        title="Inbox"
        subtitle="Manage communication and support requests"
        fallbackRoute="/apo/preenlistment"
      />
    </div>
  );
}

// Keep this export pattern (safe if you later embed inbox in a tab view)
export function InboxContent() {
  return <APOInboxMain />;
}

export default APOInboxMain;
