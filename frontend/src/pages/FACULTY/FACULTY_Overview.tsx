import { useEffect, useState } from "react";
import { Calendar } from "lucide-react";
import { getFacultyOverview } from "../../api";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import HistoryMain from "./FACULTY_History";
import PreferencesContent from "./FACULTY_Preferences";

export default function FAC_Overview() {
  const [tab, setTab] = useState<"Overview" | "History" | "Preferences">("Overview");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const user = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = user.userId;

useEffect(() => {
  if (!userId) return;
  (async () => {
    const res = await getFacultyOverview(userId);
    if (res?.ok) setData(res);
    else setData({ error: res?.message || "Failed to load." });
  })();
}, [userId]);

if (!data) return <div className="p-10 text-gray-600">Loading faculty overview…</div>;
if (data?.error) return <div className="p-10 text-red-600">{data.error}</div>;


  if (error)
    return <div className="p-10 text-red-600 text-sm">{error}</div>;
  if (!data)
    return <div className="p-10 text-gray-600">Loading faculty overview…</div>;

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar
        fullName={data.faculty.full_name}
        role={data.faculty.role}
        department={data.faculty.department}
        notifications={data.notifications}
      />

      <Tabs
        mode="state"
        activeTab={tab}
        onTabChange={(newTab) =>
          setTab(newTab as "Overview" | "History" | "Preferences")
        }
        items={[
          { label: "Overview" },
          { label: "History" },
          { label: "Preferences" },
        ]}
      />

      {/* ---------- Main Content ---------- */}
      <main className="p-6 w-full">
        {tab === "Overview" && (
          <>
            <StatCards summary={data.summary} />
            <div className="my-6" />
            <TeachingLoad teachingLoad={data.teaching_load} term={data.term} />
          </>
        )}

        {tab === "History" && <HistoryMain />}
        {tab === "Preferences" && <PreferencesContent />}
      </main>
    </div>
  );
}

/* ---------- Stat Cards ---------- */
function StatCards({ summary }: { summary: any }) {
  const cards = [
    { title: "Teaching Units", value: summary.teaching_units, progress: summary.percent },
    { title: "Course Prep", value: summary.course_preps, progress: 100 },
    { title: "Load Status", value: summary.load_status, progress: 100 },
  ];

  return (
    <div className="mx-auto grid w-full max-w-screen-2xl grid-cols-1 gap-3 px-4 sm:grid-cols-3">
      {cards.map(({ title, value, progress }) => (
        <div
          key={title}
          className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm hover:shadow-md transition"
        >
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-semibold tracking-tight">{value}</div>
            <div className="text-[13px] text-neutral-700">{title}</div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-600">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full bg-emerald-700 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Teaching Load ---------- */
function TeachingLoad({ teachingLoad, term }: { teachingLoad: any[]; term: any }) {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const grouped = Object.fromEntries(days.map(d => [d, teachingLoad.filter(x => x.day === d)]));

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="mb-4">
          <h3 className="text-lg font-bold text-neutral-900">Teaching Load Summary</h3>
          <p className="text-sm text-neutral-500">{term.term_label}</p>
        </div>

        <div className="space-y-6">
          {days.map(day => (
            <div key={day}>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-neutral-800">
                <Calendar className="h-4 w-4 text-emerald-700" /> {day}
              </div>
              <div className="overflow-x-auto rounded-xl border border-neutral-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-neutral-50 text-neutral-600">
                    <tr>
                      <th className="px-4 py-2 text-center">Course Code</th>
                      <th className="px-4 py-2 text-center">Course Title</th>
                      <th className="px-4 py-2 text-center">Section</th>
                      <th className="px-4 py-2 text-center">Units</th>
                      <th className="px-4 py-2 text-center">Campus</th>
                      <th className="px-4 py-2 text-center">Mode</th>
                      <th className="px-4 py-2 text-center">Room</th>
                      <th className="px-4 py-2 text-center">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped[day].length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-4 text-center text-sm text-neutral-500">
                          No classes scheduled.
                        </td>
                      </tr>
                    ) : (
                      grouped[day].map((c, i) => (
                        <tr key={i} className={i % 2 ? "bg-neutral-50" : "bg-white"}>
                          <td className="text-center px-4 py-2">{c.course_code}</td>
                          <td className="text-center px-4 py-2">{c.course_title}</td>
                          <td className="text-center px-4 py-2">{c.section}</td>
                          <td className="text-center px-4 py-2">{c.units}</td>
                          <td className="text-center px-4 py-2">{c.campus}</td>
                          <td className="text-center px-4 py-2">{c.mode}</td>
                          <td className="text-center px-4 py-2">{c.room}</td>
                          <td className="text-center px-4 py-2">{c.time}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
