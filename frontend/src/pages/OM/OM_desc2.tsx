import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchCourseProfiles } from "../../api";

type Id = string;

type Section = {
  section_id: Id;
  code?: string;
  schedule_summary?: string;
};

type UserLite = {
  user_id: Id;
  first_name?: string;
  last_name?: string;
  email?: string;
};

type FacultyLite = {
  faculty_id: Id;
  user?: UserLite;
  employment_type?: "FT" | "PT";
  campus_id?: Id | null;
};

type CourseProfile = {
  course_id: Id;
  course_code: string;
  title: string;
  units?: number;
  campus_id?: Id | null;
  required_kacs: Id[];
  sections_next: Section[];
  qualified_faculty: FacultyLite[];
  past_instructors: FacultyLite[];
  available_now: FacultyLite[];
};

export default function OM_DescPage2() {
  const [termId, setTermId] = useState<string>("TERM0014");
  const [data, setData] = useState<CourseProfile[] | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchCourseProfiles(termId);
        if (!ignore) setData(res);
      } catch (e: any) {
        if (!ignore) setError(e?.message ?? "Failed to fetch");
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [termId]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data;
    return data.filter((c) =>
      [c.course_code, c.title]
        .filter(Boolean)
        .some((s) => (s ?? "").toLowerCase().includes(needle))
    );
  }, [data, q]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Course Profiles</h1>
        <Link to="/om/home">← Back to OM Home</Link>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto auto",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <input
          placeholder="Search course code or title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ padding: 8, borderRadius: 6, border: "1px solid #ddd" }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>Term</span>
          <input
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
            style={{ padding: 8, borderRadius: 6, border: "1px solid #ddd", width: 140 }}
          />
        </label>
        <span style={{ fontSize: 12, color: "#666" }}>
          {loading ? "Loading…" : data ? `${filtered.length} courses` : ""}
        </span>
      </div>

      {error && (
        <div style={{ background: "#fee", border: "1px solid #fbb", padding: 12, borderRadius: 8, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {filtered.map((c) => (
          <CourseCard key={c.course_id} item={c} />
        ))}
      </div>

      {!loading && data && data.length === 0 && (
        <div style={{ color: "#666", padding: 24, textAlign: "center" }}>No results yet. Try a different term.</div>
      )}
    </div>
  );
}

function CourseCard({ item }: { item: CourseProfile }) {
  const { course_code, title, sections_next, required_kacs, qualified_faculty, past_instructors, available_now } = item;

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: "#777" }}>{course_code}</div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{title}</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Pill>{sections_next?.length ?? 0} sections (next)</Pill>
          <Pill>{required_kacs?.length ?? 0} required KACs</Pill>
          <Pill>{qualified_faculty?.length ?? 0} qualified</Pill>
          <Pill>{available_now?.length ?? 0} available now</Pill>
          <Pill>{past_instructors?.length ?? 0} taught before</Pill>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 12 }}>
        <Panel title="Sections (next term)">
          {sections_next?.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {sections_next.map((s) => (
                <li key={s.section_id}>
                  <code>{s.code ?? s.section_id}</code>
                  {s.schedule_summary ? ` • ${s.schedule_summary}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>—</Empty>
          )}
        </Panel>

        <Panel title="Required KACs">
          {required_kacs?.length ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {required_kacs.map((k) => (
                <Pill key={k}>{k}</Pill>
              ))}
            </div>
          ) : (
            <Empty>—</Empty>
          )}
        </Panel>

        <Panel title="Available Now">
          <PersonsList items={available_now} />
        </Panel>

        <Panel title="Past Instructors">
          <PersonsList items={past_instructors} />
        </Panel>
      </div>
    </div>
  );
}

function PersonsList({ items }: { items?: FacultyLite[] }) {
  if (!items?.length) return <Empty>—</Empty>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {items.map((f) => (
        <li key={f.faculty_id}>
          {renderName(f.user)}{" "}
          <span style={{ color: "#888" }}>({f.employment_type ?? "—"})</span>
        </li>
      ))}
    </ul>
  );
}

function renderName(u?: UserLite) {
  if (!u) return "Unknown";
  const first = u.first_name ?? "";
  const last = u.last_name ?? "";
  const name = `${first} ${last}`.trim();
  return name || u.user_id || "Unknown";
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        border: "1px solid #eee",
        padding: "4px 8px",
        borderRadius: 999,
        fontSize: 12,
        background: "#fafafa",
      }}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "#888" }}>{children}</div>;
}
