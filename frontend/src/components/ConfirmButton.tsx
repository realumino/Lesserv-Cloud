/**
 * A button that asks for confirmation before running its action.
 *
 * WHY window.confirm: deleting a user or rotating a REALITY key is rare
 * and irreversible, and a native confirm is honest and dependency-free.
 */
import type { ReactNode } from "react";

export default function ConfirmButton({
  message,
  onConfirm,
  children,
  className,
  disabled = false,
}: {
  message: string;
  onConfirm: () => void;
  children: ReactNode;
  className: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={className}
      onClick={() => {
        if (window.confirm(message)) {
          onConfirm();
        }
      }}
    >
      {children}
    </button>
  );
}
