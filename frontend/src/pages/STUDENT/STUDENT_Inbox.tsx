import { useMemo } from "react";

import InboxShell from "@/pages/shared/InboxShell";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";

type SessionUser = {
  userId?: string;
  fullName?: string;
  roles?: string[];
};

function StudentInboxMain() {
  const user = useMemo(() => {
    try {
      const raw = localStorage.getItem("animo.user");
      return raw ? (JSON.parse(raw) as SessionUser) : null;
    } catch {
      return null;
    }
  }, []);

  const fullName = String(user?.fullName || "Student").trim() || "Student";

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role="Student" inboxPath="/student/inbox" />

      <Tabs
        mode="nav"
        items={[
          { label: "Course Offerings", to: "/student/courseofferings" },
          { label: "Class Petition", to: "/student/petition" },
          { label: "Special Class", to: "/student/specialclass" },
        ]}
      />

      <InboxShell
        title="Inbox"
        subtitle="Manage communication"
        fallbackRoute="/student/petition"
      />
    </div>
  );
}

export default StudentInboxMain;
