/**
 * A centered modal dialog with a title bar and a Close action.
 *
 * WHY click-outside and a Close button, but no Escape handling: the two
 * dialogs here (a one-time token, a list of links) are informative; the
 * archived panel used the same backdrop pattern, and a close button keeps
 * it usable without a keyboard handler.
 */
import type { ReactNode } from "react";

export default function Modal({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`my-8 w-full ${wide ? "max-w-2xl" : "max-w-lg"} space-y-4 rounded-2xl border border-apple-border bg-apple-card p-6 shadow-xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-medium text-apple-muted transition-colors hover:text-apple-text"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
