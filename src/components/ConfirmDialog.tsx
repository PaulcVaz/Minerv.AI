import { useEffect, useId, useRef, type ReactNode } from "react";
import { LoaderCircle, X } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  children?: ReactNode;
  cancelText: string;
  confirmText: string;
  processingText?: string;
  destructive?: boolean;
  processing?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  children,
  cancelText,
  confirmText,
  processingText = "Processando…",
  destructive = false,
  processing = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => cancel.current?.focus());
    return () => previousFocus.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!processing) onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [open, processing, onCancel]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop confirm-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !processing) onCancel();
      }}
    >
      <section
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="modal confirm-dialog"
      >
        <button
          className="confirm-close"
          aria-label="Fechar"
          disabled={processing}
          onClick={onCancel}
        >
          <X size={18} />
        </button>
        <div className="confirm-icon" aria-hidden="true">
          <X size={19} />
        </div>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId} className="confirm-description">
          {description}
        </p>
        {children}
        {error && (
          <p className="confirm-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button ref={cancel} disabled={processing} onClick={onCancel}>
            {cancelText}
          </button>
          <button
            className={destructive ? "destructive-button" : "primary"}
            disabled={processing}
            onClick={onConfirm}
          >
            {processing && <LoaderCircle size={15} className="spin" />}
            {processing ? processingText : confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}
