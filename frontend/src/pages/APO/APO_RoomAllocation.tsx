// frontend/src/pages/APO/APO_RoomAllocation.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Users,
  Building2,
  Eye,
  Pencil,
  ChevronDown,
  FlaskConical,
  ArrowLeft,
  Trash2,
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
  removeRoom,
  addRoom,
} from "../../api";

/* ---------------- Types (mirror backend response) ---------------- */
type Day = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";

type RoomCell = {
  day: Day;
  time_band: string;          // "HH:MM – HH:MM"
  section_id?: string | null; // assigned section for that cell
};

type RoomItem = {
  room_id: string;
  room_number: string;
  building: string;
  campus_id: string;
  room_type: "Classroom" | "Lab" | string;
  capacity: number;
  status?: string;
  schedule: RoomCell[];
};

type SectionDoc = {
  section_id: string;
  section_code: string;
  course_id?: string;
  course_code?: string;
};

type SectionSched = {
  section_id: string;
  day: Day;
  time_band: string;
};

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
/** NOTE: day & timeBand are fixed — cannot be edited here */
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
  coursesMap: Record<string, string>; // course_id -> course_code
}) {
  // We show a human label in the SelectBox but keep a mapping to the section_id
  const [selectedLabel, setSelectedLabel] = useState<string>("");

  // sections already assigned in any room at this exact day/time
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

  // label -> section_id map for SelectBox
  const labelToId = useMemo(() => {
    const m: Record<string, string> = {};
    availableSections.forEach((s) => {
      const code = s.course_code ?? (s.course_id ? coursesMap[s.course_id] : "");
      const label = `${code} - ${s.section_code}`;
      m[label] = s.section_id;
    });
    return m;
  }, [availableSections, coursesMap]);

  const labels = useMemo(() => Object.keys(labelToId), [labelToId]);
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
                  <div>
                    <span className="font-medium">Course:</span> {code || "—"}
                  </div>
                  <div>
                    <span className="font-medium">Section:</span> {sec?.section_code || "—"}
                  </div>
                  <div>
                    <span className="font-medium">Faculty:</span> {fac ? fac.faculty_name : "—"}
                  </div>
                </>
              );
            })()}
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
            disabled={!sectionId}
            onClick={() => onSave(sectionId)}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            Save
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
  const existingBuildings = useMemo(
    () => buildings.filter((b) => b && b !== "All Buildings"),
    [buildings]
  );

  const [building, setBuilding] = useState<string>(
    defaultBuilding && defaultBuilding !== "All Buildings" ? defaultBuilding : existingBuildings[0] || ""
  );
  const [roomNumber, setRoomNumber] = useState("");
  const [roomType, setRoomType] = useState<"Classroom" | "Lab">("Classroom");
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
            {/* Allow free text with suggestions so new buildings are possible */}
            <input
              list="building-suggestions"
              value={building}
              onChange={(e) => setBuilding(e.target.value)}
              placeholder="e.g. Gokongwei Hall"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
            <datalist id="building-suggestions">
              {existingBuildings.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
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
                onChange={(v) => setRoomType(v as "Classroom" | "Lab")}
                options={["Classroom", "Lab"]}
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
  campusName,
  timeBands,
  onClose,
  onSaved,
}: {
  room: RoomItem;
  campusName: string;
  timeBands: string[];
  onClose: () => void;
  onSaved: () => void; // parent will refresh data
}) {
  const [selectedDay, setSelectedDay] = useState<Day | "">("");
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // preload slots when a day is picked
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
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-4 text-xl font-semibold text-emerald-700">Edit Room</h3>
        <div className="space-y-4 text-sm">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="font-semibold">Campus</div>
              <div>{campusName} Campus</div>
            </div>
            <div>
              <div className="font-semibold">Building</div>
              <div>{room.building}</div>
            </div>
            <div>
              <div className="font-semibold">Room Number</div>
              <div>{room.room_number}</div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="font-semibold">Capacity</div>
              <div>{room.capacity}</div>
            </div>
            <div>
              <div className="font-semibold">Room Type</div>
              <div>{room.room_type}</div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium">Edit Day & Allowed Time Slots</label>
            <div className="flex items-start gap-2">
              <div className="flex-1 self-stretch">
                <SelectBox
                  value={selectedDay}
                  onChange={(v) => setSelectedDay(v as Day)}
                  options={DAYS}
                  placeholder="Select Day"
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

        <div className="mt-6 flex justify-between">
          <button
            onClick={() => setConfirmOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-100"
          >
            <Trash2 className="h-4 w-4" />
            Remove Room
          </button>

        <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
            >
              Close
            </button>
            <button
              disabled={!selectedDay}
              onClick={saveDay}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              Save Day’s Slots
            </button>
          </div>
        </div>

        {/* Confirm Remove */}
        {confirmOpen && (
          <div className="fixed inset-0 z-[110] grid place-items-center bg-black/40 p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <h3 className="text-lg font-semibold text-red-700 mb-2">Remove this room?</h3>
              <p className="text-sm text-gray-700">
                This will remove <span className="font-medium">{room.room_number}</span> and clear any class
                assignments for its configured slots.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmOpen(false)}
                  className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    const user = JSON.parse(localStorage.getItem("animo.user") || "{}");
                    if (!user?.userId) return;
                    await removeRoom(user.userId, { room_id: room.room_id });
                    setConfirmOpen(false);
                    onSaved();
                    onClose();
                  }}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        )}
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
  onUpdated: (next: RoomItem) => void; // push latest room
  timeBands: string[];
  sections: SectionDoc[];
  sectionSchedules: SectionSched[];
  rooms: RoomItem[];
  facultyBySection: Record<string, FacultyInfo>;
  coursesMap: Record<string, string>;
}) {
  const [selectedSlot, setSelectedSlot] = useState<{ day: Day; time_band: string } | null>(null);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);

  const handleAllocate = async (section_id: string) => {
    if (!selectedSlot || !user?.userId) return;
    await assignRoom(user.userId, {
      room_id: room.room_id,
      day: selectedSlot.day,
      time_band: selectedSlot.time_band,
      section_id,
    });
    // optimistic local apply so user sees instantly
    const updatedCells = room.schedule.map((c) =>
      c.day === selectedSlot.day && c.time_band === selectedSlot.time_band ? { ...c, section_id } : c
    );
    onUpdated({ ...room, schedule: updatedCells });
    setSelectedSlot(null);
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
      <p className="mb-4 text-sm text-gray-500">Manage room assignments and course scheduling for CCS</p>

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

                  // resolve labels for assigned cell
                  let label: React.ReactNode = "—";
                  if (isAssigned) {
                    const sec = sections.find((s) => s.section_id === sectionId);
                    const code = sec?.course_code ?? (sec?.course_id ? coursesMap[sec.course_id] : "");
                    const fac = facultyBySection[sectionId];
                    label = (
                      <div className="text-center leading-tight">
                        <div className="font-semibold text-[12px]">
                          {code} – {sec?.section_code}
                        </div>
                        <div className="text-[11px] text-gray-600 flex items-center justify-center gap-1">
                          <Users className="h-3 w-3 text-gray-500" /> {fac ? fac.faculty_name : "—"}
                        </div>
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
                              onClick={() => setSelectedSlot({ day, time_band: band })}
                              className="text-[11px] text-blue-600 underline"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleRemove(day, band, sectionId)}
                              className="text-[11px] text-red-600 underline"
                            >
                              Remove
                            </button>
                          </div>
                        </>
                      ) : (
                        <button
                          onClick={() => setSelectedSlot({ day, time_band: band })}
                          className="rounded bg-emerald-600 text-white text-[11px] px-2 py-1 hover:brightness-110"
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
          onCancel={() => setSelectedSlot(null)}
          sections={sections}
          sectionSchedules={sectionSchedules}
          rooms={rooms}
          facultyBySection={facultyBySection}
          coursesMap={coursesMap}
        />
      )}
    </div>
  );
}

/* ---------------- Room Card ---------------- */
function computeStatus(room: RoomItem) {
  // Full when every allowed cell has a section_id
  const cells = room.schedule || [];
  if (cells.length > 0 && cells.every((s) => s.section_id)) return "Full Slots";
  const avail = cells.filter((s) => !s.section_id).length;
  return cells.length === 0
    ? "Available"
    : avail > 0
    ? `${avail} Available Slot${avail !== 1 ? "s" : ""}`
    : "No Available Slots";
}

function RoomCard({
  room,
  campusName,
  onEdit,
  onView,
}: {
  room: RoomItem;
  campusName: string;
  onEdit: (r: RoomItem) => void;
  onView: (r: RoomItem) => void;
}) {
  const typeIcon =
    room.room_type === "Lab" ? (
      <FlaskConical className="h-4 w-4 text-emerald-700" />
    ) : (
      <Building2 className="h-4 w-4 text-emerald-700" />
    );
  const statusText = computeStatus(room);
  const statusColor = statusText === "No Available Slots" ? "text-red-600" : "text-green-600";

  return (
    <div className="rounded-lg border border-gray-300 bg-white p-4 shadow-sm">
      <h3 className="font-bold">{room.room_number}</h3>
      <p className="text-sm text-gray-600">
        {room.building} | {campusName} Campus
      </p>
      <p className={cls("mt-1 font-medium", statusColor)}>{statusText}</p>
      <div className="mt-2 flex items-center gap-4 text-sm text-gray-700">
        <span className="flex items-center gap-1">
          <Users className="h-4 w-4 text-emerald-700" />
          {room.capacity}
        </span>
        <span className="flex items-center gap-1">
          {typeIcon}
          {room.room_type}
        </span>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onView(room)}
          className="flex items-center gap-1 rounded border px-3 py-1 text-sm hover:bg-gray-100"
        >
          <Eye className="h-4 w-4" /> View Schedule
        </button>
        <button
          onClick={() => onEdit(room)}
          className="flex items-center gap-1 rounded border px-3 py-1 text-sm hover:bg-gray-100"
        >
          <Pencil className="h-4 w-4" /> Edit
        </button>
      </div>
    </div>
  );
}

/* ---------------- Page ---------------- */
export default function RoomAllocationScreen() {
  const [buildings, setBuildings] = useState<string[]>([]);
  const [building, setBuilding] = useState<string>("All Buildings");
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
  }, [user]);

  const refresh = async (): Promise<RoomAllocationResponse | null> => {
    if (!user?.userId) return null;
    const data = await getApoRoomAllocation(user.userId);
    setCampusName(data.campus.campus_name ? `${data.campus.campus_name}` : "");
    setBuildings(["All Buildings", ...data.buildings]);
    setTimeBands(data.timeBands);
    setRooms(data.rooms);
    setSections(data.sections);
    setSectionSchedules(data.sectionSchedules);
    setFacultyBySection(data.facultyBySection || {});
    // build course_id -> course_code map (handles string[] or string)
    const map: Record<string, string> = {};
    (data.courses ?? []).forEach((c) => {
      const cc = Array.isArray(c.course_code) ? c.course_code[0] : c.course_code;
      if (c.course_id && cc) map[c.course_id] = cc;
    });
    // prefer course_code already on each section
    data.sections.forEach((s) => {
      if (s.course_id && s.course_code) map[s.course_id] = s.course_code;
    });
    setCoursesMap(map);
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
  }, []);

  const filteredRooms = rooms.filter((r) => building === "All Buildings" || r.building === building);

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role={roleName} />
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

            <h2 className="text-lg font-bold">Room Allocation</h2>
            <p className="mb-4 text-sm text-gray-500">Campus: {campusName} Campus</p>

            <div className="mb-6 flex flex-wrap items-center gap-3">
              <SelectBox value={building} onChange={setBuilding} options={buildings} />
              <button
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:brightness-110"
              >
                <Plus className="h-4 w-4" />
                Add Room
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredRooms.map((r) => (
                <RoomCard key={r.room_id} room={r} campusName={campusName} onEdit={setEditing} onView={setViewing} />
              ))}
              {!filteredRooms.length && !loading && (
                <div className="text-sm text-gray-500">No rooms found for this building.</div>
              )}
            </div>
          </div>
        ) : (
          <RoomSchedule
            room={viewing}
            onBack={() => setViewing(null)}
            onUpdated={(next) => {
              // update both the grid and the card list
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
            // auto-switch to the building where the new room was created
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
            const data = await refresh();
            if (!data) return;
            // keep modal open with refreshed room
            const updated = data.rooms.find((r) => r.room_id === editing.room_id);
            if (updated) setEditing(updated);
          }}
        />
      )}
    </div>
  );
}
