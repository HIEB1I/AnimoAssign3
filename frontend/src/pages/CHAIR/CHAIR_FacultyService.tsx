import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Send, Save, ChevronDown } from "lucide-react";
import {
  getFSOptions,
  listFacultyService,
  createFacultyService,
  sendFacultyService,
  respondFacultyService,
  type FacultyServiceRow,
  type ToDept,
  type DayShort,
} from "@/api";

/* ---------------- helpers ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const toast = (msg: string) => alert(msg);

/** unify all control heights so rows won't bulge/overlap */
const CONTROL =
  "h-9 w-full rounded-md border border-neutral-300 px-3 text-[13px] shadow-sm focus:ring-2 focus:ring-emerald-500/30";

/* ---------------- Dropdown (APO-like chrome, same logic) ---------------- */
function Dropdown({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "",
  searchable = false,
  align = "left",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  searchable?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => (!searchable || !term ? options : options.filter((o) => o.toLowerCase().includes(term.toLowerCase()))),
    [term, options, searchable]
  );

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className={cls("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cls(CONTROL, "truncate pr-8")}
        title={value || undefined}
      >
        {value || <span className="text-neutral-400">{placeholder}</span>}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      </button>

      {open && (
        <div
          ref={listRef}
          className={cls(
            "absolute z-40 mt-2 max-h-72 min-w-[220px] max-w-[32rem] overflow-auto rounded-xl border border-neutral-300 bg-white",
            "shadow-[0_1px_10px_-6px_rgba(0,0,0,0.25)]",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          {searchable && (
            <div className="p-2 border-b border-neutral-200 bg-neutral-50/70">
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Search…"
                className={cls(CONTROL, "h-8")}
              />
            </div>
          )}
          {shown.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls(
                "block w-full truncate px-3 py-2 text-left text-[13px] hover:bg-emerald-50/60 transition-colors",
                value === opt && "bg-emerald-100 text-emerald-800 font-medium"
              )}
              title={opt}
            >
              {opt}
            </button>
          ))}
          {shown.length === 0 && <div className="px-3 py-2 text-[13px] text-neutral-500">No results</div>}
        </div>
      )}
    </div>
  );
}

/* ---------------- page ---------------- */
type FSCreate = {
  course_code: string;
  course_title: string;
  units: number | null;
  to_department: ToDept | "";
};

const DAY_OPTIONS: DayShort[] = ["M", "T", "W", "H", "F", "S"];

/** shared column widths for consistent alignment */
const COLS = [
  "28%", // Course Code & Title
  "6%",  // Units
  "12%", // From
  "14%", // To
  "14%", // Faculty
  "5%",  // Day1
  "6%",  // Begin1
  "6%",  // End1
  "5%",  // Day2
  "6%",  // Begin2
  "6%",  // End2
  "12%", // Remarks
  "6%",  // Action/Status
];

function ColGroup() {
  return (
    <colgroup>
      {COLS.map((w, i) => (
        <col key={i} style={{ width: w }} />
      ))}
    </colgroup>
  );
}

/** consistent label for faculty options */
function facultyLabel(f?: { first_name?: string; last_name?: string; email?: string }) {
  if (!f) return "";
  const L = (f.last_name || "").toUpperCase();
  const F = (f.first_name || "").toUpperCase();
  return (L || F) ? `${L}, ${F}${f.email ? ` (${f.email})` : ""}` : "";
}

export default function CHAIR_FacultyService() {
  // who am I
  const user = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  }, []);
  const userDept = user?.department || "Software Technology";

  // options
  const [toDepts, setToDepts] = useState<ToDept[]>([]);
  const [timeSlots, setTimeSlots] = useState<string[]>([]);

  // cache faculty options per department for responding
  const [facultyCache, setFacultyCache] = useState<
    Record<string, { faculty_id: string; first_name: string; last_name: string; email?: string }[]>
  >({});

  // entry draft
  const [draft, setDraft] = useState<FSCreate>({
    course_code: "",
    course_title: "",
    units: null,
    to_department: "",
  });

  // owner side editor per-row
  type OwnerEdit = {
    faculty?: { faculty_id?: string; first_name?: string; last_name?: string; email?: string };
    day1: DayShort | "";
    begin1: string | "";
    end1: string | "";
    day2: DayShort | "";
    begin2: string | "";
    end2: string | "";
    remarks: string;
  };
  const [ownerEdits, setOwnerEdits] = useState<Record<string, OwnerEdit>>({});
  function getOwner(fs_id: string): OwnerEdit {
    return (
      ownerEdits[fs_id] || {
        day1: "",
        begin1: "",
        end1: "",
        day2: "",
        begin2: "",
        end2: "",
        remarks: "",
      }
    );
  }
  function setOwner(fs_id: string, patch: Partial<OwnerEdit>) {
    setOwnerEdits((prev) => ({ ...prev, [fs_id]: { ...getOwner(fs_id), ...patch } }));
  }

  // list rows
  const [rows, setRows] = useState<FacultyServiceRow[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // load base options
  useEffect(() => {
    (async () => {
      const o = await getFSOptions();
      if (o?.ok) {
        setToDepts(o.departments || []);
        setTimeSlots(o.timeSlots || []);
      }
    })().catch(() => {});
  }, []);

  // ensure faculty options for dept (cached)
  async function ensureFacultyForDept(dept: string) {
    if (!dept || facultyCache[dept]) return;
    try {
      const o = await getFSOptions({ toDepartment: dept as ToDept });
      const list =
        (o.facultyOptions || []).map((f: any) => ({
          faculty_id: f.faculty_id,
          first_name: f.first_name,
          last_name: f.last_name,
          email: f.email,
        })) ?? [];
      setFacultyCache((prev) => ({ ...prev, [dept]: list }));
    } catch {
      /* ignore */
    }
  }

  // fetch list
  async function refresh() {
    setLoadingList(true);
    try {
      const r = await listFacultyService();
      if (r?.ok) setRows(r.rows || []);
    } finally {
      setLoadingList(false);
    }
  }
  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  // course search (typeahead)
  const [courseTerm, setCourseTerm] = useState("");
  const [courseSuggestions, setCourseSuggestions] = useState<
    Array<{ code: string; title: string; units?: number }>
  >([]);
  useEffect(() => {
    let active = true;
    (async () => {
      const res = await getFSOptions({ q: courseTerm });
      if (active && res?.ok) setCourseSuggestions(res.courses || []);
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [courseTerm]);

  const canSend = Boolean(
    draft.course_code && draft.course_title && draft.units != null && draft.to_department
  );

  async function handleCreateAndSend() {
    try {
      if (!canSend) {
        toast("Please complete Course, Units, and To Department.");
        return;
      }
      // create
      const crt = await createFacultyService({
        course_code: draft.course_code,
        course_title: draft.course_title,
        units: draft.units,
        to_department: draft.to_department as ToDept,
      });
      if (!crt?.ok || !crt.row?.fs_id) {
        toast("Failed to create request.");
        return;
      }
      // send
      const snd = await sendFacultyService(crt.row.fs_id);
      if (snd?.ok) {
        toast("Request sent.");
        setDraft({ course_code: "", course_title: "", units: null, to_department: "" });
        setCourseTerm("");
        await refresh();
      } else {
        toast("Failed to send.");
      }
    } catch (e: any) {
      toast(e?.message || "Error sending request.");
    }
  }

  async function handleRespond(fs_id: string, dept: string) {
    const owner = getOwner(fs_id);
    try {
      if (!owner.faculty?.faculty_id && !owner.faculty?.email) {
        toast("Select a faculty.");
        return;
      }
      const r = await respondFacultyService(fs_id, {
        faculty: owner.faculty || {},
        day1: owner.day1,
        begin1: owner.begin1,
        end1: owner.end1,
        day2: owner.day2,
        begin2: owner.begin2,
        end2: owner.end2,
        remarks: owner.remarks,
      });
      if (r?.ok) {
        toast("Response saved.");
        setOwner(fs_id, {
          faculty: undefined,
          day1: "",
          begin1: "",
          end1: "",
          day2: "",
          begin2: "",
          end2: "",
          remarks: "",
        });
        await refresh();
        ensureFacultyForDept(dept);
      } else {
        toast("Failed to save response.");
      }
    } catch (e: any) {
      toast(e?.message || "Error saving response.");
    }
  }

  /* ---------------- UI ---------------- */
  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900 px-6 py-8">
      <header className="mb-5">
        <h1 className="text-2xl font-bold">Faculty Service</h1>
        <p className="text-sm text-neutral-600">
          Request an available faculty from the owning department and record their availability.
        </p>
      </header>

      {/* ENTRY TABLE */}
      <div className="rounded-xl bg-white shadow-sm border border-neutral-200 overflow-x-auto mb-6">
        <table className="w-full table-fixed text-sm min-w-[1100px]">
          <ColGroup />
          <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur text-left text-xs text-neutral-500 border-b">
            <tr className="[&>th]:py-2 [&>th]:px-3 uppercase tracking-wide">
              <th>Course Code &amp; Title</th>
              <th className="text-center">Units</th>
              <th>From</th>
              <th>To</th>
              <th>Faculty</th>
              <th className="text-center">Day1</th>
              <th className="text-center">Begin1</th>
              <th className="text-center">End1</th>
              <th className="text-center">Day2</th>
              <th className="text-center">Begin2</th>
              <th className="text-center">End2</th>
              <th>Remarks</th>
              <th className="text-center">Action</th>
            </tr>
          </thead>

          <tbody className="whitespace-nowrap text-neutral-800">
            <tr className="align-middle hover:bg-emerald-50/30">
              {/* Course search — stays inside the column */}
              <td className="px-3 py-2">
                <div className="relative">
                  <div className="relative mb-1">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                    <input
                      value={courseTerm}
                      onChange={(e) => setCourseTerm(e.target.value)}
                      placeholder="Search course code/title…"
                      className={cls(CONTROL, "pl-7")}
                    />
                  </div>

                  {courseTerm && courseSuggestions.length > 0 && (
                    <div className="absolute z-40 mt-2 max-h-72 w-full max-w-[44rem] overflow-auto rounded-xl border border-neutral-300 bg-white shadow-[0_1px_10px_-6px_rgba(0,0,0,0.25)]">
                      {courseSuggestions.map((c) => (
                        <button
                          key={c.code + c.title}
                          onClick={() => {
                            setDraft((d) => ({
                              ...d,
                              course_code: c.code,
                              course_title: c.title,
                              units: c.units ?? d.units,
                            }));
                            setCourseTerm(`${c.code} — ${c.title}`);
                          }}
                          className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-emerald-50/60 transition-colors"
                          title={`${c.code} — ${c.title}`}
                        >
                          <span className="min-w-[84px] font-semibold text-emerald-700">{c.code}</span>
                          <span className="text-[13px] text-neutral-800">{c.title}</span>
                          {c.units != null && (
                            <span className="ml-auto text-xs text-neutral-500 tabular-nums">{c.units} u</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="text-[12px] text-neutral-700 truncate">
                    {draft.course_code ? (
                      <>
                        <span className="font-semibold text-emerald-700">{draft.course_code}</span> — {draft.course_title}
                      </>
                    ) : (
                      <span className="text-neutral-400">Pick a course…</span>
                    )}
                  </div>
                </div>
              </td>

              {/* Units — no negatives */}
              <td className="px-3 py-2 text-center tabular-nums">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={draft.units ?? ""}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0);
                    setDraft((d) => ({ ...d, units: v }));
                  }}
                  className={cls(CONTROL, "text-center")}
                />
              </td>

              {/* From */}
              <td className="px-3 py-2">
                <span className="block truncate" title={userDept}>
                  {userDept}
                </span>
              </td>

              {/* To dept */}
              <td className="px-3 py-2">
                <Dropdown
                  value={draft.to_department}
                  onChange={(v) => setDraft((d) => ({ ...d, to_department: v as ToDept }))}
                  options={toDepts}
                  placeholder="Select department…"
                />
              </td>

              {/* Placeholders */}
              <td className="px-3 py-2 text-neutral-400">—</td>
              <td className="px-3 py-2 text-center text-neutral-400">—</td>
              <td className="px-3 py-2 text-center text-neutral-400">—</td>
              <td className="px-3 py-2 text-center text-neutral-400">—</td>
              <td className="px-3 py-2 text-center text-neutral-400">—</td>
              <td className="px-3 py-2 text-center text-neutral-400">—</td>
              <td className="px-3 py-2 text-left text-neutral-400">—</td>

              <td className="px-3 py-2 text-center">
                <button
                  className={cls(
                    "inline-flex items-center justify-center gap-1.5 rounded-md px-3 font-medium shadow-sm",
                    "h-9",
                    canSend ? "bg-[#008e4e] text-white hover:brightness-110" : "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                  )}
                  disabled={!canSend}
                  onClick={handleCreateAndSend}
                  title="Send request"
                >
                  <Send className="h-4 w-4" />
                  Send
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* LIST TABLE */}
      <div className="rounded-xl bg-white shadow-sm border border-neutral-200 overflow-x-auto">
        <table className="w-full table-fixed text-sm min-w-[1100px]">
          <ColGroup />
          <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur text-left text-xs text-neutral-500 border-b">
            <tr className="[&>th]:py-2 [&>th]:px-3 uppercase tracking-wide">
              <th>Course Code &amp; Title</th>
              <th className="text-center">Units</th>
              <th>From</th>
              <th>To</th>
              <th>Faculty</th>
              <th className="text-center">Day1</th>
              <th className="text-center">Begin1</th>
              <th className="text-center">End1</th>
              <th className="text-center">Day2</th>
              <th className="text-center">Begin2</th>
              <th className="text-center">End2</th>
              <th>Remarks</th>
              <th className="text-center">Status/Action</th>
            </tr>
          </thead>

          <tbody className="whitespace-nowrap text-neutral-800">
            {rows.map((r) => {
              const isRespondable = r.status !== "responded";
              const fsid = r.fs_id!;
              const owner = getOwner(fsid);
              const dept = r.to_department || "";
              const options = facultyCache[dept] || [];

              return (
                <tr
                  key={fsid}
                  className="align-middle border-b last:border-0 odd:bg-white even:bg-neutral-50/60 hover:bg-emerald-50/30 transition-colors"
                  onMouseEnter={() => ensureFacultyForDept(dept)}
                >
                  <td className="px-3 py-2">
                    <span className="block truncate" title={`${r.course_code} — ${r.course_title}`}>
                      <span className="font-semibold text-emerald-700">{r.course_code}</span> — {r.course_title}
                    </span>
                  </td>

                  <td className="px-3 py-2 text-center tabular-nums">{r.units ?? ""}</td>
                  <td className="px-3 py-2 truncate" title={r.from_department}>{r.from_department}</td>
                  <td className="px-3 py-2 truncate" title={r.to_department}>{r.to_department}</td>

                  {/* Faculty */}
                  <td className="px-3 py-2">
                    {isRespondable ? (
                      <Dropdown
                        value={facultyLabel(owner.faculty)}
                        onChange={(label) => {
                          const match = (options || []).find((f) => facultyLabel(f) === label);
                          if (match) {
                            setOwner(fsid, {
                              faculty: {
                                faculty_id: match.faculty_id,
                                first_name: match.first_name,
                                last_name: match.last_name,
                                email: match.email,
                              },
                            });
                          }
                        }}
                        options={(options || []).map((f) => facultyLabel(f)).filter(Boolean)}
                        placeholder={options?.length ? "Select faculty…" : "Loading…"}
                        searchable
                      />
                    ) : (
                      <span className="block truncate" title={facultyLabel(r.faculty as any)}>
                        {facultyLabel(r.faculty as any) || "—"}
                      </span>
                    )}
                  </td>

                  {/* Day/time — all h-9 via Dropdown CONTROL */}
                  <td className="px-3 py-2 text-center">
                    {isRespondable ? (
                      <Dropdown value={owner.day1} onChange={(v) => setOwner(fsid, { day1: v as DayShort })} options={DAY_OPTIONS} placeholder="—" />
                    ) : (r.day1 || "—")}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {isRespondable ? (
                      <Dropdown value={owner.begin1} onChange={(v) => setOwner(fsid, { begin1: v })} options={timeSlots} placeholder="—" align="right" />
                    ) : (r.begin1 || "—")}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {isRespondable ? (
                      <Dropdown value={owner.end1} onChange={(v) => setOwner(fsid, { end1: v })} options={timeSlots} placeholder="—" align="right" />
                    ) : (r.end1 || "—")}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {isRespondable ? (
                      <Dropdown value={owner.day2} onChange={(v) => setOwner(fsid, { day2: v as DayShort })} options={DAY_OPTIONS} placeholder="—" />
                    ) : (r.day2 || "—")}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {isRespondable ? (
                      <Dropdown value={owner.begin2} onChange={(v) => setOwner(fsid, { begin2: v })} options={timeSlots} placeholder="—" align="right" />
                    ) : (r.begin2 || "—")}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {isRespondable ? (
                      <Dropdown value={owner.end2} onChange={(v) => setOwner(fsid, { end2: v })} options={timeSlots} placeholder="—" align="right" />
                    ) : (r.end2 || "—")}
                  </td>

                  {/* Remarks */}
                  <td className="px-3 py-2">
                    {isRespondable ? (
                      <input
                        value={owner.remarks}
                        onChange={(e) => setOwner(fsid, { remarks: e.target.value })}
                        placeholder="Enter remarks…"
                        className={CONTROL}
                      />
                    ) : (
                      <span className="block truncate" title={r.remarks || ""}>{r.remarks || "—"}</span>
                    )}
                  </td>

                  {/* Status/Action */}
                  <td className="px-3 py-2 text-center">
                    {isRespondable ? (
                      <button
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[#008e4e] px-3 text-[13px] font-medium text-white shadow-sm hover:brightness-110"
                        onClick={() => handleRespond(fsid, dept)}
                        title="Save response"
                      >
                        <Save className="h-4 w-4" />
                        Save
                      </button>
                    ) : (
                      <span className="inline-block rounded-full bg-emerald-100 px-2 py-[2px] text-[12px] text-emerald-700">
                        Responded
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}

            {rows.length === 0 && !loadingList && (
              <tr><td className="px-3 py-8 text-neutral-500 text-center" colSpan={13}>No requests yet.</td></tr>
            )}
            {loadingList && (
              <tr><td className="px-3 py-8 text-neutral-500 text-center" colSpan={13}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-[11px] text-neutral-500">
        Recipient mapping: IT → Danny Cheng (danny.cheng@dlsu.edu.ph); CT → Katrina Ysabel Solomon (katrina.solomon@dlsu.edu.ph).
      </div>
    </div>
  );
}
