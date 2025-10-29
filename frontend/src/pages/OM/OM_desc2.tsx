// OM_desc2.tsx
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { fetchCourseProfile } from "@/api";

// -----------------------------
// Types matching backend payload
// -----------------------------
type QualifiedFaculty = {
  faculty_id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  source?: string; 
};


type PastTeach = {
  course_code?: string[];    
  section_id?: string;
  section_code?: string;
  term_id?: string;          
  acad_year_start?: number;   
  term_number?: number;    
};

type PastInstructor = {
  faculty_id: string;
  first_name?: string;
  last_name?: string;   
  email?: string;
  count?: number;
  sections: PastTeach[];
};

type SimplePref = { faculty_id: string; name?: string };

type PrefEntry = { faculty_id: string; first_name?: string; last_name?: string; email?: string };

type CourseProfile = {
  course_id: string;
  course_code?: string[]; // array per your schema
  title?: string;
  qualified_faculty?: QualifiedFaculty[];
  past_instructors?: PastInstructor[];
  preferences?: string | SimplePref[]; // "N/A" OR array
};

// -----------------------------
// Helpers
// -----------------------------
function joinCodes(codes?: string[]): string {
  return codes && codes.length ? codes.join(", ") : "";
}

function fmtAY(start?: number): string {
  if (typeof start !== "number") return "AY —";
  return `AY ${start}-${start + 1}`;
}

function fmtTerm(n?: number): string {
  return typeof n === "number" ? `Term ${n}` : "Term —";
}

// -----------------------------
// Component
// -----------------------------
export default function OM_DescPage2() {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<CourseProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setErr(null);
    setData(null);
    try {
      const res = await fetchCourseProfile(q);
      setData(res as CourseProfile);
    } catch (e: any) {
      setErr(e?.message || "Failed to fetch course profile");
    } finally {
      setLoading(false);
    }
  }

  const courseHeader = `COURSE: ['${data?.course_code?.length ? joinCodes(data.course_code) : data?.course_id ?? ""}'] – ${data?.title || "No title listed"
    }`;

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Course Profile by Search</h1>
        <Link to="/om/home">← Back to OM Home</Link>
      </div>

      {/* Search Bar */}
      <form onSubmit={handleSearch} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Enter course ID or course code (e.g., NSCOM01)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={loading} style={{ padding: "8px 16px" }}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {/* Error */}
      {err && (
        <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 8 }}>
          {err}
        </div>
      )}

      {/* Result */}
      {data && (
        <div
          style={{
            background: "#111",
            color: "#eee",
            padding: 16,
            borderRadius: 8,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
          }}
        >
          {/* Header lines (template strings for simple one-liners) */}
          {courseHeader}
          <br />
          <div style={{ marginTop: 8 }}>
            {`- Qualified Faculty:`}
            {(!data?.qualified_faculty || data.qualified_faculty.length === 0) && (
              <div> None listed</div>
            )}

            {data?.qualified_faculty?.map((qf) => (
              <div key={qf.faculty_id} style={{ marginTop: 8 }}>
                {/* Faculty header line */}
                <div>
                  • {qf.faculty_id} — {(qf.last_name || "—")}, {(qf.first_name || "—")}
                  {qf.email ? ` • ${qf.email}` : " • No email on record"}
                </div>

                {/* Reason(s) listed on new lines */}
                {qf.source &&
                  qf.source.split("&").map((reason, i) => (
                    <div key={i} style={{ marginLeft: 18 }}>
                      - {reason.trim()}
                    </div>
                  ))}
              </div>
            ))}
          </div>

          {/* Past Instructors — detailed list */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700 }}>Past Instructors:</div>
            {(!data.past_instructors || data.past_instructors.length === 0) && (
              <div>None listed</div>
            )}

            {data.past_instructors?.map((pi) => (
              <div key={pi.faculty_id} style={{ marginTop: 6 }}>
                {/* Header line: FACID — Last, First (N sections) */}
                <div>
                  • {pi.faculty_id}
                  {" — "}
                  {(pi.last_name || "—")}, {(pi.first_name || "—")}
                  {typeof pi.count === "number"
                    ? ` (${pi.count} section${pi.count === 1 ? "" : "s"})`
                    : ""}
                  {pi.email ? ` • ${pi.email}` : " • No email on record"}
                </div>

                {/* Each section row */}
                {pi.sections?.map((s, idx) => {
                  const ayText = fmtAY(s.acad_year_start);
                  const cc =
                    (s.course_code && s.course_code.length
                      ? joinCodes(s.course_code)
                      : joinCodes(data.course_code)) || "";
                  const termText = fmtTerm(s.term_number);

                  return (
                    <div key={`${pi.faculty_id}-${s.section_id ?? idx}`} style={{ marginLeft: 18 }}>
                      - [{cc}] {s.section_code || s.section_id || "—"} • {ayText} • {termText} ({s.term_id || "—"})
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <br />
          {/* Preferences (current term) */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700 }}>Preferences:</div>
            {typeof data?.preferences === "string" && <div>{data.preferences}</div>}

            {Array.isArray(data?.preferences) && data!.preferences.length === 0 && (
              <div>N/A</div>
            )}

            {Array.isArray(data?.preferences) && data!.preferences.length > 0 && (
              <div>
                {(data!.preferences as PrefEntry[]).map((p) => (
                  <div key={p.faculty_id}>
                    • {p.faculty_id} — {p.last_name || "—"}, {p.first_name || "—"}
                    {p.email ? ` • ${p.email}` : ""}
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      )}

      {/* Empty state */}
      {!data && !loading && !err && (
        <div style={{ opacity: 0.7 }}>Search a course to see its profile.</div>
      )}
    </div>
  );
}
