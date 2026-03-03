// frontend/src/component/Tabs.tsx
import React from "react";
import { NavLink } from "react-router-dom";

function cls(...s: (string | false | undefined)[]) {
  return s.filter(Boolean).join(" ");
}

export interface TabItem {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  to?: string; // if provided → nav mode
}

export interface TabsProps {
  mode?: "state" | "nav"; // defaults to "state"
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  items: TabItem[];
}

export default function Tabs({
  mode = "state",
  activeTab,
  onTabChange,
  items,
}: TabsProps) {
  // Responsive grid columns:
  // NOTE:
  // - Some pages (Faculty) only have 2 tabs, while others have 3.
  // - We must size the grid based on the number of items, otherwise a 2-tab view
  //   rendered as sm:grid-cols-3 leaves an empty column (mis-centers tab labels).
  const count = items.length;
  const cols =
    count <= 1
      ? "grid-cols-1"
      : count === 2
      ? "grid-cols-1 sm:grid-cols-2"
      : count === 3
      ? "grid-cols-1 sm:grid-cols-3"
      : "grid-cols-2 sm:grid-cols-4";

  return (
    <div className="sticky top-[var(--header-h,58px)] z-50 w-full bg-gray-100/80 backdrop-blur">
      {/*
        IMPORTANT UX:
        - Tabs should *span the full available width* so they feel responsive on wide screens.
        - Avoid max-width centering here; pages below already manage their own layout.
      */}
      <div className="w-full px-4 py-3">
        <div className="w-full rounded-xl bg-gray-200 px-3 py-2 shadow-sm">
          <div className={cls("grid w-full gap-2", cols)}>
            {items.map(({ label, icon: Icon, to }) =>
              mode === "nav" && to ? (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    cls(
                      "inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-xl px-2 py-2 text-xs font-semibold transition sm:px-4 sm:text-sm",
                      isActive
                        ? "bg-emerald-600 text-white shadow"
                        : "text-gray-800 hover:bg-emerald/60"
                    )
                  }
                >
                  {Icon && <Icon className="h-4 w-4" />}
                  <span className="min-w-0 truncate">{label}</span>
                </NavLink>
              ) : (
                <button
                  key={label}
                  type="button"
                  onClick={() => onTabChange?.(label)}
                  className={cls(
                    "inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-xl px-2 py-2 text-xs font-semibold transition sm:px-4 sm:text-sm",
                    activeTab === label
                      ? "bg-emerald-600 text-white shadow hover:bg-emerald-700"
                      : "text-gray-800 hover:bg-white/60"
                  )}
                >
                  {Icon && <Icon className="h-4 w-4" />}
                  <span className="min-w-0 truncate">{label}</span>
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
