import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";

import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import {
  listNotifications,
  markNotificationsSeen,
  type AppNotification,
} from "../../api";

type SessionUser = {
  userId?: string;
  user_id?: string;
  id?: string;
  fullName?: string;
  roles?: string[];
};

function toDateSafe(v: any): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function pickTime(n: any): Date {
  return (
    toDateSafe(n?.created_at) ||
    toDateSafe(n?.createdAt) ||
    toDateSafe(n?.time) ||
    new Date()
  );
}

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m > 1 ? "s" : ""} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const dd = Math.floor(h / 24);
  return `${dd} day${dd > 1 ? "s" : ""} ago`;
}

export default function STUDENT_Notifications() {
  const navigate = useNavigate();

  const user = useMemo(() => {
    try {
      const raw = localStorage.getItem("animo.user");
      return raw ? (JSON.parse(raw) as SessionUser) : null;
    } catch {
      return null;
    }
  }, []);

  const fullName = String(user?.fullName || "Student").trim() || "Student";
  const userId = String(user?.userId || user?.user_id || user?.id || "").trim();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<AppNotification[]>([]);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!userId) return;
    const res = await listNotifications(userId, 100);
    setRows(res?.rows || []);
  };

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      setError("User not logged in.");
      return;
    }

    (async () => {
      try {
        setLoading(true);
        setError("");
        await refresh();
        // Mark as read when entering this page.
        await markNotificationsSeen(userId, { all: true }).catch(() => {});
      } catch (e: any) {
        setError(e?.response?.data?.detail || e?.message || "Failed to load notifications.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const markAll = async () => {
    if (!userId) return;
    await markNotificationsSeen(userId, { all: true }).catch(() => {});
    setRows((r) => r.map((x) => ({ ...x, seen: true })));
  };

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

      <div className="mx-auto w-full max-w-5xl px-5 pb-12 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Bell className="h-6 w-6" /> Notifications
            </h1>
            <p className="mt-1 text-sm text-gray-600">Updates related to your submissions and dissolved classes.</p>
          </div>
          <button
            onClick={markAll}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
          >
            Mark all as read
          </button>
        </div>

        {loading ? (
          <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">Loading…</div>
        ) : error ? (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">{error}</div>
        ) : rows.length === 0 ? (
          <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
            No notifications yet.
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {rows.map((n) => {
              const when = pickTime(n);
              const route = n?.meta?.route;
              const canNav = typeof route === "string" && route.trim().length > 0;
              return (
                <button
                  key={n.notif_id}
                  onClick={() => {
                    if (canNav) navigate(route!);
                  }}
                  className={`w-full text-left rounded-xl border bg-white p-4 shadow-sm transition hover:shadow-md
                    ${n.seen ? "border-gray-200" : "border-emerald-200"}
                    ${canNav ? "cursor-pointer" : "cursor-default"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className={`text-sm font-semibold ${n.seen ? "text-gray-900" : "text-emerald-800"}`}>
                        {n.title}
                      </div>
                      <div className="mt-1 whitespace-pre-line text-sm text-gray-700">{n.details}</div>
                    </div>
                    <div className="shrink-0 text-xs text-gray-500">{timeAgo(when)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-6 text-sm text-gray-600">
          <button
            onClick={() => navigate("/student/petition")}
            className="text-emerald-700 hover:underline"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
