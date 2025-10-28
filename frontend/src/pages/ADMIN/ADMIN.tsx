// frontend/src/pages/ADMIN/ADMIN.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, PencilLine, Trash2, X } from "lucide-react";
import { InboxContent as AdminInboxContent } from "./ADMIN_Inbox";
import TopBar from "../../component/TopBar";
import {
  getAdminUsersList,
  getAdminLogs,
  // keep these for pattern parity; not used by this page yet
  // getAdminOptions,
  // getAdminProfile,
  // submitAdminUser,
} from "../../api";


/* ===================== small utils ===================== */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "");
const formatName = (last: string, first: string, mi?: string) =>
  `${cap(last)}, ${cap(first)}${mi?.trim() ? ` ${mi[0].toUpperCase()}.` : ""}`.trim();
const normalizeFullName = (raw: string) => {
  if (!raw) return raw;
  if (raw.includes(",")) {
    const [last, rest] = raw.split(",", 2);
    const [first = "", mi = ""] = (rest || "").trim().split(/\s+/);
    return formatName(last.trim(), first, mi.replace(".", ""));
  }
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const last = parts.pop() || "";
  const first = parts.shift() || "";
  const mi = (parts.shift() || "").replace(".", "");
  return formatName(last, first, mi);
};

/* ===================== primitives ===================== */
const Pill = ({
  children,
  tone = "neutral",
  minW = "",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "emerald" | "blue" | "amber" | "red";
  minW?: string;
}) => {
  const map = {
    neutral: "border border-neutral-200 bg-white text-neutral-700",
    emerald: "border border-emerald-200 bg-emerald-50 text-emerald-700",
    blue: "border border-blue-200 bg-blue-50 text-blue-700",
    amber: "border border-amber-200 bg-amber-50 text-amber-700",
    red: "border border-red-200 bg-red-50 text-red-600",
  } as const;
  return (
    <span
      className={cls(
        "inline-flex h-8 items-center justify-center rounded-full px-3 text-xs font-medium",
        minW,
        map[tone]
      )}
    >
      {children}
    </span>
  );
};
const DeptTag = ({ code }: { code: string }) => (
  <span className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-600">
    {code}
  </span>
);
const TimestampCell = ({ ts }: { ts: string }) => {
  const [d, t] = ts.includes("T") && ts.includes(":")
    ? ts.replace("T", " ").split(" ")
    : (ts || "").split(" ");
  return (
    <div className="leading-tight">
      <div className="text-[13px] text-slate-700">{d || ts}</div>
      {t && <div className="text-[11px] text-gray-500">{t}</div>}
    </div>
  );
};

/* ---------- Dropdown (keyboard + click) ---------- */
function Dropdown({
  value,
  onChange,
  options,
  className = "w-full",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(() => Math.max(0, options.findIndex((o) => o === value)));
  const btnRef = useRef<HTMLButtonElement>(null), listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (!open && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHover((i) => (i + 1) % options.length);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((i) => (i - 1 + options.length) % options.length);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onChange(options[hover] ?? options[0]);
      setOpen(false);
      btnRef.current?.focus();
    }
  };
  return (
    <div className={cls("relative", className)} onKeyDown={onKey}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm shadow-sm outline-none hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30"
      >
        {value} <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">▾</span>
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-2 w-56 max-h-80 overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg"
        >
          {options.map((opt, i) => (
            <button
              key={opt}
              role="option"
              aria-selected={value === opt}
              onMouseEnter={() => setHover(i)}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls("block w-full text-left px-4 py-3 text-sm", i === hover && "bg-emerald-50")}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===================== data types for API ===================== */
type UserRow = {
  id: number;
  fullName: string;   // "Last, First"
  email: string;
  status: "Active" | "Inactive";
  role: string;       // role_type
  department: string; // dept_code
  joinedDate: string; // ISO date -> shown as text
};

type LogRow = {
  id: number;
  user: string;       // "Last, First"
  action: string;
  details: string;    // from remarks
  timestamp: string;  // "YYYY-MM-DD HH:mm:ss"
};

/* ===================== Modal & Shared bits (unchanged UI) ===================== */
function Modal({
  open,
  onClose,
  children,
  width = "max-w-4xl",
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-0 grid place-items-center p-4">
        <div className={cls("w-full rounded-2xl bg-white shadow-2xl", width)}>{children}</div>
      </div>
    </div>
  );
}
const Label = ({ children }: { children: React.ReactNode }) => (
  <label className="mb-1 block text-sm font-semibold">{children}</label>
);
const TextInput = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...p}
    className={cls(
      "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30",
      p.className
    )}
  />
);

/* ===================== Page ===================== */
export default function ADMIN() {
  // Identity & shared TopBar props
  const rawUser = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId: string | null =
    rawUser.userId || rawUser.user_id || null;
  const fullName =
    rawUser.fullName ||
    [rawUser.firstName || rawUser.first_name, rawUser.lastName || rawUser.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || "Administrator";
  const role = "Administrator"; // or pull from your user object if available
  const department = undefined; // or a dept label if you have it
  const notifications: {
    id: number;
    title: string;
    details: string;
    time: Date | string;
    seen?: boolean;
  }[] = []; // optional

  // Remote data
  const [users, setUsers] = useState<UserRow[]>([]);
  const [logsRemote, setLogsRemote] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Filters
  const [qUsers, setQUsers] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("All Roles");
  const [activeOnly, setActiveOnly] = useState(false);

  // Inbox show/hide (existing behavior)
  const [showInbox, setShowInbox] = useState(false);
  useEffect(() => {
    const onOpen = () => setShowInbox(true);
    const onClose = () => setShowInbox(false);
    window.addEventListener("admin:openInbox", onOpen);
    window.addEventListener("admin:closeInbox", onClose);
    return () => {
      window.removeEventListener("admin:openInbox", onOpen);
      window.removeEventListener("admin:closeInbox", onClose);
    };
  }, []);

    // Fetch from backend (uses /api prefix already included in App.tsx)
    useEffect(() => {
      (async () => {
        try {
          const [uRes, lRes] = await Promise.all([
            fetch("/api/admin/users"),
            fetch("/api/admin/logs"),
          ]);
          const uj = await uRes.json();
          const lj = await lRes.json();
          if (!uj.ok) throw new Error("Users fetch failed");
          if (!lj.ok) throw new Error("Logs fetch failed");
          setUsers(uj.users || []);
          setLogsRemote(lj.logs || []);
          setErr(null);
        } catch (e: any) {
          setErr(e?.message || "Failed to load data.");
        } finally {
          setLoading(false);
        }
      })();
    }, []);


  // Role options: dynamic from dataset
  const ROLE_OPTIONS = useMemo(() => {
    const uniq = Array.from(new Set(users.map((u) => u.role))).sort();
    return ["All Roles", ...uniq];
  }, [users]);

  // Users filtered
  const usersFiltered = useMemo(() => {
    const t = qUsers.trim().toLowerCase();
    return users.filter(
      (u) =>
        (!t ||
          normalizeFullName(u.fullName).toLowerCase().includes(t) ||
          u.email.toLowerCase().includes(t)) &&
        (roleFilter === "All Roles" || u.role === roleFilter) &&
        (!activeOnly || u.status === "Active")
    );
  }, [qUsers, roleFilter, activeOnly, users]);

  // Logs filter/search (no Status column anymore)
  const [qLogs, setQLogs] = useState("");
  const [action, setAction] = useState<string>("All Actions");
  const actionsAvailable = useMemo(
    () => ["All Actions", ...Array.from(new Set(logsRemote.map((l) => l.action))).sort()],
    [logsRemote]
  );
  const logs = useMemo(
    () =>
      logsRemote.filter(
        (r) =>
          (action === "All Actions" || r.action === action) &&
          `${r.user} ${r.action} ${r.details}`.toLowerCase().includes(qLogs.toLowerCase().trim())
      ),
    [logsRemote, action, qLogs]
  );
  const hasAnyForAction = action === "All Actions" ? true : logsRemote.some((r) => r.action === action);

  // Edit/Add/Delete (local UI only; wire to API later if needed)
  type AddUserForm = {
    lastName: string;
    firstName: string;
    middleInitial: string;
    email: string;
    status: "Active" | "Inactive" | "";
    role: string | "";
    department: string | "";
  };
  type EditUserForm = AddUserForm;
  const emptyAdd: AddUserForm = {
    lastName: "",
    firstName: "",
    middleInitial: "",
    email: "",
    status: "",
    role: "",
    department: "",
  };
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState<null | UserRow>(null);
  const [deleteOpen, setDeleteOpen] = useState<null | UserRow>(null);
  const [addForm, setAddForm] = useState<AddUserForm>(emptyAdd);
  const [editForm, setEditForm] = useState<EditUserForm | null>(null);

  const openAdd = () => {
    setAddForm(emptyAdd);
    setAddOpen(true);
  };
  const submitAdd = () => {
    const fullName = formatName(addForm.lastName, addForm.firstName, addForm.middleInitial);
    const next: UserRow = {
      id: Math.max(0, ...users.map((u) => u.id)) + 1,
      fullName,
      email: addForm.email || "unknown@example.com",
      status: (addForm.status || "Active") as "Active" | "Inactive",
      role: (addForm.role || "Unknown") as string,
      department: addForm.department || "N/A",
      joinedDate: new Date().toISOString().slice(0, 10),
    };
    setUsers((u) => [next, ...u]);
    setAddOpen(false);
  };
  const openEdit = (u: UserRow) => {
    const formatted = normalizeFullName(u.fullName);
    const [last, rest] = formatted.split(",", 2);
    const [first = "", mi = ""] = (rest || "").trim().split(/\s+/);
    setEditForm({
      lastName: (last || "").trim(),
      firstName: first.trim(),
      middleInitial: mi.replace(".", ""),
      email: u.email,
      status: u.status,
      role: u.role,
      department: u.department,
    });
    setEditOpen({ ...u, fullName: formatted });
  };
  const submitEdit = () => {
    if (!editOpen || !editForm) return;
    const fullName = formatName(editForm.lastName, editForm.firstName, editForm.middleInitial);
    setUsers((prev) =>
      prev.map((u) =>
        u.id === editOpen.id
          ? {
              ...u,
              fullName,
              email: editForm.email,
              status: (editForm.status || u.status) as "Active" | "Inactive",
              role: (editForm.role || u.role) as string,
              department: editForm.department || u.department,
            }
          : u
      )
    );
    setEditOpen(null);
  };
  const openDelete = (u: UserRow) => setDeleteOpen({ ...u, fullName: normalizeFullName(u.fullName) });
  const confirmDelete = () => {
    if (!deleteOpen) return;
    setUsers((prev) => prev.filter((u) => u.id !== deleteOpen.id));
    setDeleteOpen(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen w-full bg-gray-50 text-slate-900">
        <TopBar
          fullName={fullName}
          role={role}
          department={department}
          notifications={notifications}
          inboxEvent="admin:openInbox"
        />
        <main className="mx-auto w-full max-w-none px-4 py-10 sm:px-6 lg:px-8">
          <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-600">
            Loading data…
          </div>
        </main>
      </div>
    );
  }
  if (err) {
    return (
      <div className="min-h-screen w-full bg-gray-50 text-slate-900">
        <TopBar
          fullName={fullName}
          role={role}
          department={department}
          notifications={notifications}
          inboxEvent="admin:openInbox"
        />
        <main className="mx-auto w-full max-w-none px-4 py-10 sm:px-6 lg:px-8">
          <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-sm text-red-700">
            {err}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900" style={{ scrollbarGutter: "stable both-edges" }}>
      <TopBar
        fullName={fullName}
        role={role}
        department={department}
        notifications={notifications}
        inboxEvent="admin:openInbox"
      />
      <main className="mx-auto w-full max-w-none space-y-8 px-4 py-6 sm:px-6 lg:px-8">
        {showInbox && <AdminInboxContent />}

        {/* ================= User Management ================= */}
        <section className="rounded-xl border border-neutral-200 bg-white">
          <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
            <div>
              <h2 className="text-xl font-bold text-neutral-900">User Management</h2>
              <p className="mt-1 text-sm text-neutral-600">Manage user accounts, roles, permission</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 px-6 py-4">
            <div className="relative min-w-[360px] flex-1 max-w-[920px]">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-neutral-400" />
              <input
                value={qUsers}
                onChange={(e) => setQUsers(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQUsers("")}
                placeholder="Search by name..."
                className="h-10 w-full rounded-lg border border-neutral-200 pl-9 pr-9 text-sm outline-none focus:ring-2 focus:ring-green-500/30"
              />
              {qUsers && (
                <button
                  type="button"
                  aria-label="Clear search"
                  title="Clear"
                  onClick={() => setQUsers("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <Dropdown value={roleFilter} onChange={(v) => setRoleFilter(v)} options={ROLE_OPTIONS} className="w-56 text-left" />
            <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-1">
              {[
                { k: false, label: "Show All Status" },
                { k: true, label: "Show Active" },
              ].map(({ k, label }) => (
                <button
                  key={String(k)}
                  onClick={() => setActiveOnly(k)}
                  aria-pressed={activeOnly === k}
                  className={cls(
                    "h-10 rounded-md px-4 text-sm font-medium transition",
                    activeOnly === k ? "bg-green-600 text-white" : "text-neutral-800 hover:bg-neutral-50"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={openAdd}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700"
            >
              <Plus className="h-4 w-4" /> Add User
            </button>
          </div>

          <div className="border-t border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-700">
            User <span className="text-neutral-500">({usersFiltered.length})</span>
          </div>

          <div className="overflow-x-auto">
            <div className="max-h-[330px] overflow-y-auto">
              <table className="min-w-full table-fixed text-sm">
                <colgroup>
                  <col style={{ width: "18%" }} /> {/* Full Name */}
                  <col style={{ width: "22%" }} /> {/* Email */}
                  <col style={{ width: "12%" }} /> {/* Status */}
                  <col style={{ width: "14%" }} /> {/* Role */}
                  <col style={{ width: "10%" }} /> {/* Department */}
                  <col style={{ width: "12%" }} /> {/* Joined Date */}
                  <col style={{ width: "12%" }} /> {/* Actions */}
                </colgroup>

                <thead>
                  <tr className="text-left text-xs text-neutral-500">
                    <th className="px-6 py-3 font-medium">Full Name</th>
                    <th className="px-3 py-3 font-medium">Email</th>
                    {["Status", "Role", "Department"].map((h) => (
                      <th key={h} className="px-3 py-3 font-medium">
                        <div className="flex justify-center">
                          <span className="inline-block min-w-30 text-center">{h}</span>
                        </div>
                      </th>
                    ))}
                    <th className="px-3 py-3 font-medium">Joined Date</th>
                    <th className="px-3 py-3 text-center font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {usersFiltered.map((u) => (
                    <tr key={u.id} className="border-t border-neutral-200 align-middle">
                      <td className="px-6 py-4">
                        <button className="text-[13px] font-semibold text-emerald-700 hover:underline">
                          {normalizeFullName(u.fullName)}
                        </button>
                      </td>
                      <td className="px-3 py-4 text-neutral-600">{u.email}</td>
                      <td className="px-3 py-4">
                        <div className="flex justify-center whitespace-nowrap">
                          <Pill minW="min-w-30" tone={u.status === "Active" ? "emerald" : "neutral"}>
                            {u.status}
                          </Pill>
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex justify-center whitespace-nowrap">
                          <Pill minW="min-w-30">{u.role}</Pill>
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex justify-center whitespace-nowrap">
                          <DeptTag code={u.department} />
                        </div>
                      </td>
                      <td className="px-3 py-4 text-neutral-700">{u.joinedDate}</td>
                      <td className="px-3 py-4">
                        <div className="flex items-center justify-center gap-2 whitespace-nowrap">
                          <button
                            onClick={() => openEdit(u)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-50"
                          >
                            <PencilLine className="h-4 w-4" />
                            Edit
                          </button>
                          <button
                            onClick={() => openDelete(u)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!usersFiltered.length && (
                    <tr>
                      <td colSpan={7} className="px-6 py-10 text-center text-sm text-neutral-500">
                        No users found for the selected filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ================= Audit Logs (Status column removed) ================= */}
        <section className="rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Audit Logs</h2>
              <p className="mt-1 text-sm text-gray-500">Track all system activities and user actions</p>
            </div>
          </div>

          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <Search className="h-4 w-4" />
              </span>
              <input
                className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-10 text-sm shadow-sm outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-emerald-500/30"
                placeholder="Search by name, action, details..."
                value={qLogs}
                onChange={(e) => setQLogs(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQLogs("")}
              />
              {qLogs && (
                <button
                  type="button"
                  aria-label="Clear search"
                  title="Clear"
                  onClick={() => setQLogs("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-gray-100 hover:text-gray-700"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <Dropdown
              value={action}
              onChange={(v) => setAction(v)}
              options={actionsAvailable}
              className="w-56 text-left"
            />
          </div>

          <div className="flex items-center justify-between px-5">
            <h3 className="text-sm font-semibold text-slate-800">
              Activity Log ({logs.length} {logs.length === 1 ? "entry" : "entries"})
            </h3>
          </div>

          <div className="p-4">
            <div className="grid grid-cols-[25%_20%_35%_20%] items-center px-3 py-2 text-xs font-semibold text-gray-500">
              <div>User</div>
              <div className="flex justify-center">
                <span className="inline-block min-w-34 text-center">Action</span>
              </div>
              <div>Details</div>
              <div>Timestamp</div>
            </div>
            <div className="mx-3 mb-2 h-px bg-gray-300" />
            <div className="max-h-[300px] overflow-y-auto">
              {logs.map((r, i) => (
                <div
                  key={r.id}
                  className={cls(
                    "grid grid-cols-[25%_20%_35%_20%] items-center",
                    "px-3 py-3 text-sm",
                    i !== logs.length - 1 && "border-b border-gray-200"
                  )}
                >
                  <div>
                    <button className="font-semibold text-emerald-700 hover:underline">
                      {normalizeFullName(r.user)}
                    </button>
                  </div>
                  <div className="flex justify-center whitespace-nowrap">
                    <Pill minW="min-w-34">{r.action}</Pill>
                  </div>
                  <div className="text-gray-600">{r.details}</div>
                  <div>
                    <TimestampCell ts={r.timestamp} />
                  </div>
                </div>
              ))}
              {!logs.length && (
                <div className="px-3 py-10 text-center text-sm">
                  {action !== "All Actions" ? (
                    hasAnyForAction ? (
                      <>
                        No <span className="font-semibold">“{action}”</span> logs
                        {qLogs.trim() && <> matching “{qLogs.trim()}”</>}.
                      </>
                    ) : (
                      <>
                        There are currently no <span className="font-semibold">“{action}”</span> logs.
                      </>
                    )
                  ) : (
                    <>No results{qLogs.trim() && <> for “{qLogs.trim()}”</>}.</>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* ================= Modals ================= */}
      {/* Add User */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)}>
        <div className="p-6 sm:p-8">
          <div className="mb-6 flex items-start justify-between">
            <h3 className="text-xl font-semibold text-emerald-700">Add User Details</h3>
            <button onClick={() => setAddOpen(false)} className="rounded-full p-1 hover:bg-gray-100">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <Label>Full Name</Label>
                <TextInput
                  placeholder="Last Name"
                  value={addForm.lastName}
                  onChange={(e) => setAddForm((f) => ({ ...f, lastName: e.target.value }))}
                />
              </div>
              <div className="md:mt-[26px]">
                <TextInput
                  placeholder="First Name"
                  value={addForm.firstName}
                  onChange={(e) => setAddForm((f) => ({ ...f, firstName: e.target.value }))}
                />
              </div>
              <div className="md:mt-[26px]">
                <TextInput
                  placeholder="Middle Initial"
                  value={addForm.middleInitial}
                  onChange={(e) => setAddForm((f) => ({ ...f, middleInitial: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Email</Label>
              <TextInput
                placeholder="name@dlsu.edu.ph"
                value={addForm.email}
                onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <Label>Status</Label>
                <Dropdown
                  value={addForm.status || "-- Select an option --"}
                  onChange={(v) =>
                    setAddForm((f) => ({ ...f, status: v === "-- Select an option --" ? "" : (v as any) }))
                  }
                  options={["-- Select an option --", "Active", "Inactive"]}
                />
              </div>
              <div>
                <Label>Role</Label>
                <Dropdown
                  value={addForm.role || "-- Select an option --"}
                  onChange={(v) => setAddForm((f) => ({ ...f, role: v === "-- Select an option --" ? "" : v }))}
                  options={["-- Select an option --", ...ROLE_OPTIONS.filter((r) => r !== "All Roles")]}
                />
              </div>
              <div>
                <Label>Department</Label>
                <TextInput
                  placeholder="Dept code (e.g., ST)"
                  value={addForm.department}
                  onChange={(e) => setAddForm((f) => ({ ...f, department: e.target.value }))}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={submitAdd}
                className="rounded-lg bg-emerald-700 px-6 py-2 text-white hover:bg-emerald-800"
              >
                Add User
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Edit User */}
      <Modal open={!!editOpen} onClose={() => setEditOpen(null)}>
        {editOpen && editForm && (
          <div className="p-6 sm:p-8">
            <div className="mb-1 flex items-start justify-between">
              <div>
                <h3 className="text-xl font-semibold text-emerald-700">Edit User Details</h3>
                <div className="mt-1 text-sm text-gray-700">
                  User: <span className="font-medium">{normalizeFullName(editOpen.fullName)}</span>
                </div>
              </div>
              <button onClick={() => setEditOpen(null)} className="rounded-full p-1 hover:bg-gray-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <Label>Full Name</Label>
                  <TextInput
                    placeholder="Last Name"
                    value={editForm.lastName}
                    onChange={(e) => setEditForm((f) => f && { ...f, lastName: e.target.value })}
                  />
                </div>
                <div className="md:mt-[26px]">
                  <TextInput
                    placeholder="First Name"
                    value={editForm.firstName}
                    onChange={(e) => setEditForm((f) => f && { ...f, firstName: e.target.value })}
                  />
                </div>
                <div className="md:mt-[26px]">
                  <TextInput
                    placeholder="Middle Initial"
                    value={editForm.middleInitial}
                    onChange={(e) => setEditForm((f) => f && { ...f, middleInitial: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Email</Label>
                <TextInput
                  placeholder="name@dlsu.edu.ph"
                  value={editForm.email}
                  onChange={(e) => setEditForm((f) => f && { ...f, email: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <Label>Status</Label>
                  <Dropdown
                    value={editForm.status || "-- Select an option --"}
                    onChange={(v) =>
                      setEditForm((f) => f && { ...f, status: v === "-- Select an option --" ? "" : (v as any) })
                    }
                    options={["-- Select an option --", "Active", "Inactive"]}
                  />
                </div>
                <div>
                  <Label>Role</Label>
                  <Dropdown
                    value={editForm.role || "-- Select an option --"}
                    onChange={(v) => setEditForm((f) => f && { ...f, role: v === "-- Select an option --" ? "" : v })}
                    options={["-- Select an option --", ...ROLE_OPTIONS.filter((r) => r !== "All Roles")]}
                  />
                </div>
                <div>
                  <Label>Department</Label>
                  <TextInput
                    placeholder="Dept code (e.g., ST)"
                    value={editForm.department}
                    onChange={(e) => setEditForm((f) => f && { ...f, department: e.target.value })}
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  onClick={submitEdit}
                  className="rounded-lg bg-emerald-700 px-6 py-2 text-white hover:bg-emerald-800"
                >
                  Save Edit
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Confirm */}
      <Modal open={!!deleteOpen} onClose={() => setDeleteOpen(null)} width="max-w-xl">
        {deleteOpen && (
          <div className="p-6 sm:p-8">
            <div className="relative">
              <button onClick={() => setDeleteOpen(null)} className="absolute right-0 top-0 rounded-full p-1 hover:bg-gray-100">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-2 flex justify-center">
              <div className="grid h-16 w-16 place-items-center rounded-full border-2 border-red-400 text-2xl font-bold text-red-500">
                X
              </div>
            </div>
            <div className="mt-4 text-center">
              <h3 className="text-2xl font-semibold">Are you sure?</h3>
              <p className="mt-2 text-gray-400">
                Do you really want to delete{" "}
                <span className="font-medium text-gray-600">{normalizeFullName(deleteOpen.fullName)}</span>? This
                process cannot be undone.
              </p>
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setDeleteOpen(null)}
                className="flex-1 rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 rounded-lg bg-red-500 px-4 py-2 font-medium text-white hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
