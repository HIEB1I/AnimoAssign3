import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Users,
  Building2,
  Eye,
  Pencil,
  ChevronDown,
  ChevronUp,
  Search,
  FlaskConical,
  ArrowLeft,
  Plus,
} from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import {
  getApoRoomAllocation,
  setRoomAvailability,
  assignRoom,
  unassignRoom,
  addRoom,
} from "../../api";

/* ---------------- Types ---------------- */
type Day = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";
type RoomType = "Classroom" | "ComLab";

type RoomCell = {
  day: Day;
  time_band: string;          // "HH:MM – HH:MM"
  section_id?: string | null; // assigned section for that cell
  allowed?: boolean;
};

type RoomItem = {
  room_id: string;
  room_number: string;
  building: string;
  campus_id: string;
  room_type: RoomType | string;
  capacity: number;
  status?: string;
  schedule: RoomCell[];       // only "allowed" cells (availability placeholders or assigned)
};

type SectionDoc = {
  section_id: string;
  section_code: string;
  course_id?: string;
  course_code?: string;
};

type SectionSched = { section_id: string; day: Day; time_band: string };
type CourseDoc = { course_id: string; course_code: string[] | string };
type FacultyInfo = { faculty_id: string; faculty_name: string };

type RoomAllocationResponse = {
  campus: { campus_id: string; campus_name: string };
  buildings: string[];
  timeBands: string[];
  rooms: RoomItem[];
  sections: SectionDoc[];
  sectionSchedules: SectionSched[];
  facultyBySection: Record<string, FacultyInfo>;
  courses?: CourseDoc[];
};

/* ---------------- Utilities ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const chipClass =
  "inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700";

const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ROOM_TYPES: RoomType[] = ["Classroom", "ComLab"];

/* ---------------- MultiSelect ---------------- */
function MultiSelect({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (vals: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const toggle = (opt: string) =>
    value.includes(opt) ? onChange(value.filter((v) => v !== opt)) : onChange([...value, opt]);

  return (
    <div className="w-full">
      <label className="mb-1 block text-sm font-medium">{label}</label>
      <div className="relative">
        <button
          ref={btnRef}
          type="button"
          onClick={() => !disabled && setOpen((o) => !o)}
          disabled={disabled}
          className={cls(
            "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          <span className={value.length ? "" : "text-gray-400"}>
            {value.length ? `${value.length} selected` : "— Select option —"}
          </span>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2" />
        </button>
        {open && !disabled && (
          <div
            ref={listRef}
            className="absolute z-20 mt-2 max-h-64 w-full overflow-auto rounded-xl border border-gray-300 bg-white p-1 shadow-xl"
          >
            {options.map((opt) => {
              const checked = value.includes(opt);
              return (
                <label
                  key={opt}
                  className={cls(
                    "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm",
                    checked ? "bg-emerald-50" : "hover:bg-neutral-50"
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                    checked={checked}
                    onChange={() => toggle(opt)}
                  />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {value.map((v) => (
            <span key={v} className={chipClass}>
              {v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Allocate Class Modal ---------------- */
function AllocateClassModal({
  room,
  day,
  timeBand,
  onSave,
  onCancel,
  sections,
  sectionSchedules,
  rooms,
  facultyBySection,
  coursesMap,
  saving,
  allocError,
}: {
  room: RoomItem;
  day: Day;
  timeBand: string;
  onSave: (section_id: string) => void;
  onCancel: () => void;
  sections: SectionDoc[];
  sectionSchedules: SectionSched[];
  rooms: RoomItem[];
  facultyBySection: Record<string, FacultyInfo>;
  coursesMap: Record<string, string>;
  saving: boolean;
  allocError: string | null;
}) {
  const [selectedLabel, setSelectedLabel] = useState<string>("");

  const assigned = useMemo(() => {
    const set = new Set<string>();
    rooms.forEach((r) =>
      r.schedule.forEach((cell) => {
        if (cell.section_id) set.add(`${cell.section_id}|${cell.day}|${cell.time_band}`);
      })
    );
    return set;
  }, [rooms]);

  const matchingSectionIds = useMemo(
    () => sectionSchedules.filter((s) => s.day === day && s.time_band === timeBand).map((s) => s.section_id),
    [sectionSchedules, day, timeBand]
  );

  const availableSections = useMemo(
    () =>
      sections.filter((sec) => {
        if (!matchingSectionIds.includes(sec.section_id)) return false;
        const key = `${sec.section_id}|${day}|${timeBand}`;
        return !assigned.has(key);
      }),
    [sections, matchingSectionIds, assigned, day, timeBand]
  );

  const labelToId = useMemo(() => {
    const m: Record<string, string> = {};
    availableSections.forEach((s) => {
      const code = s.course_code ?? (s.course_id ? coursesMap[s.course_id] : "");
      m[`${code} - ${s.section_code}`] = s.section_id;
    });
    return m;
  }, [availableSections, coursesMap]);

  const labels = useMemo(() => Object.keys(labelToId).sort(), [labelToId]);
  const sectionId = selectedLabel ? labelToId[selectedLabel] : "";

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-3 text-lg font-semibold text-emerald-700">Allocate Room for Section</h3>
        <p className="text-sm text-gray-600 mb-2">
          <span className="font-medium">{room.room_number}</span> – {day}, {timeBand}
        </p>

        <SelectBox
          value={selectedLabel}
          onChange={setSelectedLabel}
          options={labels}
          placeholder={labels.length ? "Select Section" : "No sections available for this time"}
          disabled={!labels.length}
        />

        {sectionId && (
          <div className="mt-3 text-xs text-gray-600">
            {(() => {
              const sec = sections.find((s) => s.section_id === sectionId);
              const fac = facultyBySection[sectionId];
              const code = sec?.course_code ?? (sec?.course_id ? coursesMap[sec.course_id] : "");
              return (
                <>
                  <div><span className="font-medium">Course:</span> {code || "—"}</div>
                  <div><span className="font-medium">Section:</span> {sec?.section_code || "—"}</div>
                  <div><span className="font-medium">Faculty:</span> {fac ? fac.faculty_name : "—"}</div>
                </>
              );
            })()}
          </div>
        )}

        {/* Error banner (shown when assign fails) */}
        {allocError && (
          <div className="mb-3 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {allocError}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
          >
            Cancel
          </button>
          <button
            disabled={!sectionId || saving}
            onClick={() => onSave(sectionId)}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Add Room Modal ---------------- */
function AddRoomModal({
  buildings,
  defaultBuilding,
  campusName,
  onClose,
  onSaved,
}: {
  buildings: string[];
  defaultBuilding?: string;
  campusName: string;
  onClose: () => void;
  onSaved: (newBuilding: string) => void;
}) {
  // Use *all* buildings (except the synthetic "All Buildings") from backend
  const existingBuildings = useMemo(
    () => buildings.filter((b) => b && b !== "All Buildings"),
    [buildings]
  );

  const [building, setBuilding] = useState<string>(
    defaultBuilding && defaultBuilding !== "All Buildings" ? defaultBuilding : existingBuildings[0] || ""
  );
  const [roomNumber, setRoomNumber] = useState("");
  const [roomType, setRoomType] = useState<RoomType>("Classroom");
  const [capacity, setCapacity] = useState<number | "">("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);

  const canSave =
    !!building.trim() &&
    !!roomNumber.trim() &&
    roomType.length > 0 &&
    typeof capacity === "number" &&
    capacity > 0 &&
    !!user?.userId;

  const submit = async () => {
    if (!canSave) return;
    try {
      setSaving(true);
      setErr(null);
      await addRoom(user.userId, {
        building: building.trim(),
        room_number: roomNumber.trim(),
        room_type: roomType,
        capacity: Number(capacity),
      });
      onSaved(building.trim());
      onClose();
    } catch (e: any) {
      setErr(e?.message || "Failed to add room.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-2 text-lg font-semibold text-emerald-700">Add Room</h3>
        <p className="mb-4 text-sm text-gray-600">Campus: {campusName} Campus</p>

        {err && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {err}
          </div>
        )}

        <div className="space-y-4 text-sm">
          <div>
            <label className="mb-1 block font-medium">Building</label>
            <SelectBox
              value={building}
              onChange={setBuilding}
              options={existingBuildings}
              placeholder="Select a building"
              className="w-full"
            />
          </div>

          <div>
            <label className="mb-1 block font-medium">Room Number</label>
            <input
              value={roomNumber}
              onChange={(e) => setRoomNumber(e.target.value)}
              placeholder="e.g. GK208"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block font-medium">Room Type</label>
              <SelectBox
                value={roomType}
                onChange={(v) => setRoomType(v as RoomType)}
                options={ROOM_TYPES}
                placeholder="Select type"
              />
            </div>

            <div>
              <label className="mb-1 block font-medium">Capacity</label>
              <input
                type="number"
                min={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="e.g. 40"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
              />
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add Room
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Edit Room Modal ---------------- */
function EditRoomModal({
  room,
  timeBands,
  onClose,
  onSaved,
}: {
  room: RoomItem;
  campusName: string; // kept for prop compatibility with caller
  timeBands: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selectedDay, setSelectedDay] = useState<Day | "">("");
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  useEffect(() => {
    if (selectedDay) {
      const slots = room.schedule.filter((s) => s.day === selectedDay).map((s) => s.time_band);
      setSelectedSlots(slots);
    } else {
      setSelectedSlots([]);
    }
  }, [selectedDay, room.schedule]);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);

  const saveDay = async () => {
    if (!user?.userId || !selectedDay) return;
    await setRoomAvailability(user.userId, {
      room_id: room.room_id,
      day: selectedDay,
      time_bands: selectedSlots,
    });
    await onSaved();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-4 text-xl font-semibold text-emerald-700">Edit Room</h3>
        <div className="space-y-4 text-sm">
          <div className="space-y-2">
            <label className="block text-sm font-medium">Choose day & time slots</label>
            <div className="flex items-start gap-2">
              <div className="flex-1 self-stretch">
                <SelectBox
                  value={selectedDay}
                  onChange={(v) => setSelectedDay(v as Day)}
                  options={DAYS}
                  placeholder="Select day"
                  className="w-full"
                />
              </div>
              <div className="flex-1 self-stretch">
                <MultiSelect
                  label=""
                  options={timeBands}
                  value={selectedSlots}
                  onChange={setSelectedSlots}
                  disabled={!selectedDay}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
          >
            Cancel
          </button>
          <button
            disabled={!selectedDay}
            onClick={saveDay}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Room Schedule Grid ---------------- */
function RoomSchedule({
  room,
  onBack,
  onUpdated,
  timeBands,
  sections,
  sectionSchedules,
  rooms,
  facultyBySection,
  coursesMap,
}: {
  room: RoomItem;
  onBack: () => void;
  onUpdated: (next: RoomItem) => void;
  timeBands: string[];
  sections: SectionDoc[];
  sectionSchedules: SectionSched[];
  rooms: RoomItem[];
  facultyBySection: Record<string, FacultyInfo>;
  coursesMap: Record<string, string>;
}) {
  const [selectedSlot, setSelectedSlot] = useState<{ day: Day; time_band: string } | null>(null);

  const [allocError, setAllocError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);

  const handleAllocate = async (section_id: string) => {
    if (!selectedSlot || !user?.userId) return;
    try {
      setSaving(true);
      setAllocError(null);
      await assignRoom(user.userId, {
        room_id: room.room_id,
        day: selectedSlot.day,
        time_band: selectedSlot.time_band,
        section_id,
      });
      const updatedCells = room.schedule.map((c) =>
        c.day === selectedSlot.day && c.time_band === selectedSlot.time_band ? { ...c, section_id } : c
      );
      onUpdated({ ...room, schedule: updatedCells });
      setSelectedSlot(null);
    } catch (e: any) {
      setAllocError(e?.message || "Failed to assign room.");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (day: Day, time_band: string, section_id?: string | null) => {
    if (!user?.userId || !section_id) return;
    await unassignRoom(user.userId, { room_id: room.room_id, day, time_band, section_id });
    const updatedCells = room.schedule.map((c) =>
      c.day === day && c.time_band === time_band ? { ...c, section_id: null } : c
    );
    onUpdated({ ...room, schedule: updatedCells });
  };

  return (
    <div className="w-full rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-bold">Room Allocation</h2>
      <div className="mb-4 flex items-center gap-2">
        <button onClick={onBack} className="flex items-center gap-2 text-emerald-700 hover:underline">
          <ArrowLeft className="h-5 w-5" />
          <span className="text-lg font-semibold">Back</span>
        </button>
      </div>

      <h2 className="text-lg font-bold mb-1">{room.room_number} Schedule</h2>

      <div className="overflow-x-auto">
        <div className="min-w-[860px] rounded-xl border border-neutral-300">
          <div className="grid grid-cols-[140px_repeat(6,1fr)] bg-emerald-800 text-white">
            <div className="flex items-center justify-center px-3 py-2 text-sm font-semibold">Time</div>
            {DAYS.map((d) => (
              <div key={d} className="flex items-center justify-center px-3 py-2 text-sm font-semibold">
                {d}
              </div>
            ))}
          </div>

          <div className="relative grid grid-cols-[140px_repeat(6,1fr)]" style={{ gridAutoRows: "84px" }}>
            {timeBands.map((band, r) => (
              <React.Fragment key={band}>
                <div
                  className="flex items-center justify-center border-r border-neutral-300 bg-neutral-50 px-2 text-center text-[13px]"
                  style={{ gridColumn: 1, gridRow: r + 1 }}
                >
                  {band}
                </div>

                {DAYS.map((day, c) => {
                  const cell = room.schedule.find((s) => s.day === day && s.time_band === band);
                  const isAllowed = Boolean(cell);
                  const isAssigned = Boolean(cell?.section_id);
                  const sectionId = cell?.section_id || "";
                  const sec = sections.find((s) => s.section_id === sectionId);
                  const fac = facultyBySection[sectionId];
                  const code = sec?.course_code ?? (sec?.course_id ? coursesMap[sec.course_id] : "");

                  let label: React.ReactNode = "—";

                  if (isAssigned && !sec) {
                    // Assigned to a section outside APO's scope
                    label = (
                      <div className="text-center leading-tight">
                        <div className="font-semibold text-[12px]">Occupied</div>
                        <div className="text-[11px] text-neutral-600">Out-of-scope section</div>
                      </div>
                    );
                  } else if (isAssigned) {
                    label = (
                      <div className="text-center leading-tight">
                        <div className="font-semibold text-[12px]">
                          {code || "—"} - {sec?.section_code || "—"}
                        </div>
                        <div className="text-[11px]">{fac?.faculty_name || "—"}</div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={`${day}-${band}`}
                      className={cls(
                        "border border-neutral-300 flex flex-col items-center justify-center text-xs p-1",
                        !isAllowed
                          ? "bg-gray-100 text-gray-400"
                          : isAssigned
                          ? "bg-emerald-50 text-emerald-700 font-medium"
                          : "bg-white text-gray-700"
                      )}
                      style={{ gridColumn: c + 2, gridRow: r + 1 }}
                    >
                      {!isAllowed ? (
                        <>—</>
                      ) : isAssigned ? (
                        <>
                          {label}
                          <div className="flex gap-1 mt-1">
                            <button
                              onClick={() => {
                                setAllocError(null);
                                setSelectedSlot({ day, time_band: band });
                              }}
                              className="text-[11px] rounded-full border border-neutral-200 bg-white/70 px-2 py-0.5 text-neutral-700 hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-emerald-400/20"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleRemove(day, band, sectionId)}
                              className="text-[11px] rounded-full border border-red-200 bg-white/70 px-2 py-0.5 text-red-600 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-400/20"
                            >
                              Remove
                            </button>
                          </div>
                        </>
                      ) : (
                        <button
                          onClick={() => {
                            setAllocError(null);
                            setSelectedSlot({ day, time_band: band });
                          }}
                          className="rounded-md border border-emerald-300/70 bg-emerald-50 text-emerald-700 text-[11px] px-2 py-1 transition hover:bg-emerald-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
                        >
                          + Add Class
                        </button>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {selectedSlot && (
        <AllocateClassModal
          room={room}
          day={selectedSlot.day}
          timeBand={selectedSlot.time_band}
          onSave={handleAllocate}
          onCancel={() => {
            setAllocError(null);
            setSelectedSlot(null);
          }}
          sections={sections}
          sectionSchedules={sectionSchedules}
          rooms={rooms}
          facultyBySection={facultyBySection}
          coursesMap={coursesMap}
          saving={saving}
          allocError={allocError}
        />
      )}
    </div>
  );
}

/* ---------------- Status & availability helpers ---------------- */
function computeStatus(room: RoomItem) {
  const cells = room.schedule || [];
  if (cells.length > 0 && cells.every((s) => s.section_id)) return "Full Slots";
  const avail = cells.filter((s) => !s.section_id).length;
  return cells.length === 0
    ? "No Available Slots"
    : avail > 0
    ? `${avail} Available Slot${avail !== 1 ? "s" : ""}`
    : "No Available Slots";
}
function computeCounts(room: RoomItem) {
  const total = room.schedule.length;
  const assigned = room.schedule.filter((c) => c.section_id).length;
  const open = Math.max(total - assigned, 0);
  return { total, assigned, open };
}
function statusColorClass(statusText: string) {
  if (statusText === "Full Slots") return "text-amber-600";
  if (statusText === "No Available Slots") return "text-red-600";
  return "text-green-600";
}

/* ---------------- Sort helpers ---------------- */
type SortKey = "room" | "building" | "capacity" | "type" | "status" | "avail";
type SortDir = "asc" | "desc";

/* ---------------- Rooms Table ---------------- */
function RoomsTable({
  rooms,
  onView,
  onEdit,
}: {
  rooms: RoomItem[];
  timeBands: string[];
  onView: (r: RoomItem) => void;
  onEdit: (r: RoomItem) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("room");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const sorted = useMemo(() => {
    const copy = [...rooms];
    copy.sort((a, b) => {
      const cmpStr = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
      const { open: oa, total: ta } = computeCounts(a);
      const { open: ob, total: tb } = computeCounts(b);
      const statusA = computeStatus(a);
      const statusB = computeStatus(b);

      let res = 0;
      if (sortKey === "room") res = cmpStr(a.room_number, b.room_number);
      else if (sortKey === "building") res = cmpStr(a.building, b.building);
      else if (sortKey === "capacity") res = a.capacity - b.capacity;
      else if (sortKey === "type") res = cmpStr(a.room_type || "", b.room_type || "");
      else if (sortKey === "status") res = cmpStr(statusA, statusB);
      else if (sortKey === "avail") res = (oa / (ta || 1)) - (ob / (tb || 1));
      return sortDir === "asc" ? res : -res;
    });
    return copy;
  }, [rooms, sortKey, sortDir]);

  const header = (label: string, key: SortKey, alignRight = false) => {
    const active = sortKey === key;
    const Icon = sortDir === "asc" ? ChevronUp : ChevronDown;
    return (
      <button
        onClick={() => setSortKey(key)}
        onDoubleClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
        className={cls(
          "group flex w-full items-center gap-1 font-semibold",
          alignRight ? "justify-end" : "justify-start"
        )}
        title="Click to select; double-click to toggle direction"
      >
        <span>{label}</span>
        <span className={cls("opacity-0 group-hover:opacity-60", active && "opacity-100")}>
          <Icon className="h-3.5 w-3.5" />
        </span>
      </button>
    );
  };

  const btnBase =
    "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-all border shadow-sm focus:outline-none focus:ring-2";
  const btnView =
    `${btnBase} bg-white border-neutral-300 text-neutral-800 hover:bg-neutral-100 focus:ring-neutral-400/30 active:scale-[.98]`;
  const btnEdit =
    `${btnBase} bg-white border-neutral-300 text-neutral-800 hover:bg-neutral-100 focus:ring-neutral-400/30 active:scale-[.98]`;

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200">
      <table className="min-w-full">
        <thead className="bg-neutral-50 sticky top-0 z-10">
          <tr className="text-left text-[13px] text-neutral-700">
            <th className="px-3 py-2 border-b">{header("Room", "room")}</th>
            <th className="px-3 py-2 border-b">{header("Building", "building")}</th>
            <th className="px-3 py-2 border-b">{header("Capacity", "capacity")}</th>
            <th className="px-3 py-2 border-b">{header("Type", "type")}</th>
            <th className="px-3 py-2 border-b">{header("Availability", "avail")}</th>
            <th className="px-3 py-2 border-b">{header("Status", "status", true)}</th>
            <th className="px-3 py-2 border-b w-[240px]">Actions</th>
          </tr>
        </thead>
        <tbody className="text-sm">
          {sorted.map((room, idx) => {
            const statusText = computeStatus(room);
            const { total, open } = computeCounts(room);
            const pct = total ? Math.round((open / total) * 100) : 0;
            const typeIcon =
              (room.room_type as RoomType) === "ComLab" ? (
                <FlaskConical className="h-4 w-4 text-emerald-700" />
              ) : (
                <Building2 className="h-4 w-4 text-emerald-700" />
              );

            return (
              <tr
                key={room.room_id}
                className={cls(idx % 2 === 0 ? "bg-white" : "bg-neutral-50", "hover:bg-emerald-50/40 transition-colors")}
              >
                <td className="px-3 py-2 font-semibold">{room.room_number}</td>
                <td className="px-3 py-2 text-neutral-700">{room.building}</td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1 text-neutral-800">
                    <Users className="h-4 w-4 text-emerald-700" />
                    {room.capacity}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1 text-neutral-800">
                    {typeIcon}
                    <span className="rounded-full border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-[11px]">
                      {room.room_type}
                    </span>
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="min-w-[160px]">
                    <div className="h-2 rounded-full bg-neutral-200 overflow-hidden">
                      <div
                        className="h-2 bg-emerald-600"
                        style={{ width: `${pct}%` }}
                        title={`${open} open / ${total} slots`}
                      />
                    </div>
                    <div className="mt-1 text-[11px] text-neutral-600">{open} open of {total}</div>
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <span className={cls("font-medium", statusColorClass(statusText))}>{statusText}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => onView(room)} className={btnView}>
                      <Eye className="h-4 w-4" />
                      View
                    </button>
                    <button onClick={() => onEdit(room)} className={btnEdit}>
                      <Pencil className="h-4 w-4" />
                      Edit
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {rooms.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-sm text-gray-500">
                No rooms found for this view.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Page ---------------- */
export default function RoomAllocationScreen() {
  const [buildings, setBuildings] = useState<string[]>([]);
  const [building, setBuilding] = useState<string>("All Buildings");
  const [types, setTypes] = useState<string[]>(["All Types"]);
  const [typeFilter, setTypeFilter] = useState<string>("All Types");
  const [search, setSearch] = useState<string>("");

  const [timeBands, setTimeBands] = useState<string[]>([]);
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [sections, setSections] = useState<SectionDoc[]>([]);
  const [sectionSchedules, setSectionSchedules] = useState<SectionSched[]>([]);
  const [facultyBySection, setFacultyBySection] = useState<Record<string, FacultyInfo>>({});
  const [coursesMap, setCoursesMap] = useState<Record<string, string>>({});
  const [campusName, setCampusName] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [editing, setEditing] = useState<RoomItem | null>(null);
  const [viewing, setViewing] = useState<RoomItem | null>(null);
  const [adding, setAdding] = useState(false);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);
  const fullName = user?.fullName ?? "APO";
  const roleName = useMemo(() => {
    if (!user?.roles) return "Academic Programming Officer";
    return user.roles.includes("apo") ? "Academic Programming Officer" : user.roles[0] || "User";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const refresh = async (): Promise<RoomAllocationResponse | null> => {
    if (!user?.userId) return null;
    const data = await getApoRoomAllocation(user.userId);

    setCampusName(data.campus.campus_name || "");
    setTimeBands(data.timeBands);
    setBuildings(["All Buildings", ...data.buildings]);
    setRooms(data.rooms);

    setSections(data.sections);
    setSectionSchedules(data.sectionSchedules);
    setFacultyBySection(data.facultyBySection || {});
    const map: Record<string, string> = {};
    (data.courses ?? []).forEach((c) => {
      const cc = Array.isArray(c.course_code) ? c.course_code[0] : c.course_code;
      if (c.course_id && cc) map[c.course_id] = cc;
    });
    data.sections.forEach((s) => {
      if (s.course_id && s.course_code) map[s.course_id] = s.course_code;
    });
    setCoursesMap(map);

    // derive types present for filter
    const tset = new Set<string>();
    data.rooms.forEach((r) => r.room_type && tset.add(r.room_type));
    setTypes(["All Types", ...Array.from(tset).sort()]);
    return data;
  };

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        await refresh();
      } catch (e: any) {
        setErr(e?.message || "Failed to load room allocation.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredRooms = useMemo(() => {
    let list = rooms;
    if (building !== "All Buildings") {
      list = list.filter((r) => r.building === building);
    }
    if (typeFilter !== "All Types") {
      list = list.filter((r) => (r.room_type || "") === typeFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.room_number.toLowerCase().includes(q) ||
          r.building.toLowerCase().includes(q)
      );
    }
    return list;
  }, [rooms, building, typeFilter, search]);

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role={campusName ? `${roleName} | ${campusName}` : roleName} />
      <Tabs
        mode="nav"
        items={[
          { label: "Pre-Enlistment", to: "/apo/preenlistment" },
          { label: "Course Offerings", to: "/apo/courseofferings" },
          { label: "Room Allocation", to: "/apo/roomallocation" },
        ]}
      />

      <main className="p-6 w-full">
        {!viewing ? (
          <div className="w-full rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="mb-3 text-sm">
              {loading && <span className="text-gray-500">Loading room allocation…</span>}
              {err && !loading && <span className="text-red-600">{err}</span>}
            </div>

            <div className="flex flex-wrap items-center gap-3 justify-between">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-bold">Room Allocation</h2>
              </div>

              <button
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-2 rounded-md bg-[#008e4e] px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110"
              >
                <Plus className="h-4 w-4" />
                Add Room
              </button>
            </div>

            {/* Controls */}
            <div className="mt-4 mb-4 grid gap-3 md:grid-cols-[220px_220px_1fr]">
              <SelectBox value={building} onChange={setBuilding} options={buildings} />
              <SelectBox value={typeFilter} onChange={setTypeFilter} options={types} />
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search room or building…"
                  className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                />
              </div>
            </div>

            {/* Table view */}
            <RoomsTable
              rooms={filteredRooms}
              timeBands={timeBands}
              onView={setViewing}
              onEdit={setEditing}
            />
          </div>
        ) : (
          <RoomSchedule
            room={viewing}
            onBack={() => setViewing(null)}
            onUpdated={(next) => {
              setRooms((prev) => prev.map((r) => (r.room_id === next.room_id ? next : r)));
              setViewing(next);
            }}
            timeBands={timeBands}
            sections={sections}
            sectionSchedules={sectionSchedules}
            rooms={rooms}
            facultyBySection={facultyBySection}
            coursesMap={coursesMap}
          />
        )}
      </main>

      {adding && (
        <AddRoomModal
          buildings={buildings}
          defaultBuilding={building}
          campusName={campusName}
          onClose={() => setAdding(false)}
          onSaved={async (newBuilding) => {
            await refresh();
            if (newBuilding && buildings.includes(newBuilding)) {
              setBuilding(newBuilding);
            } else if (newBuilding) {
              setBuilding("All Buildings");
            }
            setAdding(false);
          }}
        />
      )}

      {editing && (
        <EditRoomModal
          room={editing}
          campusName={campusName}
          timeBands={timeBands}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
          }}
        />
      )}
    </div>
  );
}
