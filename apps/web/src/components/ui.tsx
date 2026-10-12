import { describeError, MEETING_STATUS_LABELS, type MeetingStatus } from "@notetaker/shared";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Clock,
  Info,
  Loader2,
  Radio,
  Trash2,
  XCircle,
} from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";

type Tone = "ok" | "wait" | "bad" | "idle" | "live";

const STATUS_TONE: Record<MeetingStatus, { tone: Tone; Icon: typeof Clock }> = {
  scheduled: { tone: "idle", Icon: Clock },
  queued: { tone: "live", Icon: CircleDot },
  joining: { tone: "wait", Icon: Loader2 },
  in_progress: { tone: "live", Icon: Radio },
  recording_processing: { tone: "wait", Icon: Loader2 },
  completed: { tone: "ok", Icon: CheckCircle2 },
  failed: { tone: "bad", Icon: XCircle },
  cancelled: { tone: "idle", Icon: Ban },
  unsupported: { tone: "bad", Icon: AlertTriangle },
  deletion_pending: { tone: "idle", Icon: Trash2 },
};

/** Status label for display. Past, never-registered meetings read as "Not recorded". */
export function statusLabel(
  status: MeetingStatus,
  opts: { ended?: boolean; substatus?: string | null } = {},
): string {
  if (status === "scheduled" && opts.ended) return "Not recorded";
  if (status === "joining" && opts.substatus === "waiting_for_admission")
    return "Waiting for admission";
  return MEETING_STATUS_LABELS[status];
}

export function StatusBadge({
  status,
  ended,
  substatus,
}: {
  status: MeetingStatus;
  ended?: boolean;
  substatus?: string | null;
}) {
  const { tone, Icon } =
    status === "scheduled" && ended
      ? { tone: "idle" as Tone, Icon: CircleDashed }
      : STATUS_TONE[status];
  return (
    <span className={`status tone-${tone}`}>
      <Icon size={14} aria-hidden="true" />
      {statusLabel(status, { ended, substatus })}
    </span>
  );
}

export function Notice({
  tone = "idle",
  title,
  children,
  actions,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const Icon =
    tone === "bad" ? XCircle : tone === "wait" ? Loader2 : tone === "ok" ? CheckCircle2 : Info;
  return (
    <div className={`notice tone-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <div className="notice-body">
        {title && <strong>{title}</strong>}
        {children}
        {actions && <div className="notice-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError)
    return describeError(err.code) !== describeError("internal_error")
      ? (describeError(err.code) ?? err.message)
      : err.message;
  return "Something went wrong. Try again.";
}

export function ErrorNotice({
  error,
  onRetry,
  title = "This couldn't be loaded",
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const msg = error instanceof ApiError ? error.message : "Something went wrong.";
  const ref = error instanceof ApiError && error.requestId ? ` Reference: ${error.requestId}` : "";
  return (
    <Notice
      tone="bad"
      title={title}
      actions={
        onRetry && (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Try again
          </button>
        )
      }
    >
      <p>
        {msg}
        <span className="muted small">{ref}</span>
      </p>
    </Notice>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- toasts
interface ToastItem {
  id: number;
  text: string;
  tone: "ok" | "bad";
}
const ToastCtx = createContext<(text: string, tone?: "ok" | "bad") => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === "bad" ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.tone === "bad" ? "tone-bad" : ""}`}
            role={t.tone === "bad" ? "alert" : "status"}
          >
            {t.tone === "bad" ? (
              <XCircle size={18} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={18} aria-hidden="true" />
            )}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
