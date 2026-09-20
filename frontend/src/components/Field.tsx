/**
 * A labelled form field with an optional inline hint.
 *
 * WHY one wrapper: every form in the app labels inputs the same way, and
 * the hint line is where server-side validation rules are restated for the
 * admin (e.g. the node id pattern).
 */
import type { ReactNode } from "react";

export default function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-apple-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-apple-muted">{hint}</span>}
    </label>
  );
}
