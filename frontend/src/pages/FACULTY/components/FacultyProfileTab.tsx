// frontend/src/pages/FACULTY/components/FacultyProfileTab.tsx
import React, { useEffect, useMemo, useState } from "react";
import { BookOpen as SyllabusIcon, Edit, Check, XCircle, BadgeCheck, Layers, X } from "lucide-react";

import SelectBox from "@/component/SelectBox";
import HistoryMain from "../FACULTY_History";
import DeloadingsContent from "../FACULTY_Deloadings";

import {
  getFacultyOverviewOptions,
  updateFacultyOverviewProfile,
  getFacultyPreferencesList,
} from "@/api";

export type ToastKind = "success" | "error" | "info" | "warning";

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

// Shared chip style for course codes shown under Qualified KACs.
// Requested to match the light-green tone used for "This term:" chips in FACULTY_History.
const QUALIFIED_KAC_COURSE_CHIP =
  "inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-900";

const lightRedBtn =
  "inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 hover:bg-red-100";

/* =========================================
   Faculty Profile Tab (REDESIGNED)
   - Not an information dump: show actionable "guardrails" + qualifications
   ========================================= */
function ProfileSectionTitle({
  icon: Icon,
  children,
}: {
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-emerald-800">
      <Icon className="h-4 w-4" />
      {children}
    </div>
  );
}

export function FacultyProfileTab({
  faculty,
  userId,
  onReload,
  pushToast,
}: {
  faculty: any;
  userId: string;
  onReload: () => Promise<void>;
  pushToast: (kind: ToastKind, message: string, title?: string) => void;
}) {
  const [editing, setEditing] = useState<null | "name" | "employment" | "certs" | "kacs">(null);
  const [saving, setSaving] = useState(false);
  const [kacOptions, setKacOptions] = useState<any[]>([]);
  const [kacQuery, setKacQuery] = useState("");
  const [preferredKacIds, setPreferredKacIds] = useState<string[]>([]);

  const [draftName, setDraftName] = useState<{ first_name: string; last_name: string }>(() => ({
    first_name: String(faculty?.first_name || "").trim(),
    last_name: String(faculty?.last_name || "").trim(),
  }));
  const [draftEmployment, setDraftEmployment] = useState<string>(() =>
    String(faculty?.employment_type || "").trim()
  );
  const [draftCerts, setDraftCerts] = useState<string>(() =>
    (Array.isArray(faculty?.certifications) ? faculty.certifications : []).join(", ")
  );
  const [draftKacs, setDraftKacs] = useState<string[]>(() => {
    const ids = faculty?.qualified_kac_ids;
    if (Array.isArray(ids)) return ids.map((x: any) => String(x)).filter(Boolean);
    const fromDetails = Array.isArray(faculty?.qualified_kacs)
      ? faculty.qualified_kacs.map((k: any) => String(k?.kac_id || "")).filter(Boolean)
      : [];
    return fromDetails;
  });

  useEffect(() => {
    if (editing) return;
    setDraftName({
      first_name: String(faculty?.first_name || "").trim(),
      last_name: String(faculty?.last_name || "").trim(),
    });
    setDraftEmployment(String(faculty?.employment_type || "").trim());
    setDraftCerts((Array.isArray(faculty?.certifications) ? faculty.certifications : []).join(", "));
    // Keep the KAC selection in sync with whatever shape the backend returns.
    // - Newer shape: `qualified_kac_ids: string[]`
    // - Current profile payload: `qualified_kacs: {kac_id,...}[]`
    const ids = faculty?.qualified_kac_ids;
    if (Array.isArray(ids)) {
      setDraftKacs(ids.map((x: any) => String(x)).filter(Boolean));
    } else if (Array.isArray(faculty?.qualified_kacs)) {
      setDraftKacs(
        faculty.qualified_kacs
          .map((k: any) => String(k?.kac_id || "").trim())
          .filter(Boolean)
      );
    } else {
      setDraftKacs([]);
    }
  }, [faculty, editing]);

  useEffect(() => {
    // Load KAC options once for editing.
    (async () => {
      try {
        const res = await getFacultyOverviewOptions(userId);
        if (res?.ok && Array.isArray(res?.kacs)) setKacOptions(res.kacs);
      } catch {
        // best-effort
      }
    })();
  }, [userId]);

  useEffect(() => {
    // Best-effort: pull the latest submitted preferences so we can merge preferred_kacs
    // into the Qualified KACs display (requested UX).
    (async () => {
      try {
        const res = await getFacultyPreferencesList(userId);
        const prefs: any[] = Array.isArray(res?.preferences) ? res.preferences : [];
        if (!prefs.length) {
          setPreferredKacIds([]);
          return;
        }

        // Prefer a finished submission if present; otherwise fall back to most recent.
        const pref = prefs.find((p) => Boolean(p?.is_finished)) || prefs[0];
        const raw = Array.isArray(pref?.preferred_kacs) ? pref.preferred_kacs : [];

        const ids = raw
          .map((k: any) => {
            if (typeof k === "string") return k.trim();
            return String(k?.kac_id || k?.kacId || "").trim();
          })
          .filter(Boolean);

        setPreferredKacIds(Array.from(new Set(ids)));
      } catch {
        // best-effort
        setPreferredKacIds([]);
      }
    })();
  }, [userId]);

  const save = async (kind: "name" | "employment" | "certs" | "kacs") => {
    if (!userId) return;
    try {
      setSaving(true);
      const payload: any = {};
      if (kind === "name") {
        payload.first_name = draftName.first_name.trim();
        payload.last_name = draftName.last_name.trim();
        if (!payload.first_name || !payload.last_name) {
          pushToast("warning", "Please provide both first name and last name.");
          return;
        }
      }
      if (kind === "employment") {
        payload.employment_type = draftEmployment;
        if (!payload.employment_type) {
          pushToast("warning", "Please select an employment type.");
          return;
        }
      }
      if (kind === "certs") {
        const list = draftCerts
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        payload.certifications = list;
      }
      if (kind === "kacs") {
        const nextQualified = (draftKacs || []).map((x) => String(x).trim()).filter(Boolean);
        payload.qualified_kacs = nextQualified;

        // IMPORTANT FIX (UI): "My Profile" displays a merged list of Qualified + Preferred KACs.
        // If the user removes a KAC from Qualified, and that KAC also exists in Preferred,
        // it should disappear immediately to avoid confusion.
        const prevIdsRaw = faculty?.qualified_kac_ids;
        const prevFromIds = Array.isArray(prevIdsRaw)
          ? prevIdsRaw.map((x: any) => String(x).trim()).filter(Boolean)
          : [];
        const prevFromDetails = Array.isArray(faculty?.qualified_kacs)
          ? faculty.qualified_kacs
              .map((k: any) => String(k?.kac_id || k?.kacId || "").trim())
              .filter(Boolean)
          : [];
        const prevQualified = prevFromIds.length ? prevFromIds : prevFromDetails;
        const removed = new Set(prevQualified.filter((id: string) => !nextQualified.includes(id)));
        if (removed.size) {
          setPreferredKacIds((prev) => (prev || []).filter((id) => !removed.has(String(id).trim())));
        }
      }

      const res = await updateFacultyOverviewProfile(userId, payload);
      if (!res?.ok) throw new Error(res?.detail || "Failed to save.");
      await onReload();
      setEditing(null);
      pushToast("success", "Saved.");
    } catch (e: any) {
      pushToast("error", e?.message || "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const toggleKac = (id: string) => {
    const norm = String(id || "").trim();
    if (!norm) return;
    setDraftKacs((prev) => {
      const s = new Set((prev || []).map((x) => String(x || "").trim()).filter(Boolean));
      if (s.has(norm)) s.delete(norm);
      else s.add(norm);
      return Array.from(s);
    });
  };

  const employmentLabel = (v: any) => {
    const s = String(v ?? "").trim().toUpperCase();
    if (s === "FT" || s === "FULLTIME" || s === "FULL-TIME") return "Full-time";
    if (s === "PT" || s === "PARTTIME" || s === "PART-TIME") return "Part-time";
    return s || "—";
  };

  const formatHireDate = (v: any) => {
    const rawVal = v ?? "";
    const s = String(rawVal).trim();
    if (!s) return "—";
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "2-digit" }).format(d);
    }
    return s;
  };


  const email = String(faculty?.email || faculty?.email_address || faculty?.emailAddress || "").trim();

  // Pills intentionally kept empty for now; key profile attributes are shown as cards on the right.
  const pills: { label: string; value: string }[] = [];

  const guardrails: { key: "employment" | "teaching"; label: string; value: React.ReactNode }[] = [
    { key: "employment", label: "Employment", value: employmentLabel(faculty?.employment_type) },
    {
      key: "teaching",
      label: "Teaching experience",
      value: (
        <div className="flex flex-col leading-tight">
          <span>{faculty?.teaching_years != null ? `${faculty.teaching_years} yrs` : "—"}</span>
          <span className="text-sm font-medium text-slate-600">Hire date: {formatHireDate(faculty?.hire_date)}</span>
        </div>
      ),
    },
  ];

  const certifications: any[] = Array.isArray(faculty?.certifications) ? faculty.certifications : [];

  const mergedKacs: any[] = useMemo(() => {
    const base: any[] = Array.isArray(faculty?.qualified_kacs) ? faculty.qualified_kacs : [];
    const byId = new Map<string, any>();

    for (const k of base) {
      const id = String(k?.kac_id || k?.kacId || "").trim();
      if (!id) continue;
      // Ensure a consistent `courses` shape.
      // If profile payload doesn't include expanded courses, fall back to options.
      const opt = (kacOptions || []).find((o: any) => String(o?.kac_id || "").trim() === id);
      const courses =
        Array.isArray((k as any)?.courses) && (k as any).courses.length > 0
          ? (k as any).courses
          : Array.isArray((opt as any)?.courses)
            ? (opt as any).courses
            : [];

      byId.set(id, {
        ...k,
        kac_id: id,
        courses,
        from_preferences: false,
      });
    }

    for (const idRaw of preferredKacIds || []) {
      const id = String(idRaw || "").trim();
      if (!id || byId.has(id)) continue;
      const opt = (kacOptions || []).find((o: any) => String(o?.kac_id || "").trim() === id);
      byId.set(id, {
        kac_id: id,
        kac_name: opt?.kac_name || id,
        kac_code: opt?.kac_code || "",
        program_area: opt?.program_area || "",
        // Preferred KACs must show the same course list as qualified KACs.
        courses: Array.isArray((opt as any)?.courses) ? (opt as any).courses : [],
        from_preferences: true,
      });
    }

    const arr = Array.from(byId.values());
    try {
      arr.sort((a: any, b: any) => {
        const pa = String(a?.program_area || "");
        const pb = String(b?.program_area || "");
        if (pa !== pb) return pa.localeCompare(pb);
        const na = String(a?.kac_name || "");
        const nb = String(b?.kac_name || "");
        return na.localeCompare(nb);
      });
    } catch {
      // ignore
    }
    return arr;
  }, [faculty, preferredKacIds, kacOptions]);

  const fullName = faculty?.full_name || faculty?.fullName || "—";
  const department = faculty?.department || "—";
  const initials = String(fullName)
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]?.toUpperCase())
    .join("") || "—";

  const [recordsTab, setRecordsTab] = useState<"Teaching history" | "Deloadings">(
    "Teaching history"
  );

  const SegBtn = ({
    active,
    children,
    onClick,
  }: {
    active: boolean;
    children: React.ReactNode;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={cls(
        // Match the Calendar/List segmented control styling in Faculty Schedule
        "inline-flex h-8 items-center justify-center rounded-lg px-4 text-sm font-semibold transition",
        "focus:outline-none focus:ring-2 focus:ring-emerald-600/30",
        active ? "bg-emerald-700 text-white shadow-sm" : "text-neutral-700 hover:bg-white"
      )}
    >
      {children}
    </button>
  );

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        <div className="flex min-w-0 flex-1 items-center gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-sm font-bold text-slate-800">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-lg font-semibold text-slate-900">{fullName}</div>
              <button
                type="button"
                className="rounded-lg p-1 hover:bg-black/5"
                title="Edit name"
                onClick={() => setEditing((p) => (p === "name" ? null : "name"))}
              >
                <Edit className="h-4 w-4 text-slate-600" />
              </button>
            </div>

            {editing === "name" && (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  value={draftName.first_name}
                  onChange={(e) => setDraftName((p) => ({ ...p, first_name: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  placeholder="First name"
                />
                <input
                  value={draftName.last_name}
                  onChange={(e) => setDraftName((p) => ({ ...p, last_name: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  placeholder="Last name"
                />
                <div className="flex items-center gap-2 sm:col-span-2">
                  <button
                    type="button"
                    onClick={() => save("name")}
                    disabled={saving}
                    className={cls(
                      "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold",
                      saving
                        ? "cursor-default border-slate-200 bg-slate-100 text-slate-500"
                        : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a49]"
                    )}
                  >
                    <Check className="h-4 w-4" />
                    <span>Save</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className={lightRedBtn}
                  >
                    <XCircle className="h-4 w-4" />
                    <span>Cancel</span>
                  </button>
                </div>
              </div>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
              <span className="font-medium text-slate-700">{department}</span>
              {email ? (
                <>
                  <span className="text-slate-300">•</span>
                  <span className="truncate">{email}</span>
                </>
              ) : null}
            </div>
            {pills.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {pills.map((p) => (
                  <span
                    key={p.label}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-700"
                    title={p.label}
                  >
                    <span className="text-slate-500">{p.label}:</span>
                    <span className="font-medium text-slate-800">{p.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:w-[520px]">
          {guardrails.map((g) => (
            <div
              key={g.key}
              className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-emerald-800">
                  {g.key === "employment" ? (
                    <BadgeCheck className="h-4 w-4" />
                  ) : (
                    <SyllabusIcon className="h-4 w-4" />
                  )}
                  <span>{g.label}</span>
                </div>
                {g.key === "employment" && (
                  <button
                    type="button"
                    className="rounded-lg p-1 hover:bg-black/5"
                    title="Edit employment"
                    onClick={() => setEditing((cur) => (cur === "employment" ? null : "employment"))}
                  >
                    <Edit className="h-4 w-4 text-slate-600" />
                  </button>
                )}
              </div>
             <div className="mt-2 text-lg font-semibold text-slate-900">{g.value}</div>

              {g.key === "employment" && editing === "employment" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {/* Keep the dropdown narrow so it won't collide with the action buttons */}
                  <div className="w-[180px] sm:w-[220px] max-w-full">
                    <SelectBox
                      value={(() => {
                        const s = String(draftEmployment || "").trim();
                        if (!s) return "Select…";
                        if (s === "FT" || s === "Full-time") return "Full-time";
                        if (s === "PT" || s === "Part-time") return "Part-time";
                        return s;
                      })()}
                      onChange={(v) => {
                        if (v === "Full-time") setDraftEmployment("FT");
                        else if (v === "Part-time") setDraftEmployment("PT");
                        else if (v === "Select…") setDraftEmployment("");
                        else setDraftEmployment(v);
                      }}
                      options={["Select…", "Full-time", "Part-time"]}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => save("employment")}
                    disabled={saving}
                    className={cls(
                      "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold",
                      saving
                        ? "cursor-default border-slate-200 bg-slate-100 text-slate-500"
                        : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a49]"
                    )}
                  >
                    <Check className="h-4 w-4" />
                    <span>Save</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className={lightRedBtn}
                  >
                    <XCircle className="h-4 w-4" />
                    <span>Cancel</span>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Qualifications */}
      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Certifications */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <ProfileSectionTitle icon={BadgeCheck}>Certifications</ProfileSectionTitle>
              <div className="mt-1 text-xs text-slate-500">Helps match you to specialized courses.</div>
            </div>
            <button
              type="button"
              className="rounded-lg p-1 hover:bg-black/5"
              title="Edit certifications"
              onClick={() => setEditing((p) => (p === "certs" ? null : "certs"))}
            >
              <Edit className="h-4 w-4 text-slate-600" />
            </button>
          </div>

          {editing === "certs" && (
            <div className="mt-3">
              <div className="text-xs font-medium text-slate-700">Comma-separated</div>
              <input
                value={draftCerts}
                onChange={(e) => setDraftCerts(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                placeholder="e.g., AWS CCP, Scrum Master"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => save("certs")}
                  disabled={saving}
                  className={cls(
                    "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold",
                    saving
                      ? "cursor-default border-slate-200 bg-slate-100 text-slate-500"
                      : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a49]"
                  )}
                >
                  <Check className="h-4 w-4" />
                  <span>Save</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className={lightRedBtn}
                >
                  <XCircle className="h-4 w-4" />
                  <span>Cancel</span>
                </button>
              </div>
            </div>
          )}

          {certifications.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
              No certifications on file.
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {certifications.map((c, idx) => (
                <span
                  key={`${idx}-${String(c)}`}
                  className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-800"
                >
                  {typeof c === "string" ? c : c?.name || c?.title || JSON.stringify(c)}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Qualified KACs */}
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <ProfileSectionTitle icon={Layers}>Qualified KACs</ProfileSectionTitle>
              <div className="mt-1 text-xs text-slate-500">Your coverage map (areas you can be assigned to).</div>
            </div>
            <button
              type="button"
              className="rounded-lg p-1 hover:bg-black/5"
              title="Edit qualified KACs"
              onClick={() => setEditing((p) => (p === "kacs" ? null : "kacs"))}
            >
              <Edit className="h-4 w-4 text-slate-600" />
            </button>
          </div>

          {editing === "kacs" && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm font-semibold uppercase tracking-wide text-emerald-800">Select KACs</div>
                <div className="relative w-full sm:w-[260px]">
                  <input
                    value={kacQuery}
                    onChange={(e) => setKacQuery(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-9 text-sm"
                    placeholder="Search by KAC or Course code…"
                  />
                  {kacQuery.trim() ? (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-black/5"
                      aria-label="Clear search"
                      title="Clear"
                      onClick={() => setKacQuery("")}
                    >
                      <X className="h-4 w-4 text-slate-600" />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 max-h-[260px] overflow-auto rounded-lg border border-slate-200 bg-white">
                {kacOptions
                  .filter((k) => {
                    const q = kacQuery.trim().toLowerCase();
                    if (!q) return true;
                    const courseHay = Array.isArray((k as any)?.courses)
                      ? (k as any).courses
                          .map((c: any) => `${c?.course_code || ""} ${c?.course_title || ""}`)
                          .join(" ")
                      : "";
                    const s = `${k?.kac_name || ""} ${k?.kac_code || ""} ${k?.program_area || ""} ${courseHay}`.toLowerCase();
                    return s.includes(q);
                  })
                  .map((k) => {
                    const id = String(k?.kac_id || "").trim();
                    const checked = draftKacs.includes(id);
                    return (
                      <label
                        key={id}
                        className="flex cursor-pointer items-start gap-3 border-b border-slate-100 px-3 py-2 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleKac(id)}
                          className="mt-1"
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-900">
                            {k?.kac_name || "—"}
                            {k?.kac_code ? (
                              <span className="ml-2 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">
                                {k.kac_code}
                              </span>
                            ) : null}
                          </div>
                          {/* Program label removed (redundant for faculty view) */}
                          {Array.isArray((k as any)?.courses) && (k as any).courses.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {(k as any).courses.map((c: any) => (
                                <span
                                  key={c.course_id || `${c.course_code}-${c.course_title}`}
                                  className={QUALIFIED_KAC_COURSE_CHIP}
                                  title={c.course_title || ""}
                                >
                                  <span className="font-semibold">{c.course_code || "—"}</span>
                                  <span className="text-emerald-300">•</span>
                                  <span className="max-w-[260px] truncate text-emerald-800/90">{c.course_title || "—"}</span>
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => save("kacs")}
                  disabled={saving}
                  className={cls(
                    "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold",
                    saving
                      ? "cursor-default border-slate-200 bg-slate-100 text-slate-500"
                      : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a49]"
                  )}
                >
                  <Check className="h-4 w-4" />
                  <span>Save</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className={lightRedBtn}
                >
                  <XCircle className="h-4 w-4" />
                  <span>Cancel</span>
                </button>
                <div className="ml-auto text-xs text-slate-600">
                  Selected: <span className="font-semibold text-slate-900">{draftKacs.length}</span>
                </div>
              </div>
            </div>
          )}

          {mergedKacs.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
              No KAC qualifications on file.
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {mergedKacs.map((k) => (
                <details key={k.kac_id || k.kac_code || k.kac_name} className="group rounded-xl border border-slate-200 bg-white">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{k.kac_name || "—"}</span>
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700">
                          {k.kac_code || k.kac_id || "KAC"}
                        </span>
                        {k?.from_preferences ? (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                            From Preferences
                          </span>
                        ) : null}
                      </div>
                      {/* Program label removed (redundant for faculty view) */}
                    </div>
                    <span className="text-xs text-slate-500 transition group-open:rotate-180">▾</span>
                  </summary>

                  <div className="border-t border-slate-200 px-3 py-3">
                    {(k.courses || []).length === 0 ? (
                      <div className="text-sm text-slate-600">No items listed.</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {(k.courses || []).map((c: any) => (
                          <span
                            key={c.course_id || `${c.course_code}-${c.course_title}`}
                            className={QUALIFIED_KAC_COURSE_CHIP}
                            title={c.course_title || ""}
                          >
                            <span className="font-semibold">{c.course_code || "—"}</span>
                            <span className="text-emerald-300">•</span>
                            <span className="max-w-[280px] truncate text-emerald-800/90">{c.course_title || "—"}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Records */}
      <div className="mt-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-sm font-semibold uppercase tracking-wide text-emerald-800">Other Records</div>
              <div className="mt-1 text-xs text-slate-500">
                View your teaching history and deloadings.
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="inline-flex rounded-xl border border-neutral-200 bg-neutral-50 p-1">
                <SegBtn
                  active={recordsTab === "Teaching history"}
                  onClick={() => setRecordsTab("Teaching history")}
                >
                  Teaching history
                </SegBtn>
                <SegBtn active={recordsTab === "Deloadings"} onClick={() => setRecordsTab("Deloadings")}>
                  Deloadings
                </SegBtn>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="mt-4">
            {recordsTab === "Teaching history" ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50">
                <div className="flex flex-col gap-1 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-wide text-emerald-800">Teaching history</div>
                    <div className="mt-0.5 text-xs text-slate-600">
                      Use search to quickly find a course; switch AY to browse older terms.
                    </div>
                  </div>
             
                </div>
                <div className="max-h-[480px] overflow-auto p-2">
                  <HistoryMain embedded />
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50">
                <div className="flex flex-col gap-1 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-wide text-emerald-800">Deloadings</div>
                    <div className="mt-0.5 text-xs text-slate-600">
                      See your recorded deloading arrangements and their details.
                    </div>
                  </div>
                
                </div>
                <div className="max-h-[480px] overflow-auto p-2">
                  <DeloadingsContent embedded />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}