import { Outlet, NavLink, useLocation, useNavigate  } from "react-router-dom";
import { useMemo, useEffect } from "react";
import AppShell from "@/base/AppShell";
import type { SidebarItem } from "@/base/Sidebar";
import {
  Users, BookOpen, FileText, FilePlus, BookMarked, ListChecks
} from "lucide-react";
import { setActiveRole, userHasRole } from "@/api";

const ITEMS: SidebarItem[] = [
  { label: "Plantilla",          to: "/chair/plantilla",           Icon: ListChecks },
  { label: "Faculty Directory",  to: "/chair/faculty-management",  Icon: Users },
  { label: "Course Management",  to: "/chair/course-management",   Icon: BookOpen },
  { label: "Faculty Service",    to: "/chair/faculty-service",     Icon: FileText },
  { label: "Student Petition",   to: "/chair/student-petitions",   Icon: FilePlus },
  { label: "Class Retention",    to: "/chair/class-retention",     Icon: BookMarked },
];

export default function CHAIR_Plantilla() {
  // pull name/role just like OM does (localStorage)
  const session = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("animo.user") || "null"); }
    catch { return null; }
  }, []);
  const profileName = session?.fullName || " ";
  const profileSubtitle = "Department Chair";

  const canSwitchToFaculty = userHasRole("faculty");

  const loc = useLocation();
  const isLanding = /^\/chair(\/(plantilla|home)?)?$/.test(loc.pathname);
  
  const navigate = useNavigate();
    useEffect(() => {
    // When the topbar envelope is clicked (same event OM uses), open CHAIR inbox
    const toInbox = () => navigate("/chair/inbox");
    window.addEventListener("om:openInbox", toInbox);
    return () => window.removeEventListener("om:openInbox", toInbox);
  }, [navigate]);

  const switchToFaculty = () => {
    setActiveRole("faculty");
    navigate("/faculty/overview"); // your faculty landing
  };

  return (
    <AppShell
      topbarProfileName={profileName}
      topbarProfileSubtitle={profileSubtitle}
      sidebarItems={ITEMS}
    >

    {/* --- Floating switch button lives OUTSIDE page main content --- */}
      {canSwitchToFaculty && (
        <button
          onClick={switchToFaculty}
          title="Switch to faculty view"
          className="fixed right-4 top-[72px] z-40 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-emerald-400"
        >
          Switch to Faculty View
        </button>
      )}

      {/* Nested pages render here */}
      <Outlet />

      {/* Landing buttons (parent/redirect hub) */}
      {isLanding && (
        <div className="mx-auto max-w-5xl p-6">
          <header className="mb-4">
            <h1 className="text-2xl font-bold">Chair Dashboard</h1>
            <p className="text-gray-600 text-sm">Choose a module to continue</p>
          </header>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ITEMS.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className="group rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md hover:border-emerald-300 transition"
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="font-semibold text-emerald-700 group-hover:underline">
                    {label}
                  </div>
                </div>
                <div className="mt-2 pl-13 text-sm text-gray-600">
                  Open {label}
                </div>
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </AppShell>
  );
}
