/**
 * A small state pill.
 *
 * WHY one component for every badge: the fleet, sync, and user views show
 * many states in the same visual language, so the tone-to-color mapping
 * lives here instead of being re-decided at each call site.
 */
import type { ReactNode } from "react";

const TONES = {
  ok: "bg-[#e9f9ee] text-apple-green",
  warn: "bg-[#fff9e6] text-amber-700",
  bad: "bg-[#ffecea] text-apple-red",
  idle: "bg-apple-gray-surface text-apple-muted",
} as const;

export type BadgeTone = keyof typeof TONES;

export default function Badge({
  tone,
  children,
}: {
  tone: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
