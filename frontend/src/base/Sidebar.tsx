// src/base/Sidebar.tsx
import { NavLink, useLocation } from "react-router-dom";
import type { ComponentType } from "react";
import {
  ListChecks,
  Users,
  BookOpen,
  BarChart3,
  FileText,
  FilePlus,
  BookMarked,
  ClipboardList,
  Star,
} from "lucide-react";
import { cls } from "../utilities/cls";
import AA_Logo from "../assets/Images/AA_Logo.png";
import loginBg from "../assets/Images/login_bg.png";

/**
 * ✅ Must match Lucide's signature:
 * Lucide icons accept size?: string | number
 */
type SidebarIcon = ComponentType<{ size?: string | number; className?: string }>;

export type SidebarItem = { to: string; label: string; Icon: SidebarIcon };
type SidebarProps = { open: boolean; onToggle: () => void; items?: SidebarItem[] };

function ClipboardStarIcon({
  size = 18,
  className = "",
}: {
  size?: string | number;
  className?: string;
}) {
  const nSize = typeof size === "number" ? size : Number(size) || 18;
  const starSize = Math.max(10, Math.round(nSize * 0.55));

  return (
    <span className={cls("relative inline-flex items-center justify-center", className)}>
      <ClipboardList size={size} className="opacity-95" />
      <Star size={starSize} className="absolute -right-1 -bottom-1" fill="currentColor" />
    </span>
  );
}

const defaultItems: SidebarItem[] = [
  // OM routes are nested under /om/home/* (see App.tsx). Using the real URLs
  // ensures the active/selected state works correctly.
  { to: "/om/home", label: "Load Assignment", Icon: ListChecks },
  { to: "/om/home/faculty-management", label: "Faculty Directory", Icon: Users },
  { to: "/om/home/course-management", label: "Course Management", Icon: BookOpen },
  { to: "/om/home/faculty-form", label: "Faculty Preferences", Icon: FileText },
  { to: "/om/home/faculty-service", label: "Faculty Service", Icon: ClipboardList },
  { to: "/om/home/student-petition", label: "Student Petition", Icon: FilePlus },
  { to: "/om/home/special-class", label: "Special Class", Icon: ClipboardStarIcon },
  { to: "/om/home/class-retention", label: "Class Retention", Icon: BookMarked },
  { to: "/om/home/reports-analytics", label: "Reports and Analytics", Icon: BarChart3 },
];

function Section({
  title,
  items,
  open,
  first = false,
}: {
  title: string;
  items: SidebarItem[];
  open: boolean;
  first?: boolean;
}) {
  const { pathname } = useLocation();
  return (
    <>
      <p
        className={cls(
          first
            ? "px-2 text-xs font-semibold uppercase tracking-wide text-white/90"
            : "mt-6 px-2 text-xs font-semibold uppercase tracking-wide text-white/90",
          open ? "block" : "sr-only"
        )}
      >
        {title}
      </p>
      <ul className="mt-2 space-y-1">
        {items.map(({ to, label, Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              // IMPORTANT:
              // /om/home is the parent route for ALL OM pages, so we must NOT
              // mark it active for every /om/home/* path.
              end={to === "/om/home"}
              className={({ isActive }) => {
                const isOmLoadAlias =
                  to === "/om/home" && pathname === "/om/home/load-assignment";
                const active = isActive || isOmLoadAlias;
                return cls(
                  "group relative flex items-center gap-3 rounded-md px-3 py-2 text-[15px] font-semibold",
                  active
                    ? "bg-white/20 before:content-[''] before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[4px] before:rounded-r-full before:bg-white/90"
                    : "hover:bg-white/10"
                );
              }}
            >
              <Icon size={18} className="shrink-0 opacity-95" />
              <span className={open ? "truncate" : "sr-only"}>{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function Sidebar({ open, items = defaultItems }: SidebarProps) {
  const { pathname } = useLocation();
  const isOM = pathname.startsWith("/om/");
  const isCHAIR = pathname.startsWith("/chair/");

  // OM sidebar grouping requested by user:
  // PLANNING & ANALYTICS
  //  - Load Assignment
  //  - Faculty Directory
  //  - Course Management
  //  - Faculty Preferences
  //  - Faculty Service
  //  - Class Retention
  //  - Reports and Analytics
  // STUDENT REQUESTS
  //  - Student Petition
  //  - Special Class
  const byTo = new Map(items.map((it) => [it.to, it] as const));
  const omPlanningAndAnalytics = (
    [
      "/om/home",
      "/om/home/faculty-management",
      "/om/home/course-management",
      "/om/home/faculty-form",
      "/om/home/faculty-service",
      "/om/home/class-retention",
      "/om/home/reports-analytics",
    ] as const
  )
    .map((to) => byTo.get(to))
    .filter(Boolean) as SidebarItem[];

  const omStudentRequests = ([
    "/om/home/student-petition",
    "/om/home/special-class",
  ] as const)
    .map((to) => byTo.get(to))
    .filter(Boolean) as SidebarItem[];

  // CHAIR sidebar grouping requested by user:
  // PLANNING & ANALYTICS
  //  - Plantilla
  //  - Load Assignment
  //  - Faculty Directory
  //  - Course Management
  //  - Faculty Service
  //  - Class Retention
  // STUDENT REQUESTS
  //  - Student Petition
  //  - Special Class
  const chairPlanningAndAnalytics = (
    [
      "/chair/plantilla",
      "/chair/load-assignment",
      "/chair/faculty-management",
      "/chair/course-management",
      "/chair/faculty-service",
      "/chair/class-retention",
    ] as const
  )
    .map((to) => byTo.get(to))
    .filter(Boolean) as SidebarItem[];

  const chairStudentRequests = (["/chair/student-petitions", "/chair/special-class"] as const)
    .map((to) => byTo.get(to))
    .filter(Boolean) as SidebarItem[];

  const hasOMGroups = isOM && omPlanningAndAnalytics.length + omStudentRequests.length > 0;
  const hasChairGroups =
    isCHAIR && chairPlanningAndAnalytics.length + chairStudentRequests.length > 0;

  return (
    <aside
      className={cls(
        "relative h-screen shrink-0 text-white",
        "bg-cover bg-left bg-no-repeat",
        "transition-all duration-300 ease-in-out",
        open ? "w-72" : "w-16"
      )}
      style={{ backgroundImage: `url(${loginBg})` }}
    >
      <div className={cls("flex items-center justify-center px-6 py-8", open ? "gap-2" : "justify-center")}>
        <img
          src={AA_Logo}
          alt="AnimoAssign"
          className={cls("object-contain transition-all duration-300", open ? "h-12 w-auto" : "h-10 w-auto")}
        />
      </div>

      <nav className="mt-1 px-3">
        {hasOMGroups ? (
          <>
            <Section title="PLANNING & ANALYTICS" items={omPlanningAndAnalytics} open={open} first />
            <Section title="STUDENT REQUESTS" items={omStudentRequests} open={open} />
          </>
        ) : hasChairGroups ? (
          <>
            <Section
              title="PLANNING & ANALYTICS"
              items={chairPlanningAndAnalytics}
              open={open}
              first
            />
            <Section title="STUDENT REQUESTS" items={chairStudentRequests} open={open} />
          </>
        ) : (
          <>
            <Section title="Main Navigation" items={items.slice(0, 4)} open={open} first />
            <Section title="Data Management" items={items.slice(4)} open={open} />
          </>
        )}
      </nav>
    </aside>
  );
}
