// src/base/Sidebar.tsx
import { NavLink } from "react-router-dom";
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
  { to: "/om/home", label: "Load Assignment", Icon: ListChecks },
  { to: "/om/home/faculty-management", label: "Faculty Directory", Icon: Users },
  { to: "/om/home/course-management", label: "Course Management", Icon: BookOpen },
  { to: "/om/home/reports-analytics", label: "Reports and Analytics", Icon: BarChart3 },
  { to: "/om/home/faculty-form", label: "Faculty Preferences", Icon: FileText },
  { to: "/om/home/faculty-service", label: "Faculty Service", Icon: ClipboardList },
  { to: "/om/home/student-petition", label: "Student Petition", Icon: FilePlus },
  { to: "/om/home/special-class", label: "Special Class", Icon: ClipboardStarIcon },
  { to: "/om/home/class-retention", label: "Class Retention", Icon: BookMarked },
];

export default function Sidebar({ open, items = defaultItems }: SidebarProps) {
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
        <p className={cls("px-2 text-xs font-semibold uppercase tracking-wide text-white/90", open ? "block" : "sr-only")}>
          Main Navigation
        </p>

        <ul className="mt-2 space-y-1">
          {items.slice(0, 4).map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === "/om/home"}
                className={({ isActive }) =>
                  cls(
                    "group flex items-center gap-3 rounded-md px-3 py-2 text-[15px] font-semibold",
                    isActive ? "bg-white/20 relative after:content-[''] after:absolute after:left-3 after:right-3 after:-bottom-[2px] after:h-[2px] after:bg-white after:rounded-full" : "hover:bg-white/10"
                  )
                }
              >
                <Icon size={18} className="shrink-0 opacity-95" />
                <span className={open ? "truncate" : "sr-only"}>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>

        <p className={cls("mt-6 px-2 text-xs font-semibold uppercase tracking-wide text-white/90", open ? "block" : "sr-only")}>
          Data Management
        </p>

        <ul className="mt-2 space-y-1">
          {items.slice(4).map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === "/om/home"}
                className={({ isActive }) =>
                  cls(
                    "group flex items-center gap-3 rounded-md px-3 py-2 text-[15px] font-semibold",
                    isActive ? "bg-white/20 relative after:content-[''] after:absolute after:left-3 after:right-3 after:-bottom-[2px] after:h-[2px] after:bg-white after:rounded-full" : "hover:bg-white/10"
                  )
                }
              >
                <Icon size={18} className="shrink-0 opacity-95" />
                <span className={open ? "truncate" : "sr-only"}>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
