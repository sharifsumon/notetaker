import * as Dialog from "@radix-ui/react-dialog";
import { detectMeetingUrl } from "@notetaker/shared";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { localInputToIso } from "../lib/format";
import { useMeetingAction } from "../lib/queries";
import { errorText, Notice, useToast } from "./ui";

function defaultStart(): string {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Manual registration of a Meet/Teams link not on a connected calendar (FR-03). */
export function AddMeetingDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [start, setStart] = useState(defaultStart);
  const [minutes, setMinutes] = useState(60);
  const { register } = useMeetingAction();
  const toast = useToast();
  const navigate = useNavigate();
  const urlOk = url === "" || detectMeetingUrl(url) !== null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const startIso = localInputToIso(start);
    register.mutate(
      {
        title: title.trim(),
        meetingUrl: url.trim(),
        startAt: startIso,
        endAt: new Date(new Date(startIso).getTime() + minutes * 60_000).toISOString(),
      },
      {
        onSuccess: (m) => {
          toast("Meeting added. The bot will join at the start time.");
          setOpen(false);
          navigate(`/meetings/${m.id}`);
        },
      },
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (setOpen(o), o && register.reset())}>
      <Dialog.Trigger asChild>
        <button type="button" className="btn btn-primary">
          <Plus size={18} aria-hidden="true" />
          Record a meeting link
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title asChild>
            <h2>Record a meeting link</h2>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            Paste a Google Meet or Microsoft Teams link. A bot joins as a visible participant; the host may need to admit it.
          </Dialog.Description>
          <form className="stack" onSubmit={submit}>
            <div className="field">
              <label htmlFor="m-title">Meeting name</label>
              <input id="m-title" type="text" required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="m-url">Meeting link</label>
              <input
                id="m-url"
                type="url"
                required
                inputMode="url"
                placeholder="https://meet.google.com/abc-defg-hij"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={!urlOk}
                aria-describedby="m-url-hint"
              />
              <span id="m-url-hint" className="hint" style={urlOk ? undefined : { color: "var(--bad)" }}>
                {urlOk ? "Google Meet or Microsoft Teams links only." : "This isn't a Google Meet or Microsoft Teams meeting link."}
              </span>
            </div>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <div className="field" style={{ flex: "2 1 12rem" }}>
                <label htmlFor="m-start">Starts</label>
                <input id="m-start" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="field" style={{ flex: "1 1 7rem" }}>
                <label htmlFor="m-len">Length</label>
                <select id="m-len" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  {[15, 30, 45, 60, 90, 120, 180].map((n) => (
                    <option key={n} value={n}>
                      {n} min
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {register.isError && <Notice tone="bad">{errorText(register.error)}</Notice>}
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={!urlOk || register.isPending}>
                Record meeting
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
