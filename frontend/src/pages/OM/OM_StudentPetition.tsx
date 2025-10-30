import { useEffect, useState } from "react";
import AppShell from "../../base/AppShell";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import { Send, Check, Search as SearchIcon, Edit } from "lucide-react";
import {
  getOMSPHeader,
  getOMSPOptions,
  listOMSP,
  updateOMSPCourse,
  bulkForwardOMSP,
  type OMPetitionRow,
  type OMPetitionOptions,
} from "../../api";

// simple textbox
function TextBox({
  value, onChange, placeholder = "Enter text...", className = "", disabled = false, multiline = false,
}: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; disabled?: boolean; multiline?: boolean; }) {
  return (
    <div className={className}>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          rows={3}
          className={cls(
            "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm resize-none",
            "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
            disabled && "cursor-not-allowed bg-gray-100 text-gray-400 opacity-70"
          )}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={cls(
            "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
            "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
            disabled && "cursor-not-allowed bg-gray-100 text-gray-400 opacity-70"
          )}
        />
      )}
    </div>
  );
}

export default function OM_StudentPetition() {
  // Topbar (values passed to AppShell)
  const [topName, setTopName] = useState<string>();
  const [topSub, setTopSub] = useState<string>();

  // filters
  const [status, setStatus] = useState("All Status");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // options
  const [statuses, setStatuses] = useState<string[]>(["All Status"]);
  const [activeTermLabel, setActiveTermLabel] = useState<string>("");

  // table
  const [rows, setRows] = useState<OMPetitionRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // edit state
  const [editCourseId, setEditCourseId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status?: string; remarks?: string }>({});

  // load topbar identity from DB
  useEffect(() => {
    (async () => {
      try {
        const cached = JSON.parse(localStorage.getItem("animo.user") || "null");
        const hdr = await getOMSPHeader({ userEmail: cached?.email || cached?.userEmail, userId: cached?.userId });
        if (hdr?.ok) {
          setTopName(hdr.profileName || "");
          setTopSub(hdr.profileSubtitle || "");
        }
      } catch { /* no-op */ }
    })();
  }, []);

  // load options (statuses + active term)
  useEffect(() => {
    (async () => {
      try {
        const opt: OMPetitionOptions = await getOMSPOptions();
        if (!opt.ok) throw new Error("Failed to load options");
        setStatuses(["All Status", ...(opt.statuses || [])]);
        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setActiveTermLabel(ay ? `AY ${ay}-${ay + 1} · Term ${tn ?? "—"}` : "");
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // fetch rows when filters change
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const { ok, rows } = await listOMSP({ status, search });
        if (!ok) throw new Error("Failed to load petitions.");
        setRows(rows);
        setSelected((sel) => sel.filter((cid) => rows.some((r) => r.course_id === cid)));
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load petitions.");
      } finally {
        setLoading(false);
      }
    })();
  }, [status, search]);

  const toggleAll = (checked: boolean) => setSelected(checked ? rows.map((r) => r.course_id) : []);

  const beginEdit = (row: OMPetitionRow) => {
    setEditCourseId(row.course_id);
    setDraft({ status: row.status, remarks: row.remarks || "" });
  };

  const saveEdit = async () => {
    if (!editCourseId) return;
    try {
      setLoading(true);
      setErr("");
      await updateOMSPCourse(editCourseId, draft);
      const { rows } = await listOMSP({ status, search });
      setRows(rows);
      setEditCourseId(null);
      setDraft({});
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to update course petitions.");
    } finally {
      setLoading(false);
    }
  };

  const forwardSelected = async () => {
    if (!selected.length) return;
    try {
      setLoading(true);
      setErr("");
      const target = statuses.find((s) => s.toLowerCase().startsWith("forwarded")) || "Forwarded To Department";
      await bulkForwardOMSP(selected, target);
      const { rows } = await listOMSP({ status, search });
      setRows(rows);
      setSelected([]);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to forward petitions.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppShell topbarProfileName={topName} topbarProfileSubtitle={topSub}>
      <main className="w-full px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">Student Petition</h1>
          <p className="text-sm text-gray-600">
            Manage course section requests {activeTermLabel && `for ${activeTermLabel}`}
          </p>
        </header>

        {err && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {err}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          <div className="relative flex-1 min-w-[240px]">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by course code or title…"
              className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>

          <SelectBox value={status} onChange={setStatus} options={statuses} />

          <button
            onClick={forwardSelected}
            disabled={!selected.length || loading}
            className={cls(
              "ml-auto inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white shadow-sm",
              selected.length ? "bg-emerald-700 hover:brightness-110" : "bg-gray-300 cursor-not-allowed"
            )}
          >
            <Send className="h-4 w-4" />
            Forward
          </button>
        </div>

        {/* Table */}
        <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-gray-700">
              <tr>
                <th className="w-10 px-4 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && selected.length === rows.length}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                  />
                </th>
                <th className="text-left px-4 py-2">Course Code & Title</th>
                <th className="text-center px-4 py-2">Petition Count</th>
                <th className="text-center px-4 py-2">Status</th>
                <th className="text-left px-4 py-2 w-[40%]">Remarks</th>
                <th className="w-10 px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                <tr><td className="px-4 py-6 text-center text-gray-500" colSpan={6}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td className="px-4 py-6 text-center text-gray-500" colSpan={6}>No results</td></tr>
              ) : (
                rows.map((r) => {
                  const editing = editCourseId === r.course_id;
                  return (
                    <tr key={r.course_id} className="hover:bg-gray-50 align-top">
                      <td className="text-center pt-3">
                        <input
                          type="checkbox"
                          checked={selected.includes(r.course_id)}
                          onChange={() =>
                            setSelected((prev) =>
                              prev.includes(r.course_id)
                                ? prev.filter((id) => id !== r.course_id)
                                : [...prev, r.course_id]
                            )
                          }
                          className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                        />
                      </td>

                      <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                        {r.course_code}
                        <div className="text-xs text-gray-500">{r.course_title}</div>
                      </td>

                      <td className="text-center pt-3">{r.count}</td>

                      <td className="text-center pt-3">
                        {editing ? (
                          <SelectBox
                            value={draft.status || ""}
                            onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                            options={statuses.filter((s) => s !== "All Status")}
                          />
                        ) : (
                          <span
                            className={cls(
                              "inline-block rounded-full px-3 py-1 text-xs font-semibold",
                              r.status?.toLowerCase().includes("reject") ? "bg-red-100 text-red-700"
                              : r.status?.toLowerCase().includes("open") ? "bg-green-100 text-green-700"
                              : "bg-yellow-100 text-yellow-700"
                            )}
                          >
                            {r.status || "—"}
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-2 text-left">
                        {editing ? (
                          <TextBox
                            value={draft.remarks || ""}
                            onChange={(v) => setDraft((d) => ({ ...d, remarks: v }))}
                            placeholder="Add remarks…"
                            multiline
                            className="w-full"
                          />
                        ) : (
                          <span className="text-gray-700 block whitespace-pre-wrap">
                            {r.remarks || <span className="text-gray-400">—</span>}
                          </span>
                        )}
                      </td>

                      <td className="text-center pt-3">
                        {editing ? (
                          <button
                            onClick={saveEdit}
                            className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => beginEdit(r)}
                            className="text-emerald-700 hover:brightness-110"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </main>
    </AppShell>
  );
}
