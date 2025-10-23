import { useState, useRef, useEffect } from "react";
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

  useEffect(() => setHover(Math.max(0, options.findIndex((o) => o === value))), [value, options]);
  useEffect(() => {
    const close = (e: MouseEvent) =>
      open && !btnRef.current?.contains(e.target as Node) && !listRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const handleToggle = () => {
    if (!disabled) setOpen((v) => !v);
  };

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
      {open && !disabled && (
        <div ref={listRef} className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl">
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
        </div>
      )}
    </div>
  );
}
