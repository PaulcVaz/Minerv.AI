import { useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";

interface ActionToastProps {
  message: string;
  actionLabel: string;
  durationMs: number;
  initialRemainingMs?: number;
  paused?: boolean;
  processing?: boolean;
  error?: string;
  retryLabel?: string;
  onAction: () => void;
  onRetry?: () => void;
  onExpire: () => void;
  onRemainingChange?: (remainingMs: number) => void;
}

export function ActionToast({
  message,
  actionLabel,
  durationMs,
  initialRemainingMs = durationMs,
  paused = false,
  processing = false,
  error,
  retryLabel = "Tentar novamente",
  onAction,
  onRetry,
  onExpire,
  onRemainingChange,
}: ActionToastProps) {
  const [remaining, setRemaining] = useState(() =>
    Math.min(durationMs, Math.max(0, initialRemainingMs)),
  );
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.visibilityState === "hidden");
  const expired = useRef(false);
  const isPaused =
    paused || processing || !!error || hovered || focused || hidden;

  useEffect(() => {
    const change = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);

  useEffect(() => {
    if (isPaused || expired.current) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - previous;
      previous = now;
      setRemaining((current) => Math.max(0, current - elapsed));
    }, 50);
    return () => window.clearInterval(timer);
  }, [isPaused]);

  useEffect(() => {
    onRemainingChange?.(remaining);
    if (remaining <= 0 && !expired.current) {
      expired.current = true;
      onExpire();
    }
  }, [remaining, onExpire, onRemainingChange]);

  return (
    <aside
      className="action-toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      <div className="toast-content">
        <div className="toast-message">
          {error && <AlertCircle size={16} aria-hidden="true" />}
          <span>
            <strong>{message}</strong>
            {error && <small>{error}</small>}
          </span>
        </div>
        {error && onRetry && (
          <button onClick={onRetry} disabled={processing}>
            <RefreshCw size={14} /> {retryLabel}
          </button>
        )}
        <button
          className="toast-action"
          onClick={onAction}
          disabled={processing}
        >
          {processing && <LoaderCircle size={14} className="spin" />}
          {actionLabel}
        </button>
      </div>
      <div className="toast-track" aria-hidden="true">
        <span style={{ transform: `scaleX(${remaining / durationMs})` }} />
      </div>
    </aside>
  );
}
