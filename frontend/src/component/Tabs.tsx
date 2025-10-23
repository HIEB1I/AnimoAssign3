import { NavLink } from "react-router-dom";
import { Users, BookOpen, Building2 } from "lucide-react";

function cls(...s: (string | false | undefined)[]) {
  return s.filter(Boolean).join(" ");
}

export default function ApoTabs() {
  const items = [
    { to: "/apo/preenlistment", label: "Pre-Enlistment", icon: Users },
    { to: "/apo/courseofferings", label: "Course Offerings", icon: BookOpen },
    { to: "/apo/roomallocation", label: "Room Allocation", icon: Building2 },
  ];

  return (
    <div className="sticky top-[var(--header-h,58px)] z-50 w-full bg-gray-100/80 backdrop-blur">
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-3">
        <div className="rounded-xl bg-gray-200 px-3 py-2 shadow-sm">
          <div className="grid grid-cols-3 gap-2">
            {items.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cls(
                    "mx-auto inline-flex w-full max-w-[220px] items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition",
                    isActive ? "bg-white text-emerald-700 shadow" : "text-gray-800 hover:bg-white/60"
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
