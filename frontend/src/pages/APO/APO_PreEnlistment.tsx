import React, { useEffect, useMemo, useState } from "react";
//import Papa, { type ParseResult } from "papaparse";
import Papa from "papaparse";
import { Pencil, Check, Upload, Archive, Download, X } from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import {
  getApoPreenlistment,
  importApoPreenlistment,
  archiveApoPreenlistment,
  getApoPreenlistmentMeta,
  type CountCsvRow,
  type StatCsvRow,
  type PreenlistmentCountDoc,
  type PreenlistmentStatDoc,
  type TermMeta,
  type ArchiveMetaItem,
  campusFromRoles,
  reactivateApoPreenlistment,
  searchCourseCatalog,
} from "../../api";

const PREEN_TERM_KEY_PREFIX = "apo.preenTermId.";

function setPlanningTermForCampus(
  campusId: string,
  termId: string | null | undefined
) {
  if (!campusId || !termId) return;
  try {
    window.localStorage.setItem(PREEN_TERM_KEY_PREFIX + campusId, termId);
  } catch {
    // ignore storage errors
  }
}

// Compact, consistent pill wrappers
const miniBase =
  "inline-flex items-center h-9 rounded-full border-2 border-emerald-200 bg-white px-2 shadow-sm focus-within:border-emerald-400";
// Compact pill-style input (matches the dropdown box, no chevron)
function MiniFieldInput({
  value,
  onChange,
  placeholder = "",
  type = "text",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number";
  className?: string;
}) {
  return (
    <div className={`${miniBase} ${className}`}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        className="w-full bg-transparent outline-none text-sm px-1"
      />
    </div>
  );
}

// NEW: Course Code combobox (type or select), powered by catalog search
function careerToProgramLevel(career: string | undefined) {
  // Backend expects UGS/GSM program_level; Pre-enlistment uses UGB/GSM.
  if (!career) return undefined;
  if (career === "UGB") return "UGS";
  if (career === "GSM") return "GSM";
  return undefined;
}

function MiniCourseCodeCombobox({
  userId,
  value,
  onChange,
  career,
  placeholder = "Course Code",
  className = "",
}: {
  userId?: string;
  value: string;
  onChange: (v: string) => void;
  career?: string;
  placeholder?: string;
  className?: string;
}) {
  // If userId is missing (not logged in), fall back to simple input.
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [options, setOptions] = React.useState<
    Array<{ course_id: string; course_code: string; course_title: string }>
  >([]);

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const lastQueryRef = React.useRef<string>("");
  const timerRef = React.useRef<number | null>(null);

  const normValue = (value || "").toUpperCase();

  // Close only when clicking outside (so scrolling/clicking inside the dropdown won't collapse it)
  React.useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const el = rootRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;
    if (!userId) return;

    const q = normValue.trim();
    // keep it light
    if (q.length < 2) {
      setOptions([]);
      setLoading(false);
      return;
    }

    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      const queryKey = `${q}__${career || ""}`;
      lastQueryRef.current = queryKey;
      setLoading(true);

      try {
        const res = await searchCourseCatalog(userId, {
          q,
          limit: 20,
          program_level: careerToProgramLevel(career),
        });

        // api.ts returns { ok, results }
        const list = (res as any)?.results || [];

        // discard stale responses
        if (lastQueryRef.current !== queryKey) return;

        setOptions(
          (Array.isArray(list) ? list : []).map((c: any) => ({
            course_id: String(c.course_id || ""),
            course_code: String(c.course_code || ""),
            course_title: String(c.course_title || ""),
          }))
        );
      } catch {
        if (lastQueryRef.current !== `${q}__${career || ""}`) return;
        setOptions([]);
      } finally {
        if (lastQueryRef.current === `${q}__${career || ""}`) setLoading(false);
      }
    }, 250);

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, normValue, userId, career]);

  const renderCode = (cc: any) => {
    if (Array.isArray(cc)) return String(cc[0] || "").toUpperCase();
    return String(cc || "").toUpperCase();
  };

  if (!userId) {
    return (
      <MiniFieldInput
        value={normValue}
        onChange={(v: string) => onChange(v.toUpperCase())}
        placeholder={placeholder}
        className={className}
      />
    );
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className={miniBase}>
        <input
          value={normValue}
          onChange={(e) => {
            onChange(e.target.value.toUpperCase());
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full bg-transparent outline-none text-sm px-1"
        />
      </div>

      {open && (loading || options.length > 0) && (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-full min-w-[260px]
                     rounded-xl border-2 border-emerald-200 bg-white shadow-lg"
        >
          {loading && (
            <div className="px-3 py-2 text-xs text-neutral-500">Searching…</div>
          )}

          {!loading && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">
              No matches. You can still type and save (backend will validate).
            </div>
          )}

          {!loading && options.length > 0 && (
            <div className="max-h-64 overflow-y-auto overflow-x-hidden">
              {options.map((c) => (
                <button
                  key={c.course_id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()} // keep focus stable
                  onClick={() => {
                    onChange(renderCode(c.course_code));
                    setOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-emerald-50"
                >
                  <div className="text-sm font-medium">{renderCode(c.course_code)}</div>
                  <div className="text-xs text-neutral-500 truncate">{c.course_title}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// NEW: custom compact dropdown (no native <select>, fully stylable)
function MiniSelectMenu({
  value,
  onChange,
  options,
  className = "",
  placeholder = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  return (
    <div ref={ref} className={`relative ${miniBase} ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 h-7 leading-none text-sm outline-none"
      >
        <span className={`${value ? "" : "text-neutral-400"}`}>
          {value || placeholder}
        </span>
        <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" className="opacity-60">
          <path d="M5 7l5 5 5-5H5z" />
        </svg>
      </button>

      {open && (
        <ul
          className="absolute left-0 top-[calc(100%+6px)] z-40 min-w-[120px]
                     rounded-xl border-2 border-emerald-200 bg-white shadow-lg overflow-hidden"
        >
          {options.map((opt) => {
            const active = opt === value;
            return (
              <li
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`px-3 py-2 text-sm cursor-pointer select-none hover:bg-emerald-50 ${
                  active ? "bg-emerald-50 font-medium" : ""
                }`}
              >
                {opt}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function APO_PreEnlistment() {
  const [view, setView] = useState<"active" | "archives">("active");

  const [activeMeta, setActiveMeta] = useState<TermMeta | null>(null);
  const [enlistedCourses, setEnlistedCourses] = useState<string[][]>([]);
  const [enrollmentStats, setEnrollmentStats] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  const [editIndexCourses, setEditIndexCourses] = useState<number | null>(null);
  const [editRowCourses, setEditRowCourses] = useState<string[] | null>(null);
  const [editIndexStats, setEditIndexStats] = useState<number | null>(null);
  const [editRowStats, setEditRowStats] = useState<string[] | null>(null);

  const [archiveTerms, setArchiveTerms] = useState<ArchiveMetaItem[]>([]);
  const [archiveTermId, setArchiveTermId] = useState<string>("");
  const [archiveCount, setArchiveCount] = useState<string[][]>([]);
  const [archiveStats, setArchiveStats] = useState<string[][]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  // --- Add Row state (left panel - enlisted courses) ---
  const [addingRow, setAddingRow] = useState(false);
  const [newCareer, setNewCareer] = useState<"UGB" | "GSM">("UGB"); // uses SelectBox now
  const [newCode, setNewCode] = useState<string>("");
  const [newCourseCode, setNewCourseCode] = useState("");
  const [newCount, setNewCount] = useState<string>("0");


  const archiveLabel = (t: ArchiveMetaItem) => `Term ${t.term_number ?? "—"} · ${t.ay_label}`;

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);
  const fullName = user?.fullName ?? "APO";
  // NOTE: login roles are normalized from user_roles.role_type and typically do NOT include campus.
  // We keep this as a legacy fallback only. The reliable campus comes from backend meta (activeMeta.campus_label).
  const campusName = campusFromRoles(user?.roles || []); // legacy fallback

  // SAFETY UX: if we can't detect campus from role/meta/data, allow user to pick it once.
  // This is stored on this device (per-user) so imports + views remain campus-scoped.
  const campusOverrideKey = user?.userId
    ? `apo.preenCampusOverride.${user.userId}`
    : "apo.preenCampusOverride";
  const [campusOverride, setCampusOverride] = useState<"" | "MANILA" | "LAGUNA">(() => {
    try {
      const v = window.localStorage.getItem(campusOverrideKey);
      return v === "MANILA" || v === "LAGUNA" ? v : "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(campusOverrideKey);
      const norm = v === "MANILA" || v === "LAGUNA" ? v : "";
      setCampusOverride(norm);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusOverrideKey]);

  const setCampusOverridePersist = (v: "" | "MANILA" | "LAGUNA") => {
    setCampusOverride(v);
    try {
      if (!v) window.localStorage.removeItem(campusOverrideKey);
      else window.localStorage.setItem(campusOverrideKey, v);
    } catch {
      // ignore
    }
  };
  const roleName = useMemo(() => {
    if (!user?.roles) return "Academic Programming Officer";
    return (user.roles as string[]).some((r) => /^apo\b/i.test(r))
      ? "Academic Programming Officer"
      : user.roles[0] || "User";
  }, [user]);

  useEffect(() => {
    (async () => {
      if (!user?.userId) {
        setErr("Not logged in.");
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setErr(null);
        await refresh();
      } catch (e: any) {
        setErr(e?.message || "Failed to load pre-enlistment data.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.userId, campusName, campusOverride]);

  const headerLabel = activeMeta ? `Term ${activeMeta.term_number ?? ""} ${activeMeta.ay_label}` : "";
  const campusLabel = activeMeta?.campus_label
    ? activeMeta.campus_label
    : campusOverride === "MANILA"
    ? "Manila"
    : campusOverride === "LAGUNA"
    ? "Laguna"
    : campusName === "MANILA"
    ? "Manila"
    : campusName === "LAGUNA"
    ? "Laguna"
    : "";

  const normalizeProgramCode = (s: PreenlistmentStatDoc) =>
    (s as any).program_code ?? (s as any)?.programs?.program_code ?? "";

const refresh = async (forcedTermId?: string) => {
  if (!user?.userId) return;

  // If a termId is forced (e.g. after re-activate / archive), use that.
  // Otherwise, let the backend decide the planning term
  // (it will pick "next after is_current").
  const termToLoad = forcedTermId;

  // Prefer explicit campus override (saved on this device), then role-based legacy fallback.
  const campusFilter = (campusOverride || campusName || undefined) as
    | "MANILA"
    | "LAGUNA"
    | undefined;

  const { count, statistics, meta } = await getApoPreenlistment(
    user.userId,
    termToLoad,
    "active",
    campusFilter
  );

  const termMeta = (meta as TermMeta) ?? null;
  setActiveMeta(termMeta);

  // Use backend campus_label for storage key when available.
  const campusKey = normCampus(termMeta?.campus_label) || campusFilter || campusName;
  if (campusKey && termMeta?.term_id) {
    setPlanningTermForCampus(campusKey, termMeta.term_id);
  }

  setEnlistedCourses(
    (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
      d.preenlistment_code || "",
      d.career || "",                  // UGB / GSM as-is
      (d as any).acad_group || "",     // CSV 'Acad Group' or college_code
      d.campus_name || "",
      d.course_code || "",
      String((d as any).count ?? 0),
    ])
  );

  setEnrollmentStats(
    (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
      normalizeProgramCode(s),
      String(s.freshman ?? 0),
      String(s.sophomore ?? 0),
      String(s.junior ?? 0),
      String(s.senior ?? 0),
    ])
  );
};

  const startEditCourses = (i: number) => {
    setEditIndexCourses(i);
    setEditRowCourses([...(enlistedCourses[i] || [])]);
  };
  const saveEditCourses = async () => {
    if (editIndexCourses !== null && editRowCourses) {
      const updated = [...enlistedCourses];
      updated[editIndexCourses] = editRowCourses;

      const missingCodeIdx = updated.findIndex((r) => !(r?.[0] || "").trim());
      if (missingCodeIdx !== -1) {
        setErr(`Code is required (row ${missingCodeIdx + 1}).`);
        return;
      }

      setEnlistedCourses(updated);
      setEditIndexCourses(null);
      setEditRowCourses(null);

      try {
        if (!user?.userId) throw new Error("Not logged in");
        const rows: CountCsvRow[] = updated.map((r) => ({
          Code: r[0] || "",
          Career: r[1],                 // keep UGB/GSM for display
          "Acad Group": r[2],           // keep CSV code for display
          Campus: (r[3] as "MANILA" | "LAGUNA") || (campusName as "MANILA" | "LAGUNA"),
          "Course Code": r[4],
          Count: Number(r[5] ?? 0),
        }));
        await importApoPreenlistment(
          user.userId,
          rows,
          [],
          activeMeta?.term_id,
          { replaceCount: true },
          campusCodeFromUi() || undefined
        );
        await refresh();
      } catch (e) {
        console.error(e);
        setErr((e as Error).message || "Failed to save");
      }
    }
  };
const saveNewCourseRow = async () => {
  if (!user?.userId) {
    setErr("Not logged in.");
    return;
  }

  // Campus comes from role (MANILA/LAGUNA). Fallback: activeMeta campus_label (Title Case → UPPER)
  const campusCSV = (
    campusName || (activeMeta?.campus_label?.toUpperCase() as "MANILA" | "LAGUNA")
  ) as "MANILA" | "LAGUNA";
  if (!campusCSV) {
    setErr("Campus is required (cannot infer).");
    return;
  }

  if (!newCourseCode.trim()) {
    setErr("Course Code is required.");
    return;
  }

  if (!newCode.trim()) {
    setErr("Code is required.");
    return;
  }

  try {
    setErr(null);

    const rows: CountCsvRow[] = [{
      Code: newCode.trim(),
      Career: newCareer,                    // "UGB" | "GSM"
      "Acad Group": "CCS",                  // fixed as requested
      Campus: campusCSV,                    // fixed from role
      "Course Code": newCourseCode.trim().toUpperCase(),
      Count: Number(newCount || 0),
    }];

    const res = await importApoPreenlistment(
      user.userId,
      rows,
      [],
      activeMeta?.term_id,
      { replaceCount: false },
      campusCodeFromUi() || undefined
    );

    if (!res || (res.insertedCount ?? 0) < 1) {
      setErr("Add failed: course not found or invalid fields. Check the Course Code.");
      return;
    }

    // reset UI
    setAddingRow(false);
    setNewCode("");
    setNewCourseCode("");
    setNewCount("0");
    setNewCareer("UGB");

    await refresh();
  } catch (e: any) {
    console.error(e);
    setErr(e?.message || "Failed to add row.");
  }
};

  const startEditStats = (i: number) => {
    setEditIndexStats(i);
    setEditRowStats([...(enrollmentStats[i] || [])]);
  };
  const saveEditStats = async () => {
    if (editIndexStats !== null && editRowStats) {
      const updated = [...enrollmentStats];
      updated[editIndexStats] = editRowStats;
      setEnrollmentStats(updated);
      setEditIndexStats(null);
      setEditRowStats(null);

      try {
        if (!user?.userId) throw new Error("Not logged in");
        const rows: StatCsvRow[] = updated.map((r) => ({
          Program: r[0],
          FRESHMAN: Number(r[1] ?? 0),
          SOPHOMORE: Number(r[2] ?? 0),
          JUNIOR: Number(r[3] ?? 0),
          SENIOR: Number(r[4] ?? 0),
        }));
        await importApoPreenlistment(
          user.userId,
          [],
          rows,
          activeMeta?.term_id,
          { replaceStats: true },
          campusCodeFromUi() || undefined
        );
        await refresh();
      } catch (e) {
        console.error(e);
        setErr((e as Error).message || "Failed to save");
      }
    }
  };

/*  const handleImportCourses = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user?.userId) return;
    Papa.parse<CountCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results: ParseResult<CountCsvRow>) => {
        const rows = results.data
          .map((r) => {
            if (!r.Campus && campusName) (r as any).Campus = campusName;
            return r;
          })
          .filter((r) => r["Course Code"] && r.Career && r.Campus && r.Count !== undefined);
        await importApoPreenlistment(
          user.userId,
          rows,
          [],
          activeMeta?.term_id,
          { replaceCount: true },
          campusName || undefined
        );
        await refresh();
      },
    });
  };
  
   const handleImportStats = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user?.userId) return;
    Papa.parse<StatCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results: ParseResult<StatCsvRow>) => {
        const rows = results.data.filter((r) => !!r.Program);
        await importApoPreenlistment(
          user.userId,
          [],
          rows,
          activeMeta?.term_id,
          { replaceStats: true },
          campusName || undefined
        );
        await refresh();
      },
    });
  };

  
  
  */

 // Minimal shape we actually use
type CsvResult<T> = {
  data: T[];
  errors?: unknown[];
  meta?: any;
};

const parseCsvFile = async <T,>(file: File): Promise<CsvResult<T>> =>
  await new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results: any) => resolve(results as CsvResult<T>),
      error: (err: unknown) => reject(err),
    });
  });

const normCampus = (v: any): "MANILA" | "LAGUNA" | null => {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "MANILA") return "MANILA";
  if (s === "LAGUNA") return "LAGUNA";
  return null;
};

const campusCodeFromUi = (): "MANILA" | "LAGUNA" | null => {
  // Prefer backend meta (always title-case: Manila/Laguna when configured)
  const fromMeta = normCampus(activeMeta?.campus_label);
  if (fromMeta) return fromMeta;
  // Safety override chosen by the user (stored locally)
  if (campusOverride === "MANILA" || campusOverride === "LAGUNA") return campusOverride;
  // Legacy fallback (only works if role_type includes campus)
  if (campusName) return campusName;
  // Last-resort: infer from currently displayed rows (column 3 is campus name)
  const anyRowCampus = (enlistedCourses?.[0]?.[3] || "") as any;
  return normCampus(anyRowCampus);
};

const downloadCsv = (filename: string, csv: string) => {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const downloadCountTemplate = () => {
  const campusCode = campusCodeFromUi();
  if (!campusCode) {
    setImportModalError("Please select a campus first (Manila/Laguna), then download the template.");
    return;
  }
  const campusTitle = campusCode === "LAGUNA" ? "Laguna" : "Manila";
  const csv = [
    "Code,Career,Acad Group,Campus,Course Code,Count",
    `1,UGB,CCS,${campusTitle},CCPROG1,40`,
    `2,GSM,CCS,${campusTitle},MSDS,25`,
  ].join("\n");
  downloadCsv(`preenlistment_count_TEMPLATE_${campusTitle}.csv`, csv);
};

const downloadStatsTemplate = () => {
  const csv = [
    "Program,FRESHMAN,SOPHOMORE,JUNIOR,SENIOR",
    "BSCS-ST,106,92,87,76",
  ].join("\n");
  downloadCsv("preenlistment_statistics_TEMPLATE.csv", csv);
};

const apiErrorToMessage = (e: any): string => {
  const resp = e?.response?.data;
  const detail = resp?.detail ?? resp;
  if (typeof detail === "string") return detail;
  if (detail?.message && Array.isArray(detail?.errors)) {
    const lines = (detail.errors as string[]).slice(0, 8);
    return [detail.message, ...lines.map((x) => `• ${x}`)].join("\n");
  }
  if (detail?.message) return detail.message;
  return e?.message || "Import failed.";
};

const [showImportModal, setShowImportModal] = useState(false);
const [importKind, setImportKind] = useState<"count" | "stats">("count");
const [importBusy, setImportBusy] = useState(false);
const [importModalError, setImportModalError] = useState<string>("");
  const importFileRef = React.useRef<HTMLInputElement | null>(null);

const openImport = (kind: "count" | "stats") => {
  setImportKind(kind);
  setImportModalError("");
  setShowImportModal(true);
};

const closeImport = () => {
  if (importBusy) return;
  setShowImportModal(false);
  setImportModalError("");
};

const importCountCsvFile = async (file: File) => {
  if (!file || !user?.userId) return;

  const required = ["Code", "Career", "Acad Group", "Campus", "Course Code", "Count"];
  const results = await parseCsvFile<CountCsvRow>(file);
  const fields: string[] = (results?.meta?.fields || []) as string[];

  const missing = required.filter((h) => !fields.includes(h));
  if (missing.length) {
    throw new Error(
      `Missing required column(s): ${missing.join(", ")}\n\nExpected columns: ${required.join(", ")}`
    );
  }

  const rows = (results.data || [])
    .map((r: any) => {
      // normalize keys + keep raw values
      const campusRaw = r.Campus ?? r["Campus"];
      const codeRaw = r.Code ?? r["Code"];
      return {
        ...r,
        Code: String(codeRaw ?? "").trim(),
        Campus: campusRaw,
      } as CountCsvRow;
    })
    .filter(
      (r: any) => r.Code && r["Course Code"] && r.Career && r.Campus && r.Count !== undefined
    );

  // Frontend campus guard (prevents cross-campus pollution)
  const campusSelected = campusCodeFromUi();
  if (!campusSelected) {
    throw new Error(
      "Campus cannot be determined yet. Please select your campus (Manila/Laguna) in the import dialog, then try again."
    );
  }

  const mismatched = new Set<string>();
  for (const r of rows as any[]) {
    const c = normCampus((r as any).Campus);
    if (!c) mismatched.add(String((r as any).Campus ?? ""));
    else if (c !== campusSelected) mismatched.add(String((r as any).Campus ?? ""));
  }
  if (mismatched.size) {
    throw new Error(
      `This file appears to be for a different campus.\n\nSelected campus: ${campusSelected}\nFound campus value(s): ${[
        ...mismatched,
      ].join(", ")}`
    );
  }

  await importApoPreenlistment(
    user.userId,
    rows,
    [],
    activeMeta?.term_id,
    { replaceCount: true },
    campusSelected
  );
};

const importStatsCsvFile = async (file: File) => {
  if (!file || !user?.userId) return;

  const required = ["Program", "FRESHMAN", "SOPHOMORE", "JUNIOR", "SENIOR"];
  const results = await parseCsvFile<StatCsvRow>(file);
  const fields: string[] = (results?.meta?.fields || []) as string[];

  const missing = required.filter((h) => !fields.includes(h));
  if (missing.length) {
    throw new Error(
      `Missing required column(s): ${missing.join(", ")}\n\nExpected columns: ${required.join(", ")}`
    );
  }

  const rows = (results.data || []).filter((r: any) => !!r.Program);

  const campusSelected = campusCodeFromUi();
  if (!campusSelected) {
    throw new Error(
      "Campus cannot be determined yet. Please select your campus (Manila/Laguna) in the import dialog, then try again."
    );
  }

  await importApoPreenlistment(
    user.userId,
    [],
    rows,
    activeMeta?.term_id,
    { replaceStats: true },
    campusSelected
  );
};


const [archiveCountTotal, setArchiveCountTotal] = useState(0);
  const [archiveStatsTotals, setArchiveStatsTotals] = useState([0, 0, 0, 0]);

  const calcArchiveTotals = (countRows: string[][], statRows: string[][]) => {
    setArchiveCountTotal(countRows.reduce((sum, r) => sum + (parseInt(r[4] as string, 10) || 0), 0));
    const sums = [0, 0, 0, 0];
    statRows.forEach((r) => {
      sums[0] += parseInt(r[1] as string, 10) || 0;
      sums[1] += parseInt(r[2] as string, 10) || 0;
      sums[2] += parseInt(r[3] as string, 10) || 0;
      sums[3] += parseInt(r[4] as string, 10) || 0;
    });
    setArchiveStatsTotals(sums);
  };

  const moveToArchives = async () => {
    if (!user?.userId) return;
    const label = activeMeta
      ? `Term ${activeMeta.term_number ?? ""} ${activeMeta.ay_label}`
      : "current term";

  if (!confirm(`Archive ${label}? This will snapshot active rows for BOTH Manila and Laguna and may advance the term.`)) {
    return;
  }

    try {
      setArchiving(true);

      // Archive the *same* planning term you are currently viewing
      const res = await archiveApoPreenlistment(
        user.userId,
        activeMeta?.term_id,
        campusCodeFromUi() || undefined
      );

      const nextPlanningTermId = (res as any)?.newPlanningTermId as string | undefined;

      // If backend tells us the next planning term, load that explicitly.
      // Otherwise, let the backend compute it from is_current.
      if (nextPlanningTermId) {
        await refresh(nextPlanningTermId);
      } else {
        await refresh();
      }
    } catch (e: any) {
      setErr(e?.message || "Failed to archive.");
    } finally {
      setArchiving(false);
    }
  };

  const goToArchives = async () => {
    if (!user?.userId) return;
    setView("archives");
    setArchiveLoading(true);
    try {
      const campusFilter = campusCodeFromUi() || undefined;
      const { archives } = await getApoPreenlistmentMeta(user.userId, campusFilter);
      setArchiveTerms(archives);
      const firstTid = archives[0]?.term_id ?? "";
      setArchiveTermId(firstTid);
      if (firstTid) {
        const { count, statistics } = await getApoPreenlistment(
          user.userId,
          firstTid,
          "archive",
          campusFilter
        );
        const countRows = (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
          d.career || "",
          (d as any).acad_group || "",
          d.campus_name || "",
          d.course_code || "",
          String((d as any).count ?? 0),
        ]);
        const statRows = (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
          normalizeProgramCode(s),
          String(s.freshman ?? 0),
          String(s.sophomore ?? 0),
          String(s.junior ?? 0),
          String(s.senior ?? 0),
        ]);
        setArchiveCount(countRows);
        setArchiveStats(statRows);
        calcArchiveTotals(countRows, statRows);
      } else {
        setArchiveCount([]);
        setArchiveStats([]);
        calcArchiveTotals([], []);
      }
    } finally {
      setArchiveLoading(false);
    }
  };

  const changeArchiveTerm = async (label: string) => {
    if (!user?.userId) return;
    const picked = archiveTerms.find((t) => archiveLabel(t) === label);
    const tid = picked?.term_id ?? "";
    setArchiveTermId(tid);
    setArchiveLoading(true);
    try {
      const { count, statistics } = await getApoPreenlistment(
        user.userId,
        tid,
        "archive",
        campusCodeFromUi() || undefined
      );
      const countRows = (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
        d.career || "",
        (d as any).acad_group || "",
        d.campus_name || "",
        d.course_code || "",
        String((d as any).count ?? 0),
      ]);
      const statRows = (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
        normalizeProgramCode(s),
        String(s.freshman ?? 0),
        String(s.sophomore ?? 0),
        String(s.junior ?? 0),
        String(s.senior ?? 0),
      ]);
      setArchiveCount(countRows);
      setArchiveStats(statRows);
      calcArchiveTotals(countRows, statRows);
    } finally {
      setArchiveLoading(false);
    }
  };

  const exportCsv = (filename: string, headers: string[], rows: (string | number)[][]) => {
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar
        fullName={fullName}
        role={campusLabel ? `${roleName} | ${campusLabel}` : roleName}
        inboxPath="/apo/inbox"
      />
      <Tabs
        mode="nav"
        items={[
          { label: "Pre-Enlistment", to: "/apo/preenlistment" },
          { label: "Course Offerings", to: "/apo/courseofferings" },
          { label: "Room Allocation", to: "/apo/roomallocation" },
        ]}
      />

      <main className="p-6 w-full">
{showImportModal && (
  <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
    <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
      <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
        <Upload className="h-8 w-8" strokeWidth={2.5} />
      </div>

      <h3 className="mb-2 text-center text-2xl font-semibold">
        {importKind === "count"
          ? "Import Pre-Enlistment Count CSV"
          : "Import Pre-Enlistment Statistics CSV"}
      </h3>

      <p className="mx-auto mb-4 max-w-md text-center text-sm text-neutral-600">
        This will replace the current{" "}
        <span className="font-semibold">
          {importKind === "count" ? "course counts" : "program statistics"}
        </span>{" "}
        for <span className="font-semibold">{campusLabel || campusName || "Selected campus"}</span>{" "}
        {headerLabel ? `(${headerLabel})` : ""}.
      </p>

      {/* SAFETY UX: allow campus selection if we can't reliably detect it from the user/account yet */}
      {!normCampus(activeMeta?.campus_label) && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="mb-1 font-semibold">Select campus</div>
          <p className="text-xs text-amber-900/80">
            We couldn’t detect your campus from your account yet. Choose the campus you’re importing for.
            This will be saved on this device for future imports.
          </p>

          <div className="mt-2 flex items-center gap-2">
            <MiniSelectMenu
              value={campusOverride || normCampus((enlistedCourses?.[0]?.[3] || "") as any) || campusName || ""}
              onChange={(v) => setCampusOverridePersist(normCampus(v) || "")}
              options={["MANILA", "LAGUNA"]}
              placeholder="Choose campus"
              className="min-w-[170px]"
            />

            {!!campusOverride && (
              <button
                type="button"
                onClick={() => setCampusOverridePersist("")}
                className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                <X className="h-4 w-4" />
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <div className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <div className="mb-1 font-semibold">CSV format</div>
        {importKind === "count" ? (
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Required columns: <span className="font-mono">Code</span>,{" "}
              <span className="font-mono">Career</span>,{" "}
              <span className="font-mono">Acad Group</span>,{" "}
              <span className="font-mono">Campus</span>,{" "}
              <span className="font-mono">Course Code</span>,{" "}
              <span className="font-mono">Count</span>
            </li>
            <li>
              <span className="font-mono">Campus</span> must be{" "}
              <span className="font-semibold">{campusLabel || campusName || "Selected campus"}</span>{" "}
              for every row.
            </li>
            <li>
              <span className="font-mono">Career</span> must be{" "}
              <span className="font-mono">UGB/UGS</span> or{" "}
              <span className="font-mono">GSM</span>.
            </li>
            <li className="text-emerald-800/80">
              Example row: <span className="font-mono">1, UGB, CCS, {campusLabel || "Manila"}, ADART-2, 31</span>
            </li>
          </ul>
        ) : (
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Required columns: <span className="font-mono">Program</span>,{" "}
              <span className="font-mono">FRESHMAN</span>,{" "}
              <span className="font-mono">SOPHOMORE</span>,{" "}
              <span className="font-mono">JUNIOR</span>,{" "}
              <span className="font-mono">SENIOR</span>
            </li>
            <li>
              Programs must be offered under{" "}
              <span className="font-semibold">{campusLabel || campusName || "Selected campus"}</span>{" "}
              (validated via the curriculum campus).
            </li>
            <li className="text-emerald-800/80">
              Example row: <span className="font-mono">BSCS-ST, 106, 92, 87, 76</span>
            </li>
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => (importKind === "count" ? downloadCountTemplate() : downloadStatsTemplate())}
            disabled={importKind === "count" && !campusCodeFromUi()}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="h-4 w-4" />
            Download CSV template
          </button>

          <span className="text-xs text-emerald-900/70">
            Use the template to avoid wrong columns / formatting.
          </span>
        </div>
      </div>

      {importModalError && (
        <div className="mb-4 whitespace-pre-line rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {importModalError}
        </div>
      )}

      <input
        ref={importFileRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.currentTarget.value = "";
          if (!file) return;

          setImportBusy(true);
          setImportModalError("");
          try {
            if (importKind === "count") {
              await importCountCsvFile(file);
            } else {
              await importStatsCsvFile(file);
            }
            setErr(null);
            await refresh();
            setShowImportModal(false);
          } catch (err: any) {
            const msg = apiErrorToMessage(err);
            setImportModalError(msg);
            // Keep a short persistent banner on the page
            setErr(msg.split("\n")[0] || msg);
          } finally {
            setImportBusy(false);
          }
        }}
      />

      <div className="flex justify-end gap-2">
        <button
          onClick={closeImport}
          disabled={importBusy}
          className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200 disabled:opacity-50"
        >
          Cancel
        </button>

        <button
          disabled={importBusy || !campusCodeFromUi()}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => importFileRef.current?.click()}
        >
          <Upload className="h-4 w-4" />
          {importBusy ? "Importing…" : campusCodeFromUi() ? "Choose File" : "Choose campus first"}
        </button>
      </div>
    </div>
  </div>
)}

        <div className="mb-3 flex items-center gap-2">
          <button
            className={`rounded-md px-3 py-2 text-sm border ${view === "active" ? "bg-white border-gray-300 shadow-sm" : "bg-transparent border-transparent text-gray-500"}`}
            onClick={() => setView("active")}
          >
            Active
          </button>

          <button
            className={`rounded-md px-3 py-2 text-sm border ${view === "archives" ? "bg-white border-gray-300 shadow-sm" : "bg-transparent border-transparent text-gray-500"}`}
            onClick={goToArchives}
          >
            Archived Data
          </button>

          {view === "active" && (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={moveToArchives}
                disabled={archiving}
                className="inline-flex items-center gap-2 rounded-md border border-red-300 text-red-700 hover:bg-red-50 px-3 py-2 text-sm"
                title="Snapshot and advance term"
              >
                <Archive className="h-4 w-4" />
                Move to Archives
              </button>
            </div>
          )}
        </div>

        {view === "active" && (
          <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-6 w-full">
            <div className="mb-3 text-sm">
              {loading && <span className="text-gray-500">Loading pre-enlistment data…</span>}
              {err && !loading && <span className="text-red-600">{err}</span>}
            </div>

            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold">Pre-Enlistment</h2>
                <p className="text-sm text-gray-500">{headerLabel}</p>
              </div>
            </div>

            <div className="flex flex-col md:flex-row">
              {/* left */}
              <section className="flex-1 max-h-[420px] overflow-y-auto pr-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-semibold">List of Enlisted Courses</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openImport("count")}
                      className="inline-flex items-center gap-2 rounded-md bg-[#008e4e] px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110"
                    >
                      <Upload className="h-4 w-4" />
                      Import CSV
                    </button>
                    <button
                      onClick={() => {
                        setErr(null);
                        setAddingRow((v) => {
                          const next = !v;
                          if (next) {
                            setNewCode(String((enlistedCourses?.length || 0) + 1));
                          }
                          return next;
                        });
                      }}
                      className="inline-flex items-center gap-2 rounded-md border border-emerald-300 text-emerald-700 bg-white px-3 py-2 text-sm hover:bg-emerald-50"
                      title="Add a single course row"
                    >
                      + Add
                    </button>
                  </div>
                </div>

                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500 border-b">
                    <tr>
                      <th className="py-2">No.</th>
                      <th className="py-2">Code</th>
                      <th className="py-2">Career</th>
                      <th className="py-2">Acad Group</th>
                      <th className="py-2">Campus</th>
                      <th className="py-2">Course Code</th>
                      <th className="py-2">Count</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-700">
                    {addingRow && (
                      <tr className="bg-emerald-50/60 border-t">
                        {/* No. */}
                        <td className="py-2 px-2">—</td>

                        {/* Code — required */}
                        <td className="py-2 px-2">
                          <MiniFieldInput
                            value={newCode}
                            onChange={(v) => setNewCode(v)}
                            placeholder="Code"
                            className="w-[90px]"
                          />
                        </td>

                        {/* Career — compact select with matching style */}
                        <td className="py-2 px-2">
                          <MiniSelectMenu
                            value={newCareer}
                            onChange={(v) => setNewCareer((v as "UGB" | "GSM") || "UGB")}
                            options={["UGB", "GSM"]}
                            className="w-[110px]"
                          />
                        </td>

                        {/* Acad Group — fixed pill */}
                        <td className="py-2 px-2">
                          <span className="inline-flex items-center rounded-full border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700">
                            CCS
                          </span>
                        </td>

                        {/* Campus — fixed pill */}
                        <td className="py-2 px-2">
                          <span className="inline-flex items-center rounded-full border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700">
                            {activeMeta?.campus_label || (campusName === "MANILA" ? "Manila" : "Laguna")}
                          </span>
                        </td>

                        {/* Course Code — compact input, no chevron */}
                        <td className="py-2 px-2">
                          <MiniCourseCodeCombobox
                            userId={user?.userId}
                            value={newCourseCode}
                            onChange={(v: string) => setNewCourseCode(v.toUpperCase())}
                            career={newCareer}
                            placeholder="Course Code"
                            className="w-[150px]"
                          />
                        </td>

                        {/* Count — compact input, no chevron */}
                        <td className="py-2 px-2">
                          <MiniFieldInput
                            value={newCount}
                            onChange={(v) => setNewCount(v.replace(/[^\d]/g, ""))}
                            placeholder="0"
                            type="number"
                            className="w-[80px]"
                          />
                        </td>

                        {/* Actions — exact styles you provided */}
                        <td className="py-2 px-2 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              onClick={saveNewCourseRow}
                              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                              title="Save"
                            >
                              <Check className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                            <button
                              onClick={() => {
                                setAddingRow(false);
                                setNewCode("");
                                setNewCourseCode("");
                                setNewCount("0");
                                setNewCareer("UGB");
                              }}
                              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                              title="Cancel"
                            >
                              <X className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    

                    {enlistedCourses.map((row, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                        <td className="py-2 px-2">{i + 1}</td>
                        {row.map((cell, j) => (
                          <td key={j} className="py-2 px-2 whitespace-nowrap">
                            {editIndexCourses === i && (j === 0 || j === 5) ? (
                              <input
                                value={editRowCourses?.[j] ?? ""}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                  const copy = [...(editRowCourses ?? [])];
                                  copy[j] = e.target.value;
                                  setEditRowCourses(copy);
                                }}
                                type={j === 5 ? "number" : "text"}
                                className={
                                  j === 5
                                    ? "w-full px-2 py-1 text-sm rounded-md border border-gray-300 focus:ring-1 focus:ring-emerald-500"
                                    : "w-[90px] px-2 py-1 text-sm rounded-md border border-gray-300 focus:ring-1 focus:ring-emerald-500"
                                }
                              />
                            ) : (
                              cell
                            )}
                          </td>
                        ))}
                        <td className="py-2 px-2 text-center">
                          {editIndexCourses === i ? (
                            <button
                              onClick={saveEditCourses}
                              className="h-7 w-7 flex items-center justify-center rounded-full border border-green-600 text-green-600 hover:bg-green-50"
                              title="Save"
                            >
                              <Check className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                          ) : (
                            <button
                              onClick={() => startEditCourses(i)}
                              className="text-gray-500 hover:text-black"
                              title="Edit count"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}

                    {enlistedCourses.length === 0 && !addingRow && (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-gray-500">
                          No rows yet — import a CSV.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>

              <div className="my-6 md:my-0 md:mx-6 border-t md:border-t-0 md:border-l border-gray-300"></div>

              {/* right */}
              <section className="flex-1 max-h-[420px] overflow-y-auto pl-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-semibold">Enrollment Statistics</h3>
                  <button
                      type="button"
                      onClick={() => openImport("stats")}
                      className="inline-flex items-center gap-2 rounded-md bg-[#008e4e] px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110"
                    >
                      <Upload className="h-4 w-4" />
                      Import CSV
                    </button>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500 border-b">
                    <tr>
                      <th className="py-2">Program</th>
                      <th className="py-2">Freshman</th>
                      <th className="py-2">Sophomore</th>
                      <th className="py-2">Junior</th>
                      <th className="py-2">Senior</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody className="text-gray-700">
                    {enrollmentStats.map((row, i) => (
                      <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                        {row.map((cell, j) => (
                          <td key={j} className="py-2 px-2 whitespace-nowrap">
                            {editIndexStats === i && j > 0 ? (
                              <input
                                value={editRowStats?.[j] ?? ""}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                  const copy = [...(editRowStats ?? [])];
                                  copy[j] = e.target.value;
                                  setEditRowStats(copy);
                                }}
                                type="number"
                                className="w-full px-2 py-1 text-sm rounded-md border border-gray-300 focus:ring-1 focus:ring-emerald-500"
                              />
                            ) : (
                              cell
                            )}
                          </td>
                        ))}
                        <td className="py-2 px-2 text-center">
                          {editIndexStats === i ? (
                            <button
                              onClick={saveEditStats}
                              className="h-7 w-7 flex items-center justify-center rounded-full border border-green-600 text-green-600 hover:bg-green-50"
                              title="Save"
                            >
                              <Check className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                          ) : (
                            <button
                              onClick={() => startEditStats(i)}
                              className="text-gray-500 hover:text-black"
                              title="Edit stats"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {enrollmentStats.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-gray-500">
                          No data.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        )}

        {view === "archives" && (
          <div className="rounded-2xl bg-white shadow-sm border border-neutral-200 p-6 w-full">
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <h3 className="text-lg font-semibold">Archived Data</h3>

              <div className="ml-6 flex items-center gap-3">
                <label className="text-sm text-gray-600">Term / AY</label>
                <SelectBox
                  value={
                    archiveTermId && archiveTerms.length
                      ? archiveLabel(archiveTerms.find((x) => x.term_id === archiveTermId)!)
                      : ""
                  }
                  onChange={(label) => changeArchiveTerm(label)}
                  options={archiveTerms.map(archiveLabel)}
                  placeholder="— Select Term —"
                  className="w-[280px]"
                  disabled={archiveLoading}
                />
                {archiveLoading && <span className="text-sm text-gray-500">Loading…</span>}
              </div>

              <div className="ml-auto">
                <button
                  className="inline-flex items-center gap-2 rounded-md border border-emerald-300 text-emerald-700 bg-white/80 px-3 py-2 text-sm hover:bg-emerald-50 disabled:opacity-50"
                  disabled={!archiveTermId || reactivating}
                  title="Make this archived term the current active term"
                  onClick={async () => {
                    if (!user?.userId || !archiveTermId) return;
                    const sel = archiveTerms.find(t => t.term_id === archiveTermId);
                    const label = sel ? `Term ${sel.term_number ?? "—"} ${sel.ay_label}` : archiveTermId;
                    if (!confirm(`Make ${label} the active term${campusLabel ? ` for ${campusLabel}` : ""}?`)) return;

                    setReactivating(true);
                    try {
                      const res = await reactivateApoPreenlistment(
                        user.userId,
                        archiveTermId,
                        campusCodeFromUi() || undefined
                      );
                      const planningTermId =
                        (res as any)?.planningTermId || archiveTermId;

                      setView("active");
                      // Show the planning term associated with this archive
                      await refresh(planningTermId);
                    } catch (e: any) {
                      setErr(e?.message || "Failed to reactivate term.");
                    } finally {
                      setReactivating(false);
                    }
                  }}
                >
                  {reactivating ? "Reactivating…" : "Make Active"}
                </button>
              </div>

            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Enlisted Courses */}
              <div className="border rounded-xl overflow-hidden shadow-[0_1px_10px_-6px_rgba(0,0,0,0.25)]">
                <div className="flex items-center justify-between gap-3 px-4 py-2 border-b bg-neutral-50/70">
                  <div className="font-medium text-neutral-800">List of Enlisted Courses</div>
                  <button
                    onClick={() => {
                      const sel = archiveTerms.find(t => t.term_id === archiveTermId);
                      const base = sel
                        ? `Term-${sel.term_number ?? "—"}_${sel.ay_label.replaceAll(" ", "-")}`
                        : (archiveTermId || "term");
                      exportCsv(
                        `${base}-courses.csv`,
                        ["Career", "Acad Group", "Campus", "Course Code", "Count"],
                        archiveCount
                      );
                    }}
                    className="inline-flex items-center gap-2 rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm hover:bg-neutral-50"
                    title="Export CSV"
                  >
                    <Download className="h-4 w-4" />
                    Export
                  </button>
                </div>

                <div className="max-h-[460px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur text-left text-xs text-neutral-500 border-b">
                      <tr>
                        <th className="py-2.5 px-3">Career</th>
                        <th className="py-2.5 px-3">Acad Group</th>
                        <th className="py-2.5 px-3">Campus</th>
                        <th className="py-2.5 px-3">Course Code</th>
                        <th className="py-2.5 px-3 text-right">Count</th>
                      </tr>
                    </thead>
                    <tbody className="text-neutral-800">
                      {archiveCount.map((r, i) => (
                        <tr
                          key={i}
                          className="border-b last:border-0 odd:bg-white even:bg-neutral-50/60 hover:bg-emerald-50/40 transition-colors"
                        >
                          <td className="py-2.5 px-3">{r[0]}</td>
                          <td className="py-2.5 px-3">{r[1]}</td>
                          <td className="py-2.5 px-3">{r[2]}</td>
                          <td className="py-2.5 px-3">{r[3]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[4]}</td>
                        </tr>
                      ))}
                      {archiveCount.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-gray-500">
                            No data.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="px-4 py-2 text-sm text-neutral-700 border-t bg-neutral-50/70">
                  Total Count: <strong className="tabular-nums">{archiveCountTotal}</strong>
                </div>
              </div>

              {/* Enrollment Statistics */}
              <div className="border rounded-xl overflow-hidden shadow-[0_1px_10px_-6px_rgba(0,0,0,0.25)]">
                <div className="flex items-center justify-between gap-3 px-4 py-2 border-b bg-neutral-50/70">
                  <div className="font-medium text-neutral-800">Enrollment Statistics</div>
                  <button
                    onClick={() => {
                      const sel = archiveTerms.find(t => t.term_id === archiveTermId);
                      const base = sel
                        ? `Term-${sel.term_number ?? "—"}_${sel.ay_label.replaceAll(" ", "-")}`
                        : (archiveTermId || "term");
                      exportCsv(
                        `${base}-stats.csv`,
                        ["Program", "Freshman", "Sophomore", "Junior", "Senior"],
                        archiveStats
                      );
                    }}
                    className="inline-flex items-center gap-2 rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm hover:bg-neutral-50"
                    title="Export CSV"
                  >
                    <Download className="h-4 w-4" />
                    Export
                  </button>
                </div>

                <div className="max-h-[460px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur text-left text-xs text-neutral-500 border-b">
                      <tr>
                        <th className="py-2.5 px-3">Program</th>
                        <th className="py-2.5 px-3 text-right">Freshman</th>
                        <th className="py-2.5 px-3 text-right">Sophomore</th>
                        <th className="py-2.5 px-3 text-right">Junior</th>
                        <th className="py-2.5 px-3 text-right">Senior</th>
                      </tr>
                    </thead>
                    <tbody className="text-neutral-800">
                      {archiveStats.map((r, i) => (
                        <tr
                          key={i}
                          className="border-b last:border-0 odd:bg-white even:bg-neutral-50/60 hover:bg-emerald-50/40 transition-colors"
                        >
                          <td className="py-2.5 px-3">{r[0]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[1]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[2]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[3]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[4]}</td>
                        </tr>
                      ))}
                      {archiveStats.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-gray-500">
                            No data.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="px-4 py-2 text-sm text-neutral-700 border-t bg-neutral-50/70">
                  Totals — F: <strong className="tabular-nums">{archiveStatsTotals[0]}</strong>
                  &nbsp; S: <strong className="tabular-nums">{archiveStatsTotals[1]}</strong>
                  &nbsp; J: <strong className="tabular-nums">{archiveStatsTotals[2]}</strong>
                  &nbsp; SR: <strong className="tabular-nums">{archiveStatsTotals[3]}</strong>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}