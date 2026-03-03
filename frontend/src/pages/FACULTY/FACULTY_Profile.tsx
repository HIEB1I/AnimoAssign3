// frontend/src/pages/FACULTY/FACULTY_Profile.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import TopBar from "@/component/TopBar";
import { getFacultyOverviewProfile } from "@/api";
import { FacultyProfileTab, type ToastKind } from "./components/FacultyProfileTab";

type ToastItem = { id: string; kind: ToastKind; title?: string; message: string };

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

function ToastViewport({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (!items.length) return null;

  const tone = (k: ToastKind) => {
    if (k === "success") return "border-emerald-200 bg-emerald-50 text-emerald-900";
    if (k === "error") return "border-red-200 bg-red-50 text-red-900";
    if (k === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
    return "border-slate-200 bg-white text-slate-900";
  };

  return (
    <div className="pointer-events-none fixed right-6 top-[72px] z-[1200] flex w-[360px] max-w-[90vw] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cls(
            "pointer-events-auto rounded-xl border px-4 py-3 shadow-lg",
            "backdrop-blur supports-[backdrop-filter]:bg-white/90",
            tone(t.kind)
          )}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {t.title && <div className="text-sm font-semibold">{t.title}</div>}
              <div className="mt-0.5 break-words text-sm">{t.message}</div>
            </div>
            <button
              type="button"
              className="rounded-md p-1 hover:bg-black/5"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss toast"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function FACULTY_Profile() {
  const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = raw.userId || raw.user_id || raw.id;

  const navigate = useNavigate();

  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const toastSeq = useRef(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (kind: ToastKind, message: string, title?: string) => {
      const id = String(++toastSeq.current);
      setToasts((prev) => [...prev, { id, kind, title, message }]);
      window.setTimeout(() => dismissToast(id), 3800);
    },
    [dismissToast]
  );

  const load = useCallback(async () => {
    if (!userId) {
      setError("Missing userId in local storage.");
      return;
    }
    try {
      const res = await getFacultyOverviewProfile(String(userId));
      if (!res?.ok) throw new Error(res?.detail || "Failed to load profile.");
      setData(res);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load profile.");
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="p-10 text-red-600">{error}</div>;
  if (!data) return <div className="p-10 text-gray-600">Loading profile…</div>;

  const fullName =
    data?.faculty?.full_name ||
    data?.faculty?.fullName ||
    `${(data?.faculty?.first_name ?? data?.faculty?.firstName ?? "")} ${(data?.faculty?.last_name ?? data?.faculty?.lastName ?? "")}`.trim();

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar
        fullName={fullName}
        role={data?.faculty?.role || "Faculty"}
        department={data?.faculty?.department}
        inboxPath="/faculty/inbox"
        notifications={data?.notifications}
      />

      <ToastViewport items={toasts} onDismiss={dismissToast} />

      <main className="w-full pb-24">
        <div className="mx-auto w-full max-w-screen-2xl px-4 py-6">
          <button
            type="button"
            onClick={() => navigate("/faculty/overview")}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>

          <div className="mt-4">
            <div className="text-2xl font-bold text-gray-900">My Profile</div>
            <div className="mt-1 text-sm text-gray-600">
              Update your personal details and teaching qualifications.
            </div>
          </div>
          <div className="mt-4">
            <FacultyProfileTab
              faculty={data?.faculty}
              userId={String(userId)}
              onReload={load}
              pushToast={pushToast}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
