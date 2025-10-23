import React, { useState, useRef, useEffect } from "react";
import {
  Users, 
  Building2, 
  Eye, 
  Pencil, 
  ChevronDown, 
  FlaskConical, 
  ArrowLeft
} from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";

/* ---------------- Utilities ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");
const chipClass =
  "inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700";

/* ---------------- MultiSelect ---------------- */
function MultiSelect({
  label, options, value, onChange, disabled = false
}: {
  label: string; options: string[]; value: string[];
  onChange: (vals: string[]) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null); const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => open && !btnRef.current?.contains(e.target as Node)
      && !listRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const toggle = (opt: string) => value.includes(opt)
    ? onChange(value.filter(v => v !== opt))
    : onChange([...value, opt]);
  return (
    <div className="w-full">
      <label className="mb-1 block text-sm font-medium">{label}</label>
      <div className="relative">
        <button ref={btnRef} type="button" onClick={() => !disabled && setOpen(o => !o)} disabled={disabled}
          className={cls(
            "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30",
            disabled && "cursor-not-allowed opacity-60"
          )}>
          <span className={value.length ? "" : "text-gray-400"}>
            {value.length ? `${value.length} selected` : "— Select option —"}
          </span>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2" />
        </button>
        {open && !disabled && (
          <div ref={listRef}
            className="absolute z-20 mt-2 max-h-64 w-full overflow-auto rounded-xl border border-gray-300 bg-white p-1 shadow-xl">
            {options.map(opt => {
              const checked = value.includes(opt);
              return (
                <label key={opt}
                  className={cls(
                    "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm",
                    checked ? "bg-emerald-50" : "hover:bg-neutral-50"
                  )}>
                  <input type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                    checked={checked} onChange={() => toggle(opt)} />
                  <span>{opt}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {value.map(v => <span key={v} className={chipClass}>{v}</span>)}
        </div>
      )}
    </div>
  );
}

/* ---------------- Types & Seed Data ---------------- */
type Room = {
  code: string; building: string; campus: string;
  status: "Available" | "Full Slots"; capacity: number;
  type: "Lab" | "Classroom";
  schedule?: { day: string; slot: string; sectionCode?: string }[];
};

const SECTIONS = [
  {
    courseCode: "CCPROG3",
    section: "S12",
    faculty: "CABREDO, RAFAEL A.",
    schedule: [
      { day: "Thursday", slot: "07:30 – 09:00" },
    ],
  },
  {
    courseCode: "CCPROG3",
    section: "S13",
    faculty: "CABREDO, RAFAEL A.",
    schedule: [
      { day: "Thursday", slot: "09:15 – 10:45" },
    ],
  },
  {
    courseCode: "ITNET01",
    section: "S11",
    faculty: "CU, GREGORY",
    schedule: [
      { day: "Wednesday", slot: "12:45 – 14:15" },
    ],
  },
];

const initialRooms: Room[] = [
  { 
    code: "GK301", building: "Gokongwei Hall", campus: "Manila Campus", 
    status: "Available", capacity: 22, type: "Lab",
    schedule: [
      { day: "Monday", slot: "07:30 – 09:00" },
      { day: "Wednesday", slot: "12:45 – 14:15" },
      { day: "Friday", slot: "14:30 – 16:00" }
    ]
  },
  { 
    code: "GK302A", building: "Gokongwei Hall", campus: "Manila Campus", 
    status: "Full Slots", capacity: 22, type: "Lab",
    schedule: [{ day: "Tuesday", slot: "09:15 – 10:45" }]
  },
  { 
    code: "GK302B", building: "Gokongwei Hall", campus: "Manila Campus", 
    status: "Available", capacity: 22, type: "Lab",
    schedule: []
  }
];


const TIME_SLOTS = [
  "07:30 – 09:00",
  "09:15 – 10:45",
  "11:00 – 12:30",
  "12:45 – 14:15",
  "14:30 – 16:00",
  "16:15 – 17:45",
  "18:00 – 19:30"
];


/* ---------------- Add Room Modal ---------------- */
function AddRoomModal({ onSave, onCancel }: { onSave: (room: Room) => void; onCancel: () => void; }) {
  const [campus, setCampus] = useState(""), [building, setBuilding] = useState(""),
        [code, setCode] = useState(""), [capacity, setCapacity] = useState(""),
        [type, setType] = useState<Room["type"] | "">(""), [timeSlots, setTimeSlots] = useState<string[]>([]);
  const [schedules, setSchedules] = useState<{ day: string; slot: string }[]>([]);
  const [selectedDay, setSelectedDay] = useState("");
  const [selectedSlots, setSelectedSlots] = useState<string[]>([]);

  useEffect(() => {
    setSelectedSlots([]);
  }, [selectedDay]);


  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-4 text-xl font-semibold text-emerald-700">Add Room</h3>
        <div className="space-y-4">
          <div><label className="mb-1 block text-sm font-medium">Campus</label>
            <SelectBox value={campus} onChange={setCampus} options={["Manila Campus", "Laguna Campus"]}
              placeholder="-- Select an option --" />
          </div>
          <div><label className="mb-1 block text-sm font-medium">Building</label>
            <SelectBox value={building} onChange={setBuilding}
              options={["Gokongwei Hall", "St. La Salle Hall", "Br. Andrew Gonzales Hall"]}
              placeholder="-- Select an option --" />
          </div>
          <div><label className="mb-1 block text-sm font-medium">Room Number</label>
            <input value={code} onChange={e => setCode(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className="mb-1 block text-sm font-medium">Capacity</label>
              <input type="number" min={1} value={capacity} onChange={e => setCapacity(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30" />
            </div>
            <div><label className="mb-1 block text-sm font-medium">Room Type</label>
              <SelectBox value={type} onChange={v => setType(v as Room["type"])}
                options={["Classroom", "Lab"]} placeholder="-- Select an option --" />
            </div>
          </div>
          {/* Choose Day then Time Slots */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">Add Schedule</label>
            <div className="flex items-start gap-2">
              <div className="flex-1 self-stretch">
                <SelectBox
                  value={selectedDay}
                  onChange={setSelectedDay}
                  options={["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]}
                  placeholder="Select Day"
                  className="w-full"
                />
              </div>
              <div className="flex-1 self-stretch">
                <MultiSelect
                  label=""
                  options={TIME_SLOTS}
                  value={selectedSlots}
                  onChange={(slots) => {
                    setSelectedSlots(slots);
                    if (selectedDay) {
                      const updatedSchedules = [
                        ...schedules.filter(s => s.day !== selectedDay),
                        ...slots.map(slot => ({ day: selectedDay, slot }))
                      ];
                      setSchedules(updatedSchedules);
                    }
                  }}
                  disabled={!selectedDay}
                />
              </div>
            </div>

            {schedules.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {schedules.map((s, i) => (
                  <span key={i} className={chipClass}>{s.day} – {s.slot}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200">Cancel</button>
          <button onClick={() => {
              if (!code || !campus || !building || !capacity || !type) return;
              onSave({ code, campus, building, capacity: Number(capacity), status: "Available", type, schedule: schedules });
            }}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110">Add</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Edit Room Modal ---------------- */
function EditRoomModal({
  room, onSave, onCancel, onRemove
}: { room: Room; onSave: (r: Room) => void; onCancel: () => void; onRemove: (code: string) => void; }) {
const [schedules, setSchedules] = useState<{ day: string; slot: string }[]>(room.schedule || []);
const [selectedDay, setSelectedDay] = useState("");
const [selectedSlots, setSelectedSlots] = useState<string[]>([]);

useEffect(() => {
  if (selectedDay) {
    const existingSlots = schedules
      .filter(s => s.day === selectedDay)
      .map(s => s.slot);
    setSelectedSlots(existingSlots);
  } else {
    setSelectedSlots([]);
  }
}, [selectedDay, schedules]);


 return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-4 text-xl font-semibold text-emerald-700">Edit Room</h3>
        <div className="space-y-4 text-sm">
          {/* Campus, Building, and Room Number on same line */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <div className="font-semibold">Campus</div>
              <div>{room.campus}</div>
            </div>
            <div>
              <div className="font-semibold">Building</div>
              <div>{room.building}</div>
            </div>
            <div>
              <div className="font-semibold">Room Number</div>
              <div>{room.code}</div>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><div className="font-semibold">Capacity</div><div>{room.capacity}</div></div>
            <div><div className="font-semibold">Room Type</div><div>{room.type}</div></div>
          </div>
          {/* Choose Day then Multi Time Slots */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">Edit Schedule</label>
            <div className="flex items-start gap-2">
            <div className="flex-1 self-stretch">
              <SelectBox
                value={selectedDay}
                onChange={setSelectedDay}
                options={["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]}
                placeholder="Select Day"
                className="w-full"
              />
            </div>
            <div className="flex-1 self-stretch">
              <MultiSelect
                label=""
                options={TIME_SLOTS}
                value={selectedSlots}
                onChange={(slots) => {
                  setSelectedSlots(slots);
                  if (selectedDay) {
                    const updatedSchedules = [
                      ...schedules.filter(s => s.day !== selectedDay),
                      ...slots.map(slot => ({ day: selectedDay, slot }))
                    ];
                    setSchedules(updatedSchedules);
                  }
                }}
                disabled={!selectedDay}
              />
            </div>
          </div>
          </div>
        </div>
        <div className="mt-6 flex justify-between">
          <button onClick={() => onRemove(room.code)}
            className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-100">Remove Room</button>
          <div className="flex gap-2">
            <button onClick={onCancel}
              className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200">Cancel</button>
            <button onClick={() => onSave({ ...room, schedule: schedules })}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AllocateClassModal({
  room,
  day,
  slot,
  onSave,
  onCancel,
  rooms, 
}: {
  room: Room;
  day: string;
  slot: string;
  onSave: (sectionCode: string) => void;
  onCancel: () => void;
  rooms: Room[]; 
}) {

  const [selectedSection, setSelectedSection] = useState<string>("");

// Filter only sections that match this day/slot AND are NOT already assigned anywhere
const availableSections = SECTIONS.filter((sec) => {
  const matchesSlot = sec.schedule.some((s) => s.day === day && s.slot === slot);
  if (!matchesSlot) return false;

  const isAlreadyAssigned = rooms.some((r) =>
    (r.schedule || []).some(
      (s) => s.sectionCode === `${sec.courseCode}-${sec.section}` && s.day === day && s.slot === slot
    )
  );
  return !isAlreadyAssigned;
});

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-3 text-lg font-semibold text-emerald-700">
          Allocate Room for Section
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          {room.code} – {day}, {slot}
        </p>

        <SelectBox
          value={selectedSection}
          onChange={setSelectedSection}
          options={availableSections.map((s) => `${s.courseCode} - ${s.section}`)}
          placeholder="Select Section"
        />

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
          >
            Cancel
          </button>
          <button
            disabled={!selectedSection}
            onClick={() => {
              const [courseCode, section] = selectedSection.split(" - ");
              onSave(`${courseCode}-${section}`); // store combined key like "CCPROG3-S12"
            }}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Room Schedule ---------------- */
function RoomSchedule({
  room,
  onBack,
  onUpdate,
  rooms, 
}: {
  room: Room;
  onBack: () => void;
  onUpdate: (r: Room) => void;
  rooms: Room[];
}) {

  const [selectedSlot, setSelectedSlot] = useState<{ day: string; slot: string } | null>(null);

const handleAllocate = (sectionCode: string) => {
  if (!selectedSlot) return;

  const updatedSchedule = (room.schedule || []).map(s =>
    s.day === selectedSlot.day && s.slot === selectedSlot.slot
      ? { ...s, sectionCode }          // ⬅️ write the assignment here
      : s
  );

  onUpdate({ ...room, schedule: updatedSchedule });
  setSelectedSlot(null);
};

const handleRemoveAssignment = (day: string, slot: string) => {
  const updatedSchedule = (room.schedule || []).map(s =>
    s.day === day && s.slot === slot
      ? { ...s, sectionCode: undefined }  // remove the section
      : s
  );

  onUpdate({ ...room, schedule: updatedSchedule });
};

  return (
    <div className="w-full rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-bold">Room Allocation</h2>
      <p className="mb-4 text-sm text-gray-500">
        Manage room assignments and course scheduling for CCS
      </p>
      <div className="mb-4 flex items-center gap-2">
        <button onClick={onBack}
          className="flex items-center gap-2 text-emerald-700 hover:underline">
          <ArrowLeft className="h-5 w-5" />
          <span className="text-lg font-semibold">Back</span>
        </button>
      </div>

      <h2 className="text-lg font-bold mb-1">{room.code} Schedule</h2>
      <div className="overflow-x-auto">
        <div className="min-w-[860px] rounded-xl border border-neutral-300">
          <div className="grid grid-cols-[140px_repeat(6,1fr)] bg-emerald-800 text-white">
            <div className="flex items-center justify-center px-3 py-2 text-sm font-semibold">Time</div>
            {["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((d) => (
              <div key={d} className="flex items-center justify-center px-3 py-2 text-sm font-semibold">{d}</div>
            ))}
          </div>

          <div className="relative grid grid-cols-[140px_repeat(6,1fr)]" style={{ gridAutoRows: "84px" }}>
            {TIME_SLOTS.map((band, r) => (
              <React.Fragment key={band}>
                <div className="flex items-center justify-center border-r border-neutral-300 bg-neutral-50 px-2 text-center text-[13px]"
                  style={{ gridColumn: 1, gridRow: r + 1 }}>{band}</div>

                  {["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day, c) => {
                    // what’s configured for this room?
                    const slotEntry = room.schedule?.find(s => s.day === day && s.slot === band);
                    const isAllowed  = Boolean(slotEntry);
                    const isAssigned = Boolean(slotEntry?.sectionCode);

                    return (
                      <div
                        key={`${day}-${band}`}
                        className={cls(
                          "border border-neutral-300 flex flex-col items-center justify-center text-xs p-1",
                          !isAllowed ? "bg-gray-100 text-gray-400"
                          : isAssigned ? "bg-emerald-50 text-emerald-700 font-medium"
                          : "bg-white text-gray-700"
                        )}
                        style={{ gridColumn: c + 2, gridRow: r + 1 }}
                      >
                        {!isAllowed ? (
                          <>—</>
                        ) : isAssigned ? (
                        <>
                          {(() => {
                          const section = SECTIONS.find(
                            s => `${s.courseCode}-${s.section}` === slotEntry!.sectionCode
                          );
                          if (!section) return <span>{slotEntry!.sectionCode}</span>;
                          return (
                            <div className="text-center leading-tight">
                              <div className="font-semibold text-[12px]">
                                {section.courseCode} – {section.section}
                              </div>
                              <div className="text-[11px] text-gray-600 flex items-center justify-center gap-1">
                                <Users className="h-3 w-3 text-gray-500" /> {section.faculty}
                              </div>
                            </div>
                          );
                          })()}
                            <div className="flex gap-1 mt-1">
                              <button
                                onClick={() => setSelectedSlot({ day, slot: band })}
                                className="text-[11px] text-blue-600 underline"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => handleRemoveAssignment(day, band)}
                                className="text-[11px] text-red-600 underline"
                              >
                                Remove
                              </button>
                            </div>
                          </>
                        ) : (
                          <button
                            onClick={() => setSelectedSlot({ day, slot: band })}
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
          slot={selectedSlot.slot}
          rooms={rooms}
          onSave={handleAllocate}
          onCancel={() => setSelectedSlot(null)}
        />
      )}
    </div>
  );
}


/* ---------------- Room Card ---------------- */
function RoomCard({ room, onEdit, onView }: { room: Room; onEdit: (r: Room) => void; onView: (r: Room) => void; }) {
  const typeIcon = room.type === "Lab"
    ? <FlaskConical className="h-4 w-4 text-emerald-700" />
    : <Building2 className="h-4 w-4 text-emerald-700" />;
  return (
    <div className="rounded-lg border border-gray-300 bg-white p-4 shadow-sm">
      <h3 className="font-bold">{room.code}</h3>
      <p className="text-sm text-gray-600">{room.building} | {room.campus}</p>
      {/* shows “No Available Slots” when none are free */}
      {(() => {
        const total = room.schedule?.length ?? 0;
        const avail = (room.schedule || []).filter(s => !s.sectionCode).length;
        const noneAvailable = total > 0 && avail === 0;

        const text =
          total === 0
            ? room.status                      // no configured slots yet → keep legacy label
            : noneAvailable
              ? "No Available Slots"
              : `${avail} Available Slot${avail !== 1 ? "s" : ""}`;

        const color =
          total === 0
            ? (room.status === "Available" ? "text-green-600" : "text-red-600")
            : (noneAvailable ? "text-red-600" : "text-green-600");

        return <p className={cls("mt-1 font-medium", color)}>{text}</p>;
      })()}
      <div className="mt-2 flex items-center gap-4 text-sm text-gray-700">
        <span className="flex items-center gap-1"><Users className="h-4 w-4 text-emerald-700" />{room.capacity}</span>
        <span className="flex items-center gap-1">{typeIcon}{room.type}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={() => onView(room)}
          className="flex items-center gap-1 rounded border px-3 py-1 text-sm hover:bg-gray-100">
          <Eye className="h-4 w-4" /> View Schedule
        </button>
        <button onClick={() => onEdit(room)}
          className="flex items-center gap-1 rounded border px-3 py-1 text-sm hover:bg-gray-100">
          <Pencil className="h-4 w-4" /> Edit
        </button>
      </div>
    </div>
  );
}
function computeRoomStatus(room: Room): "Available" | "Full Slots" {
  const sched = room.schedule || [];
  // A room is Full only when it has at least one slot and all of them have sectionCode assigned
  if (sched.length > 0 && sched.every(s => s.sectionCode)) return "Full Slots";
  return "Available";
}

/* ---------------- Page ---------------- */
export default function RoomAllocationScreen() {
  const [campus, setCampus] = useState("All Campuses"),
        [building, setBuilding] = useState("All Buildings"),
        [rooms, setRooms] = useState<Room[]>(initialRooms),
        [showAdd, setShowAdd] = useState(false),
        [editing, setEditing] = useState<Room | null>(null),
        [viewingRoom, setViewingRoom] = useState<Room | null>(null);

  const filteredRooms = rooms.filter(r =>
    (campus === "All Campuses" || r.campus === campus) &&
    (building === "All Buildings" || r.building === building)
  );
  
  useEffect(() => {
    setRooms(prev => prev.map(r => ({ ...r, status: computeRoomStatus(r) })));
  }, []);

  const addRoom = (room: Room) => { 
    const withStatus = { ...room, status: computeRoomStatus(room) };
    setRooms(p => [...p, withStatus]); 
    setShowAdd(false); 
  };
  const saveEditedRoom = (u: Room) => {
    const updated = { ...u, status: computeRoomStatus(u) };
    setRooms(p => p.map(r => r.code === u.code ? updated : r));
    setEditing(null);
  };
  const removeRoom = (code: string) => { setRooms(p => p.filter(r => r.code !== code)); setEditing(null); };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName="Hazel Ventura" role="Academic Programming Officer" />
      <Tabs />
      <main className="p-6 w-full">
        {!viewingRoom ? (
          <div className="w-full rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold">Room Allocation</h2>
            <p className="mb-4 text-sm text-gray-500">Manage room assignments and course scheduling for CCS</p>
            <div className="mb-6 flex flex-wrap gap-3">
              <SelectBox value={campus} onChange={setCampus}
                options={["All Campuses", "Manila Campus", "Laguna Campus"]} />
              <SelectBox value={building} onChange={setBuilding}
                options={["All Buildings", "St. La Salle Hall", "Velasco Hall", "Gokongwei Hall", "Br. Andrew Gonzales Hall"]} />
              <button onClick={() => setShowAdd(true)}
                className="ml-auto rounded bg-emerald-700 px-4 py-2 text-sm text-white hover:brightness-110">+ Add Room</button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredRooms.map(r => (
                <RoomCard
                  key={r.code}
                  room={r}
                  onEdit={setEditing}
                  onView={setViewingRoom}
                />
              ))}
            </div>
          </div>
        ) : (
        <RoomSchedule
          room={viewingRoom}
          onBack={() => setViewingRoom(null)}
          onUpdate={(updated) => {
            const recomputed = { ...updated, status: computeRoomStatus(updated) };
            setRooms(prev => prev.map(r => r.code === updated.code ? recomputed : r));
            setViewingRoom(recomputed);
          }}
          rooms={rooms} 
        />
        )}
      </main>

      {showAdd && <AddRoomModal onSave={addRoom} onCancel={() => setShowAdd(false)} />}
      {editing && (
        <EditRoomModal
          room={editing}
          onSave={saveEditedRoom}
          onCancel={() => setEditing(null)}
          onRemove={removeRoom}
        />
      )}
    </div>
  );
}
