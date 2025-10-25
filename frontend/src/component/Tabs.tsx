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
  return (
    <div className="sticky top-[var(--header-h,58px)] z-50 w-full bg-gray-100/80 backdrop-blur">
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-3">
        <div className="rounded-xl bg-gray-200 px-3 py-2 shadow-sm">
          <div
            className={`grid gap-2 ${
              items.length <= 3 ? "grid-cols-3" : "grid-cols-4"
            }`}
          >
            {items.map(({ label, icon: Icon, to }) =>
              mode === "nav" && to ? (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    cls(
                      "mx-auto inline-flex w-full max-w-[220px] items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition",
                      isActive
                        ? "bg-white text-emerald-700 shadow"
                        : "text-gray-800 hover:bg-white/60"
                    )
                  }
                >
                  {Icon && <Icon className="h-4 w-4" />}
                  {label}
                </NavLink>
              ) : (
                <button
                  key={label}
                  type="button"
                  onClick={() => onTabChange?.(label)}
                  className={cls(
                    "mx-auto inline-flex w-full max-w-[220px] items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition",
                    activeTab === label
                      ? "bg-white text-emerald-700 shadow"
                      : "text-gray-800 hover:bg-white/60"
                  )}
                >
                  {Icon && <Icon className="h-4 w-4" />}
                  {label}
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
