import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

function cls(...s: (string | false | undefined)[]) {
  return s.filter(Boolean).join(" ");
}

export default function SelectBox({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "",
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<number>(() => Math.max(0, options.findIndex((o) => o === value)));
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Portal dropdown position
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);

  useEffect(() => setHover(Math.max(0, options.findIndex((o) => o === value))), [value, options]);

  // Close on outside click
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!open) return;
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Update position on open/scroll/resize; auto-flip up if needed
  useEffect(() => {
    if (!open) return;

    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;

      const GAP = 8;
      const VIEW_H = window.innerHeight;

      // approximate dropdown height, capped (matches previous max-h-72)
      const ITEM_H = 36;
      const desired = Math.min(288, Math.max(120, options.length * ITEM_H));

      const spaceBelow = VIEW_H - r.bottom - GAP;
      const spaceAbove = r.top - GAP;

      // open up if below is tight and above is better
      const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;

      const top = openUp
        ? Math.round(Math.max(GAP, r.top - GAP - desired))
        : Math.round(r.bottom + GAP);

      const maxH = openUp ? Math.floor(spaceAbove) : Math.floor(spaceBelow);

      setPos({
        top,
        left: Math.round(r.left),
        width: Math.round(r.width),
        maxH: Math.max(120, Math.min(288, maxH)),
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true); // capture nested scrolls (tables, panels)

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, options.length]);

  const handleToggle = () => {
    if (!disabled) setOpen((v) => !v);
  };

  const menu =
    open && !disabled && pos
      ? createPortal(
          <div
            ref={listRef}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxH,
            }}
            className="z-[1500] overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl"
          >
            {options.map((opt, i) => (
              <button
                key={opt}
                onMouseEnter={() => setHover(i)}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                  btnRef.current?.focus();
                }}
                className={cls(
                  "block w-full px-4 py-2 text-left text-sm",
                  i === hover && "bg-emerald-50",
                  value === opt && "bg-emerald-100 text-emerald-800 font-medium"
                )}
              >
                {opt}
              </button>
            ))}
          </div>,
          document.body
        )
      : null;

  return (
    <div className={cls("relative min-w-[180px]", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        aria-disabled={disabled}
        className={cls(
          "w-full rounded-lg border px-3 py-2 text-left text-sm outline-none pr-8",
          "border-gray-300 bg-white shadow-sm focus:ring-2 focus:ring-emerald-500/30",
          disabled && "cursor-not-allowed bg-gray-100 text-gray-400"
        )}
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2" />
      </button>

      {menu}
    </div>
  );
}
