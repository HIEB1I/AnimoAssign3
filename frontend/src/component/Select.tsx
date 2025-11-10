import React from "react";

type Props = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
};

export default function Select({ label, ...rest }: Props) {
  return (
    <label className="inline-flex items-center gap-2">
      {label && <span className="text-xs text-gray-500">{label}</span>}
      <select
        {...rest}
        className="rounded-md border px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-200"
      >
        {rest.children}
      </select>
    </label>
  );
}
