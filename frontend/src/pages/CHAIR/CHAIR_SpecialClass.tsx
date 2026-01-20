import { useEffect, useMemo, useState } from "react";
import { Search as SearchIcon, Edit, Check, ChevronDown, Eye, X, Download } from "lucide-react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  getOMSC_Options,
  listOMSC,
  updateOMSC,
  getOMSC_SchedulePresets,
  getOMSC_Detail,
  exportOMSC_Pdf,
  downloadBlob,
  type OMSpecialClassRow,
  type OMSpecialClassOptions,
  type OMSCSchedulePreset,
  type OMSpecialClassDetail,
} from "../../api";

/* --------------------------------- helpers --------------------------------- */
type DayCode = "M" | "T" | "W" | "H" | "F" | "S";

const DAY_LABELS: Record<DayCode, string> = {
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  H: "Thursday",
  F: "Friday",
  S: "Saturday",
};

const DAY_OPTS_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
type DayLabel = (typeof DAY_OPTS_LABELS)[number];

const DAY_FROM_LABEL: Record<DayLabel, DayCode> = {
  Monday: "M",
  Tuesday: "T",
  Wednesday: "W",
  Thursday: "H",
  Friday: "F",
  Saturday: "S",
};

const GE_TIME_SLOTS = [
  { label: "07:30 - 09:00", start: "0730", end: "0900" },
  { label: "08:00 - 10:00", start: "0800", end: "1000" },
  { label: "09:00 - 12:00", start: "0900", end: "1200" },
  { label: "09:15 - 10:45", start: "0915", end: "1045" },
  { label: "09:15 - 12:30", start: "0915", end: "1230" },
  { label: "10:00 - 12:00", start: "1000", end: "1200" },
  { label: "10:00 - 13:00", start: "1000", end: "1300" },
  { label: "11:00 - 12:30", start: "1100", end: "1230" },
  { label: "11:00 - 13:00", start: "1100", end: "1300" },
  { label: "12:45 - 14:15", start: "1245", end: "1415" },
  { label: "13:00 - 15:00", start: "1300", end: "1500" },
  { label: "13:00 - 16:00", start: "1300", end: "1600" },
  { label: "13:15 - 14:15", start: "1315", end: "1415" },
  { label: "14:00 - 16:00", start: "1400", end: "1600" },
  { label: "14:30 - 16:00", start: "1430", end: "1600" },
  { label: "14:40 - 16:00", start: "1440", end: "1600" },
  { label: "15:30 - 17:30", start: "1530", end: "1730" },
  { label: "16:15 - 17:45", start: "1615", end: "1745" },
  { label: "18:00 - 19:30", start: "1800", end: "1930" },
  { label: "18:00 - 20:00", start: "1800", end: "2000" },
  { label: "18:00 - 21:00", start: "1800", end: "2100" },
  { label: "19:45 - 21:00", start: "1945", end: "2100" },
  { label: "19:45 - 21:15", start: "1945", end: "2115" },
];

function prettyHHMM(hhmm?: string) {
  const s = (hhmm || "").trim();
  if (!/^\d{4}$/.test(s)) return "";
  return `${s.slice(0, 2)}:${s.slice(2)}`;
}

function scheduleTextFromRow(r: Partial<OMSpecialClassRow>) {
  const parts: string[] = [];
  if (r.day1 && r.begin1 && r.end1) parts.push(`${r.day1} ${r.begin1}-${r.end1}`);
  if (r.day2 && r.begin2 && r.end2) parts.push(`${r.day2} ${r.begin2}-${r.end2}`);
  return parts.join("; ");
}

function formatDate(dt?: string) {
  if (!dt) return "—";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return dt;
  return d.toLocaleString();
}

/** SelectBox-styled combo input (type + dropdown in ONE box) */
function ComboSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(value);

  useEffect(() => setLocal(value), [value]);

  const filtered = useMemo(() => {
    const t = (local || "").trim().toUpperCase();
    if (!t) return options;
    return options.filter((o) => o.toUpperCase().includes(t));
  }, [local, options]);

  return (
    <div className={cls("relative", disabled && "opacity-70")}>
      <div
        className={cls(
          "flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm",
          "focus-within:ring-2 focus-within:ring-emerald-500/30 focus-within:border-emerald-500 transition",
          disabled && "cursor-not-allowed bg-gray-100"
        )}
      >
        <input
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          disabled={disabled}
          className={cls("w-full outline-none bg-transparent", disabled && "cursor-not-allowed")}
          style={{ minWidth: '190px' }}  // Apply minWidth directly here
        />
        <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
      </div>

      {open && !disabled && (
        <div className="absolute z-50 mt-1 w-full max-h-[calc(100vh-300px)] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="overflow-auto max-h-[300px]">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500">No matches</div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setLocal(opt);
                    onChange(opt);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                >
                  {opt}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_PILL: Record<string, string> = {
  Submitted: "bg-gray-100 text-gray-700",
  "Under Review": "bg-yellow-100 text-yellow-800",
  Approved: "bg-green-100 text-green-800",
  Rejected: "bg-red-100 text-red-800",
};
function pillClass(status?: string) {
  if (!status) return "bg-gray-100 text-gray-600";
  return STATUS_PILL[status] || "bg-gray-100 text-gray-600";
}

function DetailRow({ label, value }: { label: string; value: any }) {
  const shown =
    value === null || value === undefined || value === ""
      ? "—"
      : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : String(value);

  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 py-2 border-b border-gray-100">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-sm text-gray-800 whitespace-pre-wrap break-words">{shown}</div>
    </div>
  );
}

export default function CHAIR_SpecialClass() {
  const [status, setStatus] = useState("All Status");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");

  const [statuses, setStatuses] = useState<string[]>(["All Status"]);
  const [activeTermLabel, setActiveTermLabel] = useState<string>("");

  // Faculty
  const [facultyNames, setFacultyNames] = useState<string[]>(["UNASSIGNED"]);
  const [facultyNameToIdUpper, setFacultyNameToIdUpper] = useState<Record<string, string>>({});

  // table
  const [rows, setRows] = useState<OMSpecialClassRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // selection
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // edit
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<OMSpecialClassRow>>({});
  const [facultyInput, setFacultyInput] = useState<string>("");

  // presets
  const [presets, setPresets] = useState<OMSCSchedulePreset[]>([]);
  const [presetChoice, setPresetChoice] = useState<string>("CUSTOM"); // schedule_id or CUSTOM

  // view modal
  const [viewOpen, setViewOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewErr, setViewErr] = useState("");
  const [viewData, setViewData] = useState<OMSpecialClassDetail | null>(null);

  // load options
  useEffect(() => {
    (async () => {
      try {
        const opt: OMSpecialClassOptions = await getOMSC_Options();
        if (!opt.ok) throw new Error("Failed to load options");
        setStatuses(["All Status", ...(opt.statuses || [])]);

        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setActiveTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");

        const names = (opt.facultyOptions || [])
          .map((f) => (f.faculty_name || "").trim())
          .filter(Boolean);

        const mapUpper: Record<string, string> = {};
        (opt.facultyOptions || []).forEach((f) => {
          const nm = (f.faculty_name || "").trim();
          if (!nm) return;
          mapUpper[nm.toUpperCase()] = f.faculty_id;
        });

        setFacultyNames(["UNASSIGNED", ...names]);
        setFacultyNameToIdUpper(mapUpper);
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = async () => {
    try {
      setLoading(true);
      setErr("");
      const res = await listOMSC({ status, q });
      if (!res.ok) throw new Error("Failed to load special class applications");
      const incoming = res.rows || [];
      setRows(incoming);

      setSelectedIds((prev) => {
        const allowed = new Set(incoming.map((r) => r.special_id));
        const next: Record<string, boolean> = {};
        Object.entries(prev).forEach(([id, v]) => {
          if (allowed.has(id) && v) next[id] = true;
        });
        return next;
      });
    } catch (e: any) {
      setRows([]);
      setErr(e?.response?.data?.detail || e?.message || "Failed to load special class.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q]);

  const selectedList = useMemo(
    () => rows.filter((r) => !!selectedIds[r.special_id]).map((r) => r.special_id),
    [rows, selectedIds]
  );

  const toggleAllVisible = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = { ...prev };
      rows.forEach((r) => {
        if (checked) next[r.special_id] = true;
        else delete next[r.special_id];
      });
      return next;
    });
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = { ...prev };
      if (checked) next[id] = true;
      else delete next[id];
      return next;
    });
  };

  const exportSelectedPdf = async () => {
    try {
      setErr("");
      if (selectedList.length === 0) {
        setErr("Select at least one application to export.");
        return;
      }
      setLoading(true);
      const blob = await exportOMSC_Pdf({ special_ids: selectedList });
      downloadBlob(blob, `SpecialClass_Selected_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to export selected PDF.");
    } finally {
      setLoading(false);
    }
  };

  const presetOptions = useMemo(() => {
    const base = presets.map((p) => {
      const sec = (p.section_code || "").trim();
      const head = sec ? `${sec} · ${p.label}` : p.label;
      return `${head} · ${p.faculty_name || "UNASSIGNED"}`;
    });
    return ["Custom", ...base];
  }, [presets]);

  const presetLabelToId = useMemo(() => {
    const m: Record<string, string> = {};
    presets.forEach((p) => {
      const sec = (p.section_code || "").trim();
      const head = sec ? `${sec} · ${p.label}` : p.label;
      m[`${head} · ${p.faculty_name || "UNASSIGNED"}`] = p.schedule_id;
    });
    return m;
  }, [presets]);

  const applyPreset = (scheduleId: string) => {
    if (scheduleId === "CUSTOM") {
      setPresetChoice("CUSTOM");
      setDraft((d) => ({
        ...d,
        section_id: null,
      }));
      return;
    }

    const p = presets.find((x) => x.schedule_id === scheduleId);
    if (!p) return;

    setPresetChoice(scheduleId);

    setDraft((d) => ({
      ...d,
      section_id: p.section_id,
      section_code: p.section_code || "",
      day1: (p.day1 || "") as any,
      begin1: p.begin1 || "",
      end1: p.end1 || "",
      day2: (p.day2 || "") as any,
      begin2: p.begin2 || "",
      end2: p.end2 || "",
      faculty_id: p.faculty_id ?? null,
    }));

    setFacultyInput(p.faculty_name && p.faculty_name !== "UNASSIGNED" ? p.faculty_name : "");
  };

  const beginEdit = async (row: OMSpecialClassRow) => {
    setEditId(row.special_id);

    setDraft({
      course_id: row.course_id,
      status: row.status,
      remarks: row.remarks || "",
      faculty_id: row.faculty_id || null,
      section_id: row.section_id || null,
      section_code: row.section_code || "",

      day1: (row.day1 || "") as any,
      begin1: row.begin1 || "",
      end1: row.end1 || "",
      day2: (row.day2 || "") as any,
      begin2: row.begin2 || "",
      end2: row.end2 || "",
    });

    const facName = (row.faculty_name || "").toString().trim();
    setFacultyInput(facName === "UNASSIGNED" ? "" : facName);

    try {
      const res = await getOMSC_SchedulePresets(row.course_id);
      setPresets(res.presets || []);
      const match = (res.presets || []).find((p) => p.section_id === row.section_id);
      setPresetChoice(match ? match.schedule_id : "CUSTOM");
    } catch {
      setPresets([]);
      setPresetChoice("CUSTOM");
    }
  };

  const setSlotFromBand = (slot: 1 | 2, bandLabel: string) => {
    const found = GE_TIME_SLOTS.find((x) => x.label === bandLabel);
    if (!found) {
      setDraft((d) => ({
        ...d,
        ...(slot === 1 ? { begin1: "", end1: "" } : { begin2: "", end2: "" }),
      }));
      return;
    }
    setDraft((d) => ({
      ...d,
      ...(slot === 1
        ? { begin1: found.start, end1: found.end, day1: (d.day1 as any) || "M" }
        : { begin2: found.start, end2: found.end, day2: (d.day2 as any) || "M" }),
    }));
  };

  const saveEdit = async () => {
    if (!editId) return;

    try {
      setLoading(true);
      setErr("");

      const isCustom = presetChoice === "CUSTOM";

      let payloadFacultyId: string | null = null;
      if (isCustom) {
        const typedName = (facultyInput || "").trim();
        const fid =
          typedName && typedName.toUpperCase() !== "UNASSIGNED"
            ? facultyNameToIdUpper[typedName.toUpperCase()] || ""
            : "";
        payloadFacultyId = fid ? fid : null;
      }

      const payload: Partial<OMSpecialClassRow> = {
        status: draft.status,
        remarks: draft.remarks,

        section_id: isCustom ? null : draft.section_id || null,
        section_code: isCustom ? draft.section_code || "" : "",

        faculty_id: isCustom ? payloadFacultyId : undefined,
      };

      if (isCustom) {
        payload.day1 = (draft.day1 || "") as any;
        payload.begin1 = draft.begin1 || "";
        payload.end1 = draft.end1 || "";
        payload.day2 = (draft.day2 || "") as any;
        payload.begin2 = draft.begin2 || "";
        payload.end2 = draft.end2 || "";
      }

      await updateOMSC(editId, payload);

      setEditId(null);
      setDraft({});
      setPresets([]);
      setPresetChoice("CUSTOM");
      setFacultyInput("");
      await load();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to update special class.");
    } finally {
      setLoading(false);
    }
  };

  const openView = async (row: OMSpecialClassRow) => {
    setViewOpen(true);
    setViewLoading(true);
    setViewErr("");
    setViewData(null);

    try {
      const res = await getOMSC_Detail(row.special_id);
      if (!res.ok) throw new Error("Failed to load application detail.");
      setViewData(res.row);
    } catch (e: any) {
      setViewErr(e?.response?.data?.detail || e?.message || "Failed to load application detail.");
    } finally {
      setViewLoading(false);
    }
  };

  const closeView = () => {
    setViewOpen(false);
    setViewErr("");
    setViewData(null);
    setViewLoading(false);
  };

  const allVisibleSelected = rows.length > 0 && rows.every((r) => !!selectedIds[r.special_id]);

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Special Class</h1>
        <p className="text-sm text-gray-600">
          Review Special Class applications {activeTermLabel && `for ${activeTermLabel}`}
        </p>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
        <div className="relative flex-1 min-w-[240px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search student name, course code, title, or section…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>

        <SelectBox value={status} onChange={setStatus} options={statuses} />

        <button
          type="button"
          onClick={exportSelectedPdf}
          disabled={loading || selectedList.length === 0}
          title="Export selected applications to PDF"
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:opacity-100 disabled:bg-emerald-600 disabled:text-white disabled:cursor-not-allowed"
        >
          <Download className="h-4 w-4" />
          Export PDF
        </button>

      </div>

      <div className="table-wrapper w-full overflow-hidden">
        <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-auto rounded-xl">
          <table className="w-full text-sm table-auto">
          <thead className="bg-gray-50 border-b text-gray-700">
            <tr>
              <th className="text-left px-3 py-2 whitespace-nowrap w-10">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(e) => toggleAllVisible(e.target.checked)}
                  className="h-4 w-4 accent-emerald-600"
                  title="Select all visible"
                />
              </th>

              <th className="text-left px-4 py-2 whitespace-nowrap">Student</th>
              <th className="text-left px-4 py-2 whitespace-nowrap">Course</th>
              <th className="text-left px-4 py-2 whitespace-nowrap">Section</th>
              <th className="text-left px-4 py-2 whitespace-nowrap">Faculty</th>

              <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Day1</th>
              <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Begin1</th>
              <th className="text-left px-3 py-2 whitespace-nowrap w-fit">End1</th>
              <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Day2</th>
              <th className="text-left px-3 py-2 whitespace-nowrap w-fit">Begin2</th>
              <th className="text-left px-3 py-2 whitespace-nowrap w-fit">End2</th>

              <th className="text-center px-4 py-2 whitespace-nowrap">Status</th>
              <th className="text-left px-4 py-2 whitespace-nowrap">Remarks</th>
              <th className="w-20 px-4 py-2" />
            </tr>
          </thead>

          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-center text-gray-500" colSpan={14}>
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-gray-500" colSpan={14}>
                  No results
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const editing = editId === r.special_id;
                const isCustom = presetChoice === "CUSTOM";

                return (
                  <tr key={r.special_id} className="hover:bg-gray-50 align-top">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={!!selectedIds[r.special_id]}
                        onChange={(e) => toggleOne(r.special_id, e.target.checked)}
                        className="h-4 w-4 accent-emerald-600"
                        disabled={loading}
                      />
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-semibold">{r.student_name || "—"}</div>
                      <div className="text-xs text-gray-500">{r.student_number || "—"}</div>
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-semibold text-emerald-700">{r.course_code || "—"}</div>
                      <div className="text-xs text-gray-500">{r.course_title || ""}</div>
                    </td>

                    <td className="px-4 py-3">
                      {editing ? (
                        isCustom ? (
                          <input
                            value={(draft.section_code || "") as string}
                            onChange={(e) => setDraft((d) => ({ ...d, section_code: e.target.value }))}
                            placeholder=" "
                            className={cls(
                              "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                              "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
                              "min-w-[60px]" // Adjusting the width for better display
                            )}
                          />
                        ) : (
                          <div className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700">
                            {(draft.section_code || r.section_code || "—") as string}
                          </div>
                        )
                      ) : (
                        <div className="font-medium">{r.section_code?.trim() ? r.section_code : "—"}</div>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      {editing ? (
                      <ComboSelect
                        value={facultyInput?.trim() ? facultyInput : ""} // Allow faculty to remain empty while editing
                        onChange={(v) => {
                          if (!isCustom) return;

                          const t = (v || "").trim();

                          // If the input is blank or "UNASSIGNED", clear faculty and don't set faculty_id
                          if (t === "" || t.toUpperCase() === "UNASSIGNED") {
                            setFacultyInput("");  // Allow faculty to remain blank
                            setDraft((d) => ({ ...d, faculty_id: null })); // Set faculty_id to null if blank
                            return;
                          }

                          setFacultyInput(t); // Set faculty input to the value entered
                          const fid = facultyNameToIdUpper[t.toUpperCase()] || "";
                          setDraft((d) => ({ ...d, faculty_id: fid ? fid : null })); // Set faculty_id if valid
                        }}
                        options={["", "UNASSIGNED", ...facultyNames.filter((n) => n !== "UNASSIGNED")]} // Add an empty option for faculty
                        placeholder="Select Faculty"
                        disabled={!isCustom}
                      />

                      ) : (
                        <div className="font-medium">{r.faculty_name || "UNASSIGNED"}</div>
                      )}

                      {editing && !isCustom && (
                        <div className="mt-1 text-xs text-gray-500">
                          Faculty is derived from Faculty Assignments for the selected section.
                        </div>
                      )}
                    </td>

                    {/* Schedule columns */}
                    {editing ? (
                      <>
                        {/* Day1/Begin1/End1 editor occupies 3 columns */}
                        <td className="px-3 py-3 whitespace-nowrap" colSpan={3}>
                          <div className="space-y-2 min-w-[520px]">
                            <SelectBox
                              value={
                                presetChoice === "CUSTOM"
                                  ? "Custom"
                                  : (() => {
                                      const p = presets.find((x) => x.schedule_id === presetChoice);
                                      if (!p) return "Custom";
                                      const sec = (p.section_code || "").trim();
                                      const head = sec ? `${sec} · ${p.label}` : p.label;
                                      return `${head} · ${p.faculty_name || "UNASSIGNED"}`;
                                    })()
                              }
                              onChange={(label) => {
                                if (label === "Custom") {
                                  setPresetChoice("CUSTOM");
                                  setDraft((d) => ({
                                    ...d,
                                    section_id: null,
                                    section_code: d.section_code || "",
                                    day1: (d.day1 as any) || "M",
                                    day2: (d.day2 as any) || "M",
                                  }));
                                  return;
                                }
                                const sid = presetLabelToId[label] || "";
                                if (sid) applyPreset(sid);
                              }}
                              options={presetOptions}
                            />

                            {presetChoice === "CUSTOM" ? (
                              <div className="rounded-lg border border-gray-200 bg-white p-3">
                                <div className="text-xs text-gray-600 mb-2">
                                  Custom Schedule (max 2 entries). Begin uses preset time slots and auto-fills End.
                                </div>

                                <div className="grid grid-cols-[minmax(180px,5px)_minmax(100px,1fr)_minmax(90px,120px)] gap-2 items-center mb-2 min-w-0">  {/* Adjusting grid layout for spacing */}
                                  <SelectBox
                                    value={draft.day1 ? DAY_LABELS[draft.day1 as DayCode] : "Monday"}
                                    onChange={(lbl) =>
                                      setDraft((d) => ({ ...d, day1: DAY_FROM_LABEL[lbl as DayLabel] || "M" }))
                                    }
                                    options={[...DAY_OPTS_LABELS]}
                                  />

                                  <SelectBox
                                    value={(() => {
                                      const b = (draft.begin1 || "").toString();
                                      const e = (draft.end1 || "").toString();
                                      const f = GE_TIME_SLOTS.find((x) => x.start === b && x.end === e);
                                      return f?.label || "Select time…";
                                    })()}
                                    onChange={(band) => {
                                      if (band === "Select time…") {
                                        setSlotFromBand(1, "");
                                        return;
                                      }
                                      setSlotFromBand(1, band);
                                    }}
                                    options={["Select time…", ...GE_TIME_SLOTS.map((x) => x.label)]}
                                  />

                                  <input
                                    value={prettyHHMM(draft.end1 || "")}
                                    disabled
                                    className={cls(
                                      "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                      "bg-gray-100 text-gray-700 cursor-not-allowed"
                                    )}
                                  />
                                </div>

                                <div className="grid grid-cols-[minmax(180px,5px)_minmax(100px,1fr)_minmax(90px,120px)] gap-2 items-center">
                                  <SelectBox
                                    value={draft.day2 ? DAY_LABELS[draft.day2 as DayCode] : "Monday"}
                                    onChange={(lbl) =>
                                      setDraft((d) => ({ ...d, day2: DAY_FROM_LABEL[lbl as DayLabel] || "M" }))
                                    }
                                    options={[...DAY_OPTS_LABELS]}
                                  />

                                  <SelectBox
                                    value={(() => {
                                      const b = (draft.begin2 || "").toString();
                                      const e = (draft.end2 || "").toString();
                                      const f = GE_TIME_SLOTS.find((x) => x.start === b && x.end === e);
                                      return f?.label || "Select time…";
                                    })()}
                                    onChange={(band) => {
                                      if (band === "Select time…") {
                                        setSlotFromBand(2, "");
                                        return;
                                      }
                                      setSlotFromBand(2, band);
                                    }}
                                    options={["Select time…", ...GE_TIME_SLOTS.map((x) => x.label)]}
                                  />

                                  <input
                                    value={prettyHHMM(draft.end2 || "")}
                                    disabled
                                    className={cls(
                                      "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
                                      "bg-gray-100 text-gray-700 cursor-not-allowed"
                                    )}
                                  />
                                </div>

                                <div className="mt-2 text-xs text-gray-600">
                                  Preview: <span className="font-semibold">{scheduleTextFromRow(draft) || "—"}</span>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </td>

                        {/* Day2/Begin2/End2 columns show the actual values (NOT duplicated editor UI) */}
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{draft.day2 || "—"}</td>
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(draft.begin2 || "") || "—"}</td>
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(draft.end2 || "") || "—"}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{r.day1 || "—"}</td>
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(r.begin1 || "") || "—"}</td>
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(r.end1 || "") || "—"}</td>
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{r.day2 || "—"}</td>
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(r.begin2 || "") || "—"}</td>
                        <td className="px-3 py-3 whitespace-nowrap w-fit">{prettyHHMM(r.end2 || "") || "—"}</td>
                      </>
                    )}

                    <td className="px-4 py-3 text-center whitespace-nowrap">
                      {editing ? (
                        <SelectBox
                          value={(draft.status || r.status || "") as string}
                          onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                          options={statuses.filter((s) => s !== "All Status")}
                        />
                      ) : (
                        <span className={cls("inline-block rounded-full px-3 py-1 text-xs font-semibold", pillClass(r.status))}>
                          {r.status || "—"}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3 text-left">
                      {editing ? (
                        <textarea
                          value={(draft.remarks || "") as string}
                          onChange={(e) => setDraft((d) => ({ ...d, remarks: e.target.value }))}
                          rows={3}
                          className={cls(
                            "w-full min-w-[180px] rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm resize-none", // Increased width
                            "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition"
                          )}
                        />
                      ) : (
                        <span className="block whitespace-pre-wrap text-gray-700">
                          {r.remarks || <span className="text-gray-400">—</span>}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-2">
                        {editing ? (
                          <button
                            onClick={saveEdit}
                            className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                            title="Save"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => openView(r)}
                              className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 text-gray-700 hover:bg-gray-50"
                              title="View Application"
                            >
                              <Eye className="h-4 w-4" />
                            </button>

                            <button
                              onClick={() => beginEdit(r)}
                              className="flex h-8 w-8 items-center justify-center rounded-full border border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                              title="Edit"
                            >
                              <Edit className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          </table>
        </div>
      </div>

      {/* View Application Modal */}
      {viewOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeView();
          }}
        >
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b bg-gray-50">
              <div>
                <div className="text-lg font-bold text-gray-900">View Application</div>
              </div>
              <button
                type="button"
                onClick={closeView}
                className="h-9 w-9 inline-flex items-center justify-center rounded-full hover:bg-gray-200/70"
                title="Close"
              >
                <X className="h-5 w-5 text-gray-700" />
              </button>
            </div>

            <div className="p-5 max-h-[75vh] overflow-auto">
              {viewLoading ? (
                <div className="py-10 text-center text-gray-500">Loading application…</div>
              ) : viewErr ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {viewErr}
                </div>
              ) : !viewData ? (
                <div className="py-10 text-center text-gray-500">No data</div>
              ) : (
                <div className="space-y-5">

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Student</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Student Name" value={viewData.student_name} />
                      <DetailRow label="Student Number" value={viewData.student_number} />
                      <DetailRow label="Program" value={viewData.program_code} />
                      <DetailRow label="Department" value={viewData.department_name || viewData.course_department} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Course</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Course Code" value={viewData.course_code} />
                      <DetailRow label="Course Title" value={viewData.course_title} />
                      <DetailRow label="Course Units" value={viewData.course_units} />
                      <DetailRow label="Units Remaining" value={viewData.units_remaining} />
                      <DetailRow label="Graduating After Term" value={viewData.graduating_after_term} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Request</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Reason" value={viewData.reason} />
                      <DetailRow label="Reason (Other)" value={viewData.reason_other} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Schedule</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Section" value={viewData.section_code || "—"} />
                      <DetailRow
                        label="Schedule 1"
                        value={
                          viewData.day1 && viewData.begin1 && viewData.end1
                            ? `${viewData.day1} ${prettyHHMM(viewData.begin1)}–${prettyHHMM(viewData.end1)}`
                            : "—"
                        }
                      />
                      <DetailRow
                        label="Schedule 2"
                        value={
                          viewData.day2 && viewData.begin2 && viewData.end2
                            ? `${viewData.day2} ${prettyHHMM(viewData.begin2)}–${prettyHHMM(viewData.end2)}`
                            : "—"
                        }
                      />
                      <DetailRow label="Section ID" value={viewData.section_id} />
                      <DetailRow label="Faculty" value={viewData.faculty_name || "UNASSIGNED"} />
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-3 bg-white border-b">
                      <div className="text-sm font-semibold text-gray-900">Status</div>
                    </div>
                    <div className="px-4">
                      <DetailRow label="Status" value={viewData.status} />
                      <DetailRow label="Remarks" value={viewData.remarks} />
                      <DetailRow label="Submitted At" value={formatDate(viewData.submitted_at)} />
                      <DetailRow label="Updated At" value={formatDate(viewData.updated_at)} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t bg-gray-50 flex items-center justify-end">
              <button
                type="button"
                onClick={closeView}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-100"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
