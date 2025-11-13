import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Send, ChevronDown, X } from "lucide-react";
import {
  // You can keep using your existing API layer;
  // these already work with the original endpoints.
  getFSOptions,
  listFacultyService,
  respondFacultyService,
  rejectFacultyService,
  type FacultyServiceRow,
  type ToDept,
  type DayShort,
} from "@/api";

/* ---------------- tiny utils ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const toast = (msg: string) => alert(msg);

/** unify control heights */
const CONTROL =
  "h-10 w-full rounded-md border border-gray-300 px-3 text-[13px] shadow-sm focus:ring-2 focus:ring-emerald-500/30";

/** shared table look */
const SHARED_TABLE = "w-full table-fixed border-collapse text-[13px]";
const CELL = "px-4 py-2 align-middle";
const TH = "px-4 py-2 font-medium text-xs text-gray-600 tracking-wide text-center";

/* ---------------- Dropdown (portal-less, fixed-positioned) ---------------- */
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
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [menuRect, setMenuRect] = useState<{ left: number; top: number; width: number; place: "down" | "up" }>();

  const shown = useMemo(() => {
    const list = options || [];
    if (!searchable) return list;
    const q = term.trim().toLowerCase();
    return q ? list.filter((o) => o.toLowerCase().includes(q)) : list;
  }, [options, term, searchable]);

  const compute = () => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const estMenuH = Math.min(48 + shown.length * 36, Math.floor(vh * 0.6));
    const roomBelow = vh - r.bottom;
    const place: "down" | "up" = roomBelow >= estMenuH || r.top < estMenuH ? "down" : "up";
    const width = Math.max(r.width, 220);
    const left = Math.max(8, Math.min(vw - width - 8, align === "right" ? r.right - width : r.left));
    const top = place === "down" ? Math.min(vh - 8, r.bottom + 8) : Math.max(8, r.top - 8);
    setMenuRect({ left, top, width, place });
  };

  // Close when clicking outside
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open) return;
      const t = e.target as Node;
      if (boxRef.current?.contains(t)) return;
      const menu = document.getElementById(menuId);
      if (!menu || !menu.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Recompute on open/resize/scroll
  useLayoutEffect(() => {
    if (!open) return;
    compute();
    const onResize = () => compute();
    const onScroll = () => compute();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    inputRef.current?.focus();
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, term, align, shown.length]);

  const menuId = useMemo(() => `dd-${Math.random().toString(36).slice(2)}`, []);

  // value shown in the input
  const inputValue = searchable ? (open ? term : value) : value;
  const effectivePlaceholder = open && value && !term ? value : placeholder;

  const openFresh = () => {
    setTerm("");
    setOpen(true);
    requestAnimationFrame(() => {
      compute();
      inputRef.current?.focus();
    });
  };

  const onPick = (opt: string) => {
    onChange(opt);
    setTerm("");
    setOpen(false);
  };

  return (
    <div className={cls("relative", className)} ref={boxRef}>
      <div className="relative">
        <input
          ref={inputRef}
          value={inputValue}
          // Use onMouseDown so it fires before document's mousedown closer
          onMouseDown={(e) => {
            if (!open) {
              e.preventDefault(); // keep focus on input
              openFresh();
            }
          }}
          onFocus={() => {
            if (!open) openFresh();
          }}
          onChange={(e) => {
            if (searchable) {
              setTerm(e.target.value);
              if (!open) setOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !open) {
              openFresh();
              e.preventDefault();
            }
            if (e.key === "Enter" && shown.length > 0) onPick(shown[0]);
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder={effectivePlaceholder}
          className={cls(CONTROL, "pr-16 truncate")}
          title={value || undefined}
        />

        {/* Clear search */}
        {searchable && open && term && (
          <button
            type="button"
            onClick={() => {
              setTerm("");
              requestAnimationFrame(() => {
                compute();
                inputRef.current?.focus();
              });
            }}
            className="absolute right-8 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-neutral-100"
            aria-label="Clear"
            title="Clear"
          >
            <X className="h-4 w-4 text-neutral-500" />
          </button>
        )}

        {/* Chevron toggle */}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()} // keep focus
          onClick={() => (open ? setOpen(false) : openFresh())}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-neutral-100"
          aria-label="Toggle menu"
          title="Toggle"
        >
          <ChevronDown className="h-4 w-4 text-neutral-500" />
        </button>
      </div>

      {open && menuRect && (
        <div
          id={menuId}
          style={{
            position: "fixed",
            left: menuRect.left,
            top: menuRect.place === "down" ? menuRect.top : undefined,
            bottom: menuRect.place === "up" ? window.innerHeight - menuRect.top : undefined,
            width: menuRect.width,
            maxHeight: "60vh",
          }}
          className={cls(
            "z-[9999] overflow-auto rounded-xl border border-neutral-300 bg-white",
            "shadow-[0_8px_24px_rgba(0,0,0,0.15)] overscroll-contain py-1"
          )}
        >
          {shown.map((opt) => (
            <button
              key={opt}
              onClick={() => onPick(opt)}
              className={cls(
                "block w-full truncate px-3 py-2 text-left text-[13px] hover:bg-emerald-50/60 transition-colors",
                value === opt && "bg-emerald-100 text-emerald-800 font-medium"
              )}
              title={opt}
            >
              {opt}
            </button>
          ))}
          {shown.length === 0 && (
            <div className="px-3 py-2 text-[13px] text-neutral-500">No results</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Spec constants ---------------- */
const DAY_OPTIONS: DayShort[] = ["M", "T", "W", "H", "F", "S"];

const BEGIN_OPTIONS = ["07:30", "09:15", "11:00", "12:45", "14:30", "16:15", "18:00", "19:45"] as const;
const END_BY_BEGIN: Record<(typeof BEGIN_OPTIONS)[number], string> = {
  "07:30": "09:00",
  "09:15": "10:45",
  "11:00": "12:30",
  "12:45": "14:15",
  "14:30": "16:00",
  "16:15": "17:45",
  "18:00": "19:30",
  "19:45": "21:00",
};

/** full receiver layout (14 columns) */
const COLS_14 = [
  "25ch", // Course Code
  "40ch", // Course Title
  "10ch", // Units
  "40ch", // From
  "40ch", // To
  "40ch", // Faculty
  "15ch", // Day1
  "15ch", // Begin1
  "15ch", // End1
  "15ch", // Day2
  "15ch", // Begin2
  "15ch", // End2
  "30ch", // Remarks
  "12ch", // Action/Status
];
function ColGroup14() {
  return (
    <colgroup>
      {COLS_14.map((w, i) => (
        <col key={i} style={{ width: w }} />
      ))}
    </colgroup>
  );
}

function facultyLabel(f?: { first_name?: string; last_name?: string; email?: string }) {
  if (!f) return "";
  const L = (f.last_name || "").toUpperCase();
  const F = (f.first_name || "").toUpperCase();
  return (L || F) ? `${L}, ${F}${f.email ? ` (${f.email})` : ""}` : "";
}

export default function CHAIR_ServiceReciever() {
  // Keep topbar/sidebar behavior: we don’t touch layout—this page just renders inside your shell.
  const user = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  }, []);

  const userDeptName: string =
    user?.department || user?.department_name || user?.dept_name || "Department of Software Technology";

  const [timeBegins] = useState<string[]>([..."07:30,09:15,11:00,12:45,14:30,16:15,18:00,19:45".split(",")]);

  const [facultyCache, setFacultyCache] = useState<
    Record<string, { faculty_id: string; first_name: string; last_name: string; email?: string }[]>
  >({});

  type ReceiverEdit = {
    faculty?: { faculty_id?: string; first_name?: string; last_name?: string; email?: string };
    day1: DayShort | "";
    begin1: string | "";
    end1: string | "";
    day2: DayShort | "";
    begin2: string | "";
    end2: string | "";
    remarks: string;
  };
  const [edits, setEdits] = useState<Record<string, ReceiverEdit>>({});
  const getEdit = (id: string): ReceiverEdit =>
    edits[id] || { day1: "", begin1: "", end1: "", day2: "", begin2: "", end2: "", remarks: "" };
  const patchEdit = (id: string, patch: Partial<ReceiverEdit>) =>
    setEdits((p) => ({ ...p, [id]: { ...getEdit(id), ...patch } }));

  const [rows, setRows] = useState<FacultyServiceRow[]>([]);
  const [loadingList, setLoadingList] = useState(false);

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
    } catch {}
  }

  async function refresh() {
    setLoadingList(true);
    try {
      // Only received requests for this department
        const r = await listFacultyService({ dept: userDeptName });
        if (r?.ok) {
        const onlyReceived = (r.rows || []).filter(
            (row: FacultyServiceRow) => row.to_department === userDeptName
        );
        setRows(onlyReceived);
        }
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    ensureFacultyForDept(userDeptName);
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userDeptName]);

  function friendlyError(e: any) {
    const m =
      e?.response?.data?.detail ||
      e?.response?.data?.message ||
      e?.message ||
      "Something went wrong.";
    return typeof m === "string" ? m : JSON.stringify(m);
  }

  async function handleSendBack(fs_id: string, dept: string) {
    const e = getEdit(fs_id);
    try {
      if (!e.faculty?.faculty_id && !e.faculty?.email) {
        toast("Select a faculty.");
        return;
      }
      await respondFacultyService(fs_id, {
        faculty: e.faculty || {},
        day1: e.day1,
        begin1: e.begin1,
        end1: e.end1,
        day2: e.day2,
        begin2: e.begin2,
        end2: e.end2,
        remarks: e.remarks,
      });

      setEdits((p) => ({
        ...p,
        [fs_id]: { day1: "", begin1: "", end1: "", day2: "", begin2: "", end2: "", remarks: "" },
      }));
      await refresh();
      ensureFacultyForDept(dept);
      toast("Sent back to requesting department.");
    } catch (err: any) {
      toast(friendlyError(err));
    }
  }

  async function handleReject(fs_id: string) {
    try {
      await rejectFacultyService(fs_id, { remarks: getEdit(fs_id).remarks || "" });
      await refresh();
      toast("Request rejected.");
    } catch (err: any) {
      toast(friendlyError(err));
    }
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900 px-8 py-8">
      {/* Your app’s TopBar & Sidebar remain as-is; this is just the page body */}
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Service — Receiver</h1>
        <p className="text-sm text-neutral-600">
          Review requests sent to <span className="font-medium">{userDeptName}</span>, assign available faculty, and respond.
        </p>
      </header>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-x-auto overflow-y-visible">
        <div className="px-5 pt-4 text-[13px] text-neutral-600">Received Requests</div>
        <table className={cls(SHARED_TABLE, "border-t border-gray-200")}>
          <ColGroup14 />
          <thead className="bg-neutral-50">
            <tr>
              <th className={TH}>Course Code</th>
              <th className={TH}>Course Title</th>
              <th className={TH}>Units</th>
              <th className={TH}>From</th>
              <th className={TH}>To</th>
              <th className={TH}>Faculty</th>
              <th className={TH}>Day1</th>
              <th className={TH}>Begin1</th>
              <th className={TH}>End1</th>
              <th className={TH}>Day2</th>
              <th className={TH}>Begin2</th>
              <th className={TH}>End2</th>
              <th className={TH}>Remarks</th>
              <th className={TH}>Action</th>
            </tr>
          </thead>

          <tbody className="text-gray-800">
            {rows.map((r, idx) => {
              const fsid = r.fs_id!;
              const dept = r.to_department || "";
              const e = getEdit(fsid);
              const facultyOptions = facultyCache[dept] || [];
              const isClosed = r.status === "responded" || r.status === "rejected";

              return (
                <tr
                  key={fsid}
                  className={cls("align-middle", idx % 2 === 0 ? "bg-white" : "bg-gray-50", "border-b border-gray-200")}
                  onMouseEnter={() => ensureFacultyForDept(dept)}
                >
                  <td className={cls(CELL, "text-center")}>
                    <span className="font-semibold text-emerald-700">{r.course_code}</span>
                  </td>
                  <td className={CELL}>
                    <span className="block whitespace-normal break-words" title={r.course_title}>
                      {r.course_title}
                    </span>
                  </td>

                  <td className={cls(CELL, "text-center tabular-nums")}>{r.units ?? ""}</td>
                  <td className={cls(CELL, "text-center truncate")} title={r.from_department}>
                    {r.from_department}
                  </td>
                  <td className={cls(CELL, "text-center truncate")} title={r.to_department}>
                    {r.to_department}
                  </td>

                  {/* Faculty */}
                  <td className={CELL}>
                    {!isClosed ? (
                      <Dropdown
                        value={facultyLabel(e.faculty)}
                        onChange={(label) => {
                          const match = facultyOptions.find((f) => facultyLabel(f) === label);
                          if (match) {
                            patchEdit(fsid, {
                              faculty: {
                                faculty_id: match.faculty_id,
                                first_name: match.first_name,
                                last_name: match.last_name,
                                email: match.email,
                              },
                            });
                          }
                        }}
                        options={facultyOptions.map((f) => facultyLabel(f)).filter(Boolean)}
                        placeholder={facultyOptions.length ? "Select faculty…" : "Loading…"}
                        searchable
                      />
                    ) : (
                      <span className="block truncate text-center" title={facultyLabel(r.faculty as any)}>
                        {facultyLabel(r.faculty as any) || "—"}
                      </span>
                    )}
                  </td>

                  {/* Day/Begin/End */}
                  <td className={cls(CELL, "text-center")}>
                    {!isClosed ? (
                      <Dropdown value={e.day1} onChange={(v) => patchEdit(fsid, { day1: v as DayShort })} options={DAY_OPTIONS} placeholder="—" />
                    ) : (
                      r.day1 || "—"
                    )}
                  </td>
                  <td className={cls(CELL, "text-center")}>
                    {!isClosed ? (
                      <Dropdown
                        value={e.begin1}
                        onChange={(v) => patchEdit(fsid, { begin1: v, end1: END_BY_BEGIN[v as keyof typeof END_BY_BEGIN] })}
                        options={timeBegins}
                        placeholder="—"
                        align="right"
                      />
                    ) : (
                      r.begin1 || "—"
                    )}
                  </td>
                  <td className={cls(CELL, "text-center")}>
                    {!isClosed ? (
                      <input value={e.end1 ? String(e.end1) : ""} readOnly className={cls(CONTROL, "text-center bg-neutral-50")} placeholder="—" />
                    ) : (
                      r.end1 || "—"
                    )}
                  </td>
                  <td className={cls(CELL, "text-center")}>
                    {!isClosed ? (
                      <Dropdown value={e.day2} onChange={(v) => patchEdit(fsid, { day2: v as DayShort })} options={DAY_OPTIONS} placeholder="—" />
                    ) : (
                      r.day2 || "—"
                    )}
                  </td>
                  <td className={cls(CELL, "text-center")}>
                    {!isClosed ? (
                      <Dropdown
                        value={e.begin2}
                        onChange={(v) => patchEdit(fsid, { begin2: v, end2: END_BY_BEGIN[v as keyof typeof END_BY_BEGIN] })}
                        options={timeBegins}
                        placeholder="—"
                        align="right"
                      />
                    ) : (
                      r.begin2 || "—"
                    )}
                  </td>
                  <td className={cls(CELL, "text-center")}>
                    {!isClosed ? (
                      <input value={e.end2 ? String(e.end2) : ""} readOnly className={cls(CONTROL, "text-center bg-neutral-50")} placeholder="—" />
                    ) : (
                      r.end2 || "—"
                    )}
                  </td>

                  {/* Remarks */}
                  <td className={CELL}>
                    {!isClosed ? (
                      <input
                        value={e.remarks}
                        onChange={(ev) => patchEdit(fsid, { remarks: ev.target.value })}
                        placeholder="Enter remarks…"
                        className={CONTROL}
                      />
                    ) : (
                      <span className="block whitespace-normal break-words" title={r.remarks || ""}>
                        {r.remarks || "—"}
                      </span>
                    )}
                  </td>

                  {/* Action */}
                  <td className={cls(CELL, "text-center")}>
                    {!isClosed ? (
                      <div className="flex items-center justify-center gap-3">
                        {(() => {
                          const canRespond = !!(e.faculty?.faculty_id || e.faculty?.email);
                          return (
                            <button
                              className={cls(
                                "inline-flex h-10 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium shadow-sm",
                                canRespond ? "bg-[#008e4e] text-white hover:brightness-110" : "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                              )}
                              disabled={!canRespond}
                              onClick={() => handleSendBack(fsid, dept)}
                              title="Send"
                            >
                              <Send className="h-4 w-4" />
                              Send
                            </button>
                          );
                        })()}

                        <button
                          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-red-600 px-3 text-[13px] font-medium text-white shadow-sm hover:brightness-110"
                          onClick={() => handleReject(fsid)}
                          title="Reject"
                        >
                          <X className="h-4 w-4" />
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span
                        className={cls(
                          "inline-block rounded-full px-2 py-[2px] text-[12px]",
                          r.status === "responded" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                        )}
                      >
                        {r.status === "responded" ? "Responded" : "Rejected"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}

            {rows.length === 0 && !loadingList && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-gray-500" colSpan={14}>
                  No received requests for your department.
                </td>
              </tr>
            )}
            {loadingList && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-gray-500" colSpan={14}>
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
