// src/base/Sidebar.tsx
import { NavLink } from "react-router-dom";
import { ListChecks, Users, BookOpen, BarChart3, FileText, FilePlus, BookMarked, type LucideIcon } from "lucide-react";
import { cls } from "../utilities/cls";
import AA_Logo from "../assets/Images/AA_Logo.png";
import loginBg from "../assets/Images/login_bg.png";

export type SidebarItem = { to: string; label: string; Icon: LucideIcon };
type SidebarProps = { open: boolean; onToggle: () => void; items?: SidebarItem[] };

const defaultItems: SidebarItem[] = [
  { to: "/om/load-assignment", label: "Load Assignment", Icon: ListChecks },
  { to: "/om/faculty-management", label: "Faculty Management", Icon: Users },
  { to: "/om/course-management", label: "Course Management", Icon: BookOpen },
  { to: "/om/reports-analytics", label: "Reports and Analytics", Icon: BarChart3 },
  { to: "/om/faculty-form", label: "Faculty Form", Icon: FileText },
  { to: "/om/student-petition", label: "Student Petition", Icon: FilePlus },
  { to: "/om/class-retention", label: "Class Retention", Icon: BookMarked },
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
                className={({ isActive }) =>
                  cls(
                    "group flex items-center gap-3 rounded-md px-3 py-2 text-[15px] font-semibold",
                    isActive ? "bg-white/20" : "hover:bg-white/10"
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
                className={({ isActive }) =>
                  cls(
                    "group flex items-center gap-3 rounded-md px-3 py-2 text-[15px] font-semibold",
                    isActive ? "bg-white/20" : "hover:bg-white/10"
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
