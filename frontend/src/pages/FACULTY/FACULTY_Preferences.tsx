// frontend/src/pages/FACULTY/Faculty_Preferences.tsx
import React, { useEffect, useMemo, useState } from "react";
import { CalendarDays, MapPin, Monitor, BookOpen, Settings, Plus, Check, PencilLine } from "lucide-react";

import {
  getFacultyPreferencesList,
  getFacultyPreferencesOptions,
  submitFacultyPreferences,
} from "../../api";

/* ---------- tiny utils (same style as FAC_History) ---------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

const TAG_STYLES = {
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  gray: "bg-gray-50 text-gray-600 border-gray-200",
} as const;

function Tag({
  children,
  tone = "emerald",
}: {
  children: React.ReactNode;
  tone?: keyof typeof TAG_STYLES;
}) {
  return (
    <span
      className={cls(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        TAG_STYLES[tone]
      )}
    >
      {children}
    </span>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[12.5px] font-medium text-gray-500">{children}</div>;
}

function FieldValue({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-[14.5px] text-gray-900">{children}</div>;
}

function SectionCard({
  icon,
  title,
  children,
  className = "",
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cls("rounded-xl border border-gray-200 bg-white p-5", className)}>
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
          {icon}
        </span>
        <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
      </div>
      {children}
    </section>
  );
}

/* =========================================================
   ==============  DATA TYPES (UI local state)  ============
   ========================================================= */
type CourseLite = { course_id: string; course_code?: string | string[]; course_title?: string };

type Options = {
  days: string[];
  timeBands: string[];
  kacs: { kac_id: string; kac_code?: string; kac_name?: string }[];
  campuses: { campus_id: string; campus_name: string }[];
  deloading_types: { deloadingtype_id: string; type: string }[];
  coursesByKac?: Record<string, CourseLite[]>;
};

type PrefDoc = {
  pref_id?: string;
  faculty_id?: string;
  preferred_units?: number;
  availability_days?: string[]; // stored compressed e.g. ["MTH","TF"]
  preferred_times?: string[];
  preferred_kacs?: { kac_id?: string; kac_code?: string; kac_name?: string }[]; // enriched from API
  preferred_courses?: CourseLite[]; // enriched by backend (codes/titles)
  mode?: { mode?: string; campus_id?: string; campus_name?: string } | null;
  deloading_data?: { deloading_type: string; units: string; deloading_type_name?: string }[];
  notes?: string;
  has_new_prep?: boolean;
  is_finished?: boolean;
  submitted_at?: string;
  term_id?: string;
  status?: string;
};

type RowDeload = { type?: string; adminType?: string; units?: number | string };

type FormState = {
  prefUnits: number | string;
  maxUnits: number | string; // display only; not sent
  days: string[];
  timeSlots: string[];
  kac: string[]; // store selected KAC names for display; map to IDs on submit
  preferredCourses: string[]; // store course_id(s)
  deliveryMode?: "Face-to-Face Only" | "Hybrid" | "Fully Online";
  campus?: string;
  remarks?: string;
  deloadings: RowDeload[];
  noDeloading?: boolean;
};

/* =========================================================
   ====================  HELPERS  ==========================
   ========================================================= */

// DB stores sequences like ["MTH", "TF"]; UI needs full names
const LETTER_TO_DAY: Record<string, string> = {
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  H: "Thursday",
  F: "Friday",
  S: "Saturday",
};
const DAY_TO_LETTER: Record<string, string> = Object.fromEntries(Object.entries(LETTER_TO_DAY).map(([k, v]) => [v, k]));
const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function expandDays(seq: string[] = []): string[] {
  const out: string[] = [];
  (seq || []).forEach((chunk) => {
    (chunk || "").split("").forEach((ch) => {
      const name = LETTER_TO_DAY[ch] || ch;
      if (name && !out.includes(name)) out.push(name);
    });
  });
  return out.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
}

function compressDays(full: string[]): string[] {
  const letters = [...new Set(full.map((d) => DAY_TO_LETTER[d] || d))]
    .filter(Boolean)
    .sort((a, b) => "MTWHFS".indexOf(a) - "MTWHFS".indexOf(b));
  const out: string[] = [];
  let buf: string[] = [];
  const idx = (x: string) => "MTWHFS".indexOf(x);
  letters.forEach((ch) => {
    if (!buf.length) {
      buf.push(ch);
      return;
    }
    if (idx(ch) - idx(buf[buf.length - 1]) === 1) {
      buf.push(ch);
    } else {
      out.push(buf.join(""));
      buf = [ch];
    }
  });
  if (buf.length) out.push(buf.join(""));
  return out;
}

function toModeLabel(code?: string) {
  const C = (code || "").toUpperCase();
  if (C === "F2F") return "Face-to-Face Only";
  if (C === "ONL") return "Fully Online";
  if (C === "HYB") return "Hybrid";
  return "";
}

function modeFromLabel(label?: string): "F2F" | "ONL" | "HYB" | undefined {
  if (!label) return undefined;
  if (label === "Face-to-Face Only") return "F2F";
  if (label === "Fully Online") return "ONL";
  if (label === "Hybrid") return "HYB";
  return undefined;
}

/* =========================================================
   ==================  MAIN COMPONENT  =====================
   ========================================================= */

export default function Faculty_Preferences() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState(false);

  const [options, setOptions] = useState<Options>({
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    timeBands: [
      "07:30 - 09:00",
      "09:15 - 10:45",
      "11:00 - 12:30",
      "12:45 - 14:15",
      "14:30 - 16:00",
      "16:15 - 17:45",
      "18:00 - 19:30",
      "19:45 - 21:00",
    ],
    kacs: [],
    campuses: [],
    deloading_types: [],
    coursesByKac: {},
  });

  const [doc, setDoc] = useState<PrefDoc | null>(null);
  const [form, setForm] = useState<FormState>({
    prefUnits: "",
    maxUnits: 15,
    days: [],
    timeSlots: [],
    kac: [],
    preferredCourses: [], // <-- REQUIRED in initial state
    deliveryMode: undefined,
    campus: undefined,
    remarks: "",
    deloadings: [{ type: undefined, adminType: undefined, units: "" }],
    noDeloading: false,
  });

  const userId = useMemo(() => {
    try {
      const raw = localStorage.getItem("session");
      const s = raw ? JSON.parse(raw) : null;
      return s?.userId || s?.user?.userId || "";
    } catch {
      return "";
    }
  }, []);

  // ---------- map KAC name -> id (for submit) ----------
  const kacNameToId = (name?: string) =>
    options.kacs.find((k) => k.kac_name === name)?.kac_id ||
    options.kacs.find((k) => k.kac_code === name)?.kac_id ||
    name ||
    "";

  // ---------- map Deloading type name -> id (for submit) ----------
  const deloadTypeNameToId = (name?: string) =>
    options.deloading_types.find((t) => t.type === name)?.deloadingtype_id || name || "";

  // ---------- initial load ----------
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);

        // options
        const o = await getFacultyPreferencesOptions(userId);
        setOptions({
          days: o?.days || options.days,
          timeBands: o?.timeBands || options.timeBands,
          kacs: o?.kacs || [],
          campuses: o?.campuses || [],
          deloading_types: o?.deloading_types || [],
          coursesByKac: o?.coursesByKac || {},
        });

        // latest pref
        const r = await getFacultyPreferencesList(userId);
        const pref: PrefDoc | undefined = (r?.preferences || [])[0];
        if (pref) {
          setDoc(pref);
          setForm((f) => ({
            ...f,
            prefUnits: pref.preferred_units ?? "",
            maxUnits: 15,
            days: expandDays(pref.availability_days || []),
            timeSlots: pref.preferred_times || [],
            kac: (pref.preferred_kacs || []).map((k) => k.kac_name || k.kac_code || k.kac_id || "").filter(Boolean),
            deliveryMode: (toModeLabel(pref.mode?.mode) || undefined) as FormState["deliveryMode"],
            campus: pref.mode?.campus_name || undefined,
            remarks: pref.notes || "",
            noDeloading: !((pref.deloading_data || []).length),
            deloadings:
              pref.deloading_data && pref.deloading_data.length
                ? pref.deloading_data.map((d) => ({
                    type: d.deloading_type_name || d.deloading_type,
                    units: Number(d.units || "0"),
                  }))
                : [{ type: undefined, adminType: undefined, units: "" }],
            preferredCourses: (pref.preferred_courses || []).map((c) => c.course_id).filter(Boolean),
          }));
        } else {
          setDoc(null);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // When entering edit mode, ensure form mirrors latest doc
  const enterEdit = () => {
    if (doc) {
      setForm({
        prefUnits: doc.preferred_units ?? "",
        maxUnits: 15,
        days: expandDays(doc.availability_days || []),
        timeSlots: doc.preferred_times || [],
        kac: (doc.preferred_kacs || []).map((k) => k.kac_name || k.kac_code || k.kac_id || "").filter(Boolean),
        deliveryMode: (toModeLabel(doc.mode?.mode) || undefined) as
          | "Face-to-Face Only"
          | "Hybrid"
          | "Fully Online"
          | undefined,
        campus: doc.mode?.campus_name || options.campuses[0]?.campus_name,
        preferredCourses: (doc.preferred_courses || []).map((c) => c.course_id).filter(Boolean),
        remarks: doc.notes || "",
        noDeloading: !((doc.deloading_data || []).length),
        deloadings:
          doc.deloading_data && doc.deloading_data.length
            ? doc.deloading_data.map((d) => ({
                type: d.deloading_type_name || d.deloading_type,
                units: Number(d.units || "0"),
              }))
            : [{ type: undefined, adminType: undefined, units: "" }],
      });
    }
    setEdit(true);
  };

  // ---------- payload mapping ----------
  const toModeObject = (v: FormState) => {
    const code = modeFromLabel(v.deliveryMode);
    const campus = options.campuses.find((c) => c.campus_name === v.campus)?.campus_id;
    if (!code && !campus) return undefined; // omit
    return { mode: code, campus_id: campus };
  };

  const buildSubmitPayload = (v: FormState, finished: boolean) => {
    const mode = toModeObject(v);
    const base: any = {
      preferred_units: Number(v.prefUnits),
      availability_days: compressDays(v.days),
      preferred_times: v.timeSlots,
      preferred_kacs: (v.kac || []).map(kacNameToId),
      notes: v.remarks,
      has_new_prep: false,
      is_finished: finished,
      deloading_data: v.noDeloading
        ? []
        : (v.deloadings || [])
            .filter((r) => r.type && r.units != null)
            .map((r) => ({ deloading_type: deloadTypeNameToId(r.type), units: String(r.units ?? "0") })),
      preferred_courses: v.preferredCourses || [],
    };
    if (mode) base.mode = mode; // omit when undefined
    return base;
  };

  const onSave = async (finished: boolean) => {
    try {
      setSaving(true);
      const payload = buildSubmitPayload(form, finished);
      const res = await submitFacultyPreferences(userId, payload);
      // refresh display after save
      const r = await getFacultyPreferencesList(userId);
      const pref: PrefDoc | undefined = (r?.preferences || [])[0];
      setDoc(pref || null);
      setEdit(false);
      return res;
    } catch (e) {
      console.error(e);
      alert(String(e));
    } finally {
      setSaving(false);
    }
  };

  /* =========================================================
     ====================  RENDER  ===========================
     ========================================================= */

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-gray-500">
        Loading preferences…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-[20px] font-semibold text-gray-900">Faculty Preferences</h2>
          <div className="text-[13px] text-gray-500">
            Configure your teaching preferences for the upcoming term
          </div>
        </div>
        {!edit ? (
          <button
            onClick={enterEdit}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-800"
          >
            <Settings className="h-4 w-4" />
            Edit Preferences
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setEdit(false)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              disabled={saving}
              onClick={() => onSave(true)}
              className={cls(
                "inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-800",
                saving && "opacity-70"
              )}
            >
              <Check className="h-4 w-4" />
              Save Preferences
            </button>
          </div>
        )}
      </div>

      {/* Grid layout mirrors your original FAC_Preferences UI */}
      {!edit ? (
        <SavedView doc={doc} />
      ) : (
        <EditView form={form} setForm={setForm} options={options} />
      )}
    </div>
  );
}

/* =========================================================
   =====================  SAVED VIEW  ======================
   ========================================================= */

function SavedView({ doc }: { doc: PrefDoc | null }) {
  const delivery = toModeLabel(doc?.mode?.mode);
  const campus = doc?.mode?.campus_name;

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      {/* Teaching Load */}
      <SectionCard icon={<BookOpen className="h-4 w-4" />} title="Teaching Load">
        <div className="space-y-4">
          <div>
            <FieldLabel>Preferred Teaching Units</FieldLabel>
            <FieldValue>{doc?.preferred_units ?? "—"} units</FieldValue>
          </div>

          <div>
            <FieldLabel>Maximum Teaching Units</FieldLabel>
            <FieldValue>15.0 units</FieldValue>
          </div>

          <div>
            <FieldLabel>Deloading</FieldLabel>
            <FieldValue>
              {(doc?.deloading_data || []).length ? (
                <div className="flex flex-wrap gap-2">
                  {(doc?.deloading_data || []).map((d, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Tag tone="gray">
                        {d.deloading_type_name || d.deloading_type}
                      </Tag>
                      <span className="text-[13px] text-gray-700">{Number(d.units || "0")} units</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-[13px] text-gray-400">No deloading</span>
              )}
            </FieldValue>
          </div>
        </div>
      </SectionCard>

      {/* Location & Mode */}
      <SectionCard icon={<MapPin className="h-4 w-4" />} title="Location & Mode">
        <div className="space-y-4">
          <div>
            <FieldLabel>Campus Preference</FieldLabel>
            <FieldValue>
              {campus ? <Tag tone="blue">{campus}</Tag> : <span className="text-[13px] text-gray-400">—</span>}
            </FieldValue>
          </div>

          <div>
            <FieldLabel>Delivery Mode</FieldLabel>
            <FieldValue>
              {delivery ? <Tag tone="blue">{delivery}</Tag> : <span className="text-[13px] text-gray-400">—</span>}
            </FieldValue>
          </div>
        </div>
      </SectionCard>

      {/* Schedule Preferences */}
      <SectionCard icon={<CalendarDays className="h-4 w-4" />} title="Schedule Preferences" className="md:col-span-1">
        <div className="space-y-4">
          <div>
            <FieldLabel>Preferred Days</FieldLabel>
            <FieldValue>
              {(doc?.availability_days || []).length ? (
                <div className="flex flex-wrap gap-2">
                  {expandDays(doc?.availability_days || []).map((d) => (
                    <Tag key={d} tone="gray">
                      {d}
                    </Tag>
                  ))}
                </div>
              ) : (
                <span className="text-[13px] text-gray-400">—</span>
              )}
            </FieldValue>
          </div>

          <div>
            <FieldLabel>Preferred Time Slots</FieldLabel>
            <FieldValue>
              {(doc?.preferred_times || []).length ? (
                <div className="flex flex-wrap gap-2">
                  {(doc?.preferred_times || []).map((t) => (
                    <Tag key={t} tone="gray">
                      {t}
                    </Tag>
                  ))}
                </div>
              ) : (
                <span className="text-[13px] text-gray-400">—</span>
              )}
            </FieldValue>
          </div>
        </div>
      </SectionCard>

      {/* Academic Specialization */}
      <SectionCard icon={<Monitor className="h-4 w-4" />} title="Academic Specialization" className="md:col-span-1">
        <div className="space-y-4">
          <div>
            <FieldLabel>Knowledge Areas</FieldLabel>
            <FieldValue>
              {(doc?.preferred_kacs || []).length ? (
                <div className="flex flex-wrap gap-2">
                  {(doc?.preferred_kacs || []).map((k, i) => (
                    <Tag key={i}>{k.kac_name || k.kac_code || k.kac_id}</Tag>
                  ))}
                </div>
              ) : (
                <span className="text-[13px] text-gray-400">—</span>
              )}
            </FieldValue>
          </div>

          <div>
            <FieldLabel>Preferred Courses</FieldLabel>
            <FieldValue>
              {(doc?.preferred_courses || []).length ? (
                <div className="flex flex-wrap gap-2">
                  {(doc?.preferred_courses || []).map((c) => (
                    <Tag key={c.course_id} tone="gray">
                      {(Array.isArray(c.course_code) ? c.course_code?.[0] : c.course_code) || c.course_id}
                    </Tag>
                  ))}
                </div>
              ) : (
                <span className="text-[13px] text-gray-400">—</span>
              )}
            </FieldValue>
          </div>
        </div>
      </SectionCard>

      {/* Remarks */}
      <SectionCard icon={<PencilLine className="h-4 w-4" />} title="Remarks" className="md:col-span-2">
        <div className="text-[14px] text-gray-800">{doc?.notes || "—"}</div>
      </SectionCard>
    </div>
  );
}

/* =========================================================
   =====================  EDIT VIEW  =======================
   ========================================================= */

function EditView({
  form,
  setForm,
  options,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  options: Options;
}) {
  // ----- handlers -----
  const toggleDay = (day: string) =>
    setForm((f) => ({
      ...f,
      days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day],
    }));

  const toggleTime = (slot: string) =>
    setForm((f) => ({
      ...f,
      timeSlots: f.timeSlots.includes(slot) ? f.timeSlots.filter((t) => t !== slot) : [...f.timeSlots, slot],
    }));

  const toggleKac = (name: string) =>
    setForm((f) => ({
      ...f,
      kac: f.kac.includes(name) ? f.kac.filter((k) => k !== name) : [...f.kac, name],
      // clear preferred courses that no longer belong to any selected KAC
      preferredCourses: (f.preferredCourses || []).filter((cid) => {
        const selIds = (f.kac.includes(name) ? f.kac : [...f.kac, name]) // optimistic
          .map((nm) =>
            options.kacs.find((k) => k.kac_name === nm)?.kac_id ||
            options.kacs.find((k) => k.kac_code === nm)?.kac_id ||
            nm
          );
        const allowed = new Set(
          selIds.flatMap((id) => (options.coursesByKac?.[id] || []).map((c) => c.course_id))
        );
        return allowed.has(cid);
      }),
    }));

  const addDeloadRow = () =>
    setForm((f) => ({
      ...f,
      deloadings: [...f.deloadings, { type: undefined, adminType: undefined, units: "" }],
    }));

  const removeDeloadRow = (idx: number) =>
    setForm((f) => ({
      ...f,
      deloadings: f.deloadings.filter((_, i) => i !== idx),
    }));

  const updateDeloadRow = (idx: number, patch: Partial<RowDeload>) =>
    setForm((f) => ({
      ...f,
      deloadings: f.deloadings.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));

  const allDays = options.days || [];
  const allSlots = options.timeBands || [];
  const kacNames = (options.kacs || []).map((k) => k.kac_name || k.kac_code || k.kac_id).filter(Boolean);
  const campusNames = (options.campuses || []).map((c) => c.campus_name);
  const deloadTypeNames = (options.deloading_types || []).map((t) => t.type);

  // ----- KAC → Courses (computed once per render) -----
  const kacNameToIdLocal = (name: string) =>
    options.kacs.find((k) => k.kac_name === name)?.kac_id ||
    options.kacs.find((k) => k.kac_code === name)?.kac_id ||
    name;

  const selectedKacIds = (form.kac || []).map((name) => kacNameToIdLocal(name));
  const courseGroups: CourseLite[] = selectedKacIds
    .map((id) => options.coursesByKac?.[id] || [])
    .flat();
  const selectedCourseIds = new Set(form.preferredCourses || []);

  // quick lookup for tags in the preview area
  const courseById = new Map<string, CourseLite>();
  courseGroups.forEach((c) => {
    courseById.set(c.course_id, c);
  });

  return (
    <form className="grid grid-cols-2 gap-6 max-[900px]:grid-cols-1">
      {/* Preferred Teaching Units / Max Units */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-4 grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1 text-[12.5px] font-medium text-gray-500">Preferred Teaching Units</div>
            <input
              type="number"
              value={form.prefUnits}
              onChange={(e) => setForm((f) => ({ ...f, prefUnits: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-600"
              placeholder="Enter units"
            />
          </div>
          <div>
            <div className="mb-1 text-[12.5px] font-medium text-gray-500">Maximum Teaching Units</div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">15</div>
          </div>
        </div>

        {/* Days and Time Slots */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1 text-[12.5px] font-medium text-gray-500">Preferred Teaching Days</div>
            <div className="grid grid-cols-1 gap-1">
              {allDays.map((d) => (
                <label key={d} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={form.days.includes(d)}
                    onChange={() => toggleDay(d)}
                  />
                  {d}
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-[12.5px] font-medium text-gray-500">Preferred Time Slots</div>
            <div className="grid grid-cols-1 gap-1">
              {allSlots.map((t) => (
                <label key={t} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={form.timeSlots.includes(t)}
                    onChange={() => toggleTime(t)}
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Delivery Mode / Campus / KAC + Courses */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1 text-[12.5px] font-medium text-gray-500">Preferred Delivery Mode</div>
            <select
              value={form.deliveryMode || ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  deliveryMode: ((e.target.value as any) || undefined) as
                    | "Face-to-Face Only"
                    | "Hybrid"
                    | "Fully Online"
                    | undefined,
                }))
              }
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-600"
            >
              <option value="">— Select —</option>
              <option>Face-to-Face Only</option>
              <option>Hybrid</option>
              <option>Fully Online</option>
            </select>
          </div>

          <div>
            <div className="mb-1 text-[12.5px] font-medium text-gray-500">Campus Preference</div>
            <select
              value={form.campus || ""}
              onChange={(e) => setForm((f) => ({ ...f, campus: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-600"
            >
              <option value="">— Select —</option>
              {campusNames.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="col-span-2">
            <div className="mb-2 text-[12.5px] font-medium text-gray-500">Knowledge Area Cluster (KAC)</div>
            <div className="flex flex-wrap gap-2">
              {kacNames.map((name) => {
                const active = form.kac.includes(name);
                return (
                  <button
                    type="button"
                    key={name}
                    onClick={() => toggleKac(name)}
                    className={cls(
                      "rounded-full border px-3 py-1 text-[12px]",
                      active ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"
                    )}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="col-span-2">
            <div className="mb-2 text-[12.5px] font-medium text-gray-500">Preferred Courses</div>
            {courseGroups.length ? (
              <div className="grid grid-cols-1 gap-1">
                {courseGroups.map((c: CourseLite) => {
                  const id = c.course_id;
                  const code = Array.isArray(c.course_code) ? c.course_code?.[0] : c.course_code || id;
                  const title = c.course_title || "";
                  const checked = selectedCourseIds.has(id);
                  return (
                    <label key={id} className="flex items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setForm((f) => {
                            const next = new Set(f.preferredCourses || []);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return { ...f, preferredCourses: Array.from(next) };
                          })
                        }
                      />
                      <span className="font-medium">{code}</span>
                      <span className="text-gray-500">— {title}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="text-[13px] text-gray-400">Select at least one KAC to see its courses.</div>
            )}
          </div>
        </div>
      </section>

      {/* Deloading */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-3 text-[12.5px] font-medium text-gray-500">Deloading</div>

        <div className="mb-3 flex items-center gap-2">
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={!!form.noDeloading}
              onChange={(e) => setForm((f) => ({ ...f, noDeloading: e.target.checked }))}
            />
            I have no deloading
          </label>
        </div>

        {!form.noDeloading && (
          <div className="space-y-2">
            {(form.deloadings || []).map((row, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_120px_80px] items-center gap-2 max-[900px]:grid-cols-1">
                <div>
                  <div className="mb-1 text-[12.5px] font-medium text-gray-500">Type *</div>
                  <select
                    value={row.type || ""}
                    onChange={(e) => updateDeloadRow(idx, { type: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-600"
                    required
                  >
                    <option value="">— Select —</option>
                    {deloadTypeNames.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                    <option>Other</option>
                  </select>
                </div>

                <div>
                  <div className="mb-1 text-[12.5px] font-medium text-gray-500">Admin Deloading Type *</div>
                  <input
                    type="text"
                    value={row.adminType || (row.type === "Administrative" ? "Program Chair" : "")}
                    onChange={(e) => updateDeloadRow(idx, { adminType: e.target.value })}
                    placeholder="e.g., Program Chair"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-600"
                    required
                  />
                </div>

                <div>
                  <div className="mb-1 text-[12.5px] font-medium text-gray-500">Units *</div>
                  <input
                    type="number"
                    value={row.units ?? ""}
                    onChange={(e) => updateDeloadRow(idx, { units: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-600"
                    required
                  />
                </div>

                <div className="flex items-end justify-end pb-0.5">
                  <button
                    type="button"
                    onClick={() => removeDeloadRow(idx)}
                    className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            <div className="pt-1">
              <button
                type="button"
                onClick={addDeloadRow}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-800"
              >
                <Plus className="h-4 w-4" />
                Add Deloading
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Remarks */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-1 text-[12.5px] font-medium text-gray-500">Special Remarks</div>
        <textarea
          rows={4}
          value={form.remarks || ""}
          onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
          className="h-[120px] w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-600"
          placeholder="Add any additional notes…"
        />
      </section>

      {/* Academic Specialization display helper (keeps visual parity) */}
      <div className="col-span-2">
        <SectionCard icon={<Monitor className="h-4 w-4" />} title="Academic Specialization">
          <div className="space-y-4">
            <div>
              <FieldLabel>Knowledge Areas</FieldLabel>
              <FieldValue>
                {(form.kac || []).length ? (
                  <div className="flex flex-wrap gap-2">
                    {form.kac.map((n) => (
                      <Tag key={n}>{n}</Tag>
                    ))}
                  </div>
                ) : (
                  <span className="text-[13px] text-gray-400">—</span>
                )}
              </FieldValue>
            </div>

            <div>
              <FieldLabel>Preferred Courses</FieldLabel>
              <FieldValue>
                {(form.preferredCourses || []).length ? (
                  <div className="flex flex-wrap gap-2">
                    {(form.preferredCourses || []).map((cid) => {
                      const c = courseById.get(cid);
                      const code = c
                        ? (Array.isArray(c.course_code) ? c.course_code?.[0] : c.course_code) || c.course_id
                        : cid;
                      return (
                        <Tag key={cid} tone="gray">
                          {code}
                        </Tag>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-[13px] text-gray-400">—</span>
                )}
              </FieldValue>
            </div>
          </div>
        </SectionCard>
      </div>
    </form>
  );
}

// keep alias if other files import it
export const PreferencesContent = Faculty_Preferences;
