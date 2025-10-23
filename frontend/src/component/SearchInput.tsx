import React from "react";
import { Search } from "lucide-react";
import { cls } from "../utilities/cls";

type Props = React.InputHTMLAttributes<HTMLInputElement>;

export default function SearchInput({ className, ...rest }: Props) {
  return (
    <div className={cls("relative", className)}>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <input
        {...rest}
        className={cls(
          "w-full rounded-md border px-9 py-2 text-sm outline-none",
          "focus:ring-2 focus:ring-emerald-200"
        )}
        placeholder={rest.placeholder ?? "Search..."}
      />
    </div>
  );
}
