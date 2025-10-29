import React, { useState } from "react";
import { Link } from "react-router-dom";
import { fetchCourseProfile } from "@/api"; 

type SimpleFaculty = {
  faculty_id: string;
  name?: string;
};

type SimpleCourseProfile = {
  course_id: string;
  course_code?: string;
  title?: string;
  qualified_faculty?: SimpleFaculty[];
  past_instructors?: SimpleFaculty[];
  preferences?: string;
};

export default function OM_DescPage2() {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SimpleCourseProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setErr(null);
    setData(null);

    try {
      const result = await fetchCourseProfile(query.trim());
      setData(result);
    } catch (e: any) {
      setErr(e?.message || "Failed to fetch course profile");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Course Profile by Search</h1>
        <Link to="/om/home">← Back to OM Home</Link>
      </div>

      <form onSubmit={handleSearch} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Enter course ID or course code (e.g., CSC511C)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={loading} style={{ padding: "8px 16px" }}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {err && (
        <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 8, marginBottom: 12 }}>
          {err}
        </div>
      )}

      {data && (
        <div
          style={{
            background: "#111",
            color: "#eee",
            padding: 16,
            borderRadius: 8,
            fontFamily: "monospace",
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
          }}
        >
{`COURSE: ['${data.course_code || data.course_id}'] – ${data.title || "No title listed"}
- Qualified Faculty: ${
  data.qualified_faculty?.length
    ? data.qualified_faculty.map((f) => f.name || f.faculty_id).join(", ")
    : "None listed"
}
- Past Instructors: ${
  data.past_instructors?.length
    ? data.past_instructors.map((p) => p.name || p.faculty_id).join(", ")
    : "None listed"
}
- Preferences/Availability: ${data.preferences || "N/A"}`}
        </div>
      )}

      {!data && !loading && !err && (
        <div style={{ opacity: 0.7 }}>Search a course to see its profile.</div>
      )}
    </div>
  );
}
