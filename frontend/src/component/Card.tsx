import { type PropsWithChildren } from "react";
import { cls } from "../utilities/cls";

export default function Card({
  className,
  children,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={cls("rounded-xl border bg-white shadow-sm", className)}>
      {children}
    </div>
  );
}
