import { useState } from "react";
import { Link } from "react-router-dom";
import { cls } from "../../utilities/cls";
import {
  BookOpenCheck,
  GaugeCircle,
  Layers,
  CalendarClock,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";

/* ---------------- Card Data ---------------- */
type CardItem = {
  title: string;
  to: string;
  Icon: LucideIcon;
  accent: {
    ring: string;
    iconWrap: string;
    icon: string;
    title: string;
  };
};

const INSIGHT_CARDS: CardItem[] = [
  {
    title: "Teaching History per Faculty",
    to: "teaching-history",
    Icon: BookOpenCheck,
    accent: {
      ring: "ring-emerald-500/30",
      iconWrap: "from-emerald-50 to-emerald-100",
      icon: "text-emerald-700",
      title: "text-emerald-800",
    },
  },
  {
    title: "Course History",
    to: "course-history",
    Icon: Layers,
    accent: {
      ring: "ring-emerald-500/30",
      iconWrap: "from-emerald-50 to-emerald-100",
      icon: "text-emerald-700",
      title: "text-emerald-800",
    },
  },
  {
    title: "Deloading Utilization Report",
    to: "deloading-utilization",
    Icon: GaugeCircle,
    accent: {
      ring: "ring-emerald-500/30",
      iconWrap: "from-emerald-50 to-emerald-100",
      icon: "text-emerald-700",
      title: "text-emerald-800",
    },
  },
];

const FORECAST_CARDS: CardItem[] = [
  {
    title: "Faculty Availability Forecasting",
    to: "availability-forecast",
    Icon: CalendarClock,
    accent: {
      ring: "ring-emerald-500/30",
      iconWrap: "from-emerald-50 to-emerald-100",
      icon: "text-emerald-700",
      title: "text-emerald-800",
    },
  },
  {
    title: "Faculty Load Risk Forecast",
    to: "load-risk",
    Icon: AlertTriangle,
    accent: {
      ring: "ring-emerald-500/30",
      iconWrap: "from-emerald-50 to-emerald-100",
      icon: "text-emerald-700",
      title: "text-emerald-800",
    },
  },
];

/* ---------------- Page (sits inside OM_LoadAssignment) ---------------- */
export default function OM_ReportsAnalytics() {
  const [hovered, setHovered] = useState<string | null>(null);

  const renderCard = (card: CardItem, idxKey: string) => (
    <Link
      key={idxKey}
      to={`/om/home/reports-analytics/${card.to}`}
      onMouseEnter={() => setHovered(idxKey)}
      onMouseLeave={() => setHovered(null)}
      className={cls(
        "group relative isolate flex aspect-[2/1] items-center justify-center rounded-xl border border-gray-200 bg-white p-4 text-center shadow-sm transition-all duration-200 ease-out",
        hovered === idxKey && "scale-[1.02] shadow-md z-10",
        hovered && hovered !== idxKey && "scale-[0.97] opacity-90"
      )}
    >
      {/* soft panel tint */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-white to-gray-50"
      />

      {/* center icon + title */}
      <div className="relative z-[1] flex w-full flex-col items-center justify-center gap-4">
        <div
          className={cls(
            "grid h-20 w-20 place-items-center rounded-full bg-gradient-to-b shadow-inner border border-white/60",
            card.accent.iconWrap
          )}
        >
          <card.Icon className={cls("h-10 w-10", card.accent.icon)} strokeWidth={2.2} />
        </div>
        <h3 className={cls("text-base font-semibold", card.accent.title)}>
          {card.title}
        </h3>
        <p className="text-xs text-gray-500 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          Click to open
        </p>
      </div>

      {/* hover ring */}
      <div
        aria-hidden
        className={cls(
          "absolute inset-0 rounded-2xl ring-0 transition-all duration-200",
          hovered === idxKey && "ring-4",
          card.accent.ring
        )}
      />
    </Link>
  );

  return (
    <div className="w-full px-8 py-8">
      {/* Header */}
      <header className="mb-4">
        <h1 className="text-2xl font-bold">Reports & Analytics</h1>
        <p className="text-sm text-gray-600">
          View insights, trends, and performance metrics
        </p>
      </header>

      {/* Section 1: Faculty Load Insights */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold">Faculty Load Insights</h2>
        <p className="text-sm text-gray-600">
          Current state monitoring and historical data
        </p>

        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {INSIGHT_CARDS.map((c, i) => renderCard(c, `insight-${i}`))}
        </div>
      </section>

      {/* Section 2: Forecast & Risk Analytics */}
      <section>
        <h2 className="text-xl font-semibold">Forecast & Risk Analytics</h2>
        <p className="text-sm text-gray-600">
          Forecasting and scenario planning
        </p>

        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FORECAST_CARDS.map((c, i) => renderCard(c, `forecast-${i}`))}
        </div>
      </section>
    </div>
  );
}
