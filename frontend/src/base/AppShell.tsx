// src/base/AppShell.tsx
import { useEffect, useState, type PropsWithChildren } from "react";
import Sidebar, { type SidebarItem } from "./Sidebar";
import Topbar, { type TopbarProps } from "./Topbar";

export default function AppShell({
  children,
  topbarProfileName,
  topbarProfileSubtitle,
  sidebarItems,
}: PropsWithChildren<{
  topbarProfileName?: TopbarProps["profileName"];
  topbarProfileSubtitle?: TopbarProps["profileSubtitle"];
  sidebarItems?: SidebarItem[];
}>) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const cached = localStorage.getItem("om.sidebar");
    if (cached !== null) setOpen(cached === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("om.sidebar", open ? "1" : "0");
  }, [open]);

  const toggle = () => setOpen((v) => !v);

  return (
    <div className="flex h-screen w-full bg-gray-50 text-gray-900">
      <Sidebar open={open} onToggle={toggle} items={sidebarItems} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          open={open}
          onToggleSidebar={toggle}
          profileName={topbarProfileName}
          profileSubtitle={topbarProfileSubtitle}
        />
        <main className="flex-1 overflow-auto p-4">{children}</main>
      </div>
    </div>
  );
}
