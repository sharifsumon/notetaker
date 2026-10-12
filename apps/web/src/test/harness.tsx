import { MinutesContentSchema, renderMinutesText, type Me, type MeetingDetail, type MeetingRow, type MinutesArtifact, type SummaryArtifact } from "@notetaker/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createMemoryRouter, RouterProvider } from "react-router";
import { routes } from "../App";
import { ToastProvider } from "../components/ui";


export const me: Me = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "asha@example.com",
  displayName: "Asha Rahman",
  timezone: "Asia/Dhaka",
  role: "user",
  autoRegister: false,
  recordingNoticeAcknowledgedAt: "2026-10-01T00:00:00Z",
  identities: [{ provider: "google", email: "asha@example.com" }],
  csrfToken: "csrf-123",
  features: { devLogin: false, googleAuth: true, microsoftAuth: true, mockProviders: false },
};

export function row(over: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Quarterly planning",
    platform: "google_meet",
    scheduledStartAt: "2026-10-12T09:00:00Z",
    scheduledEndAt: "2026-10-12T10:00:00Z",
    durationSeconds: 3300,
    status: "completed",
    failureCode: null,
    registrationSource: "manual",
    recording: "ready",
    transcript: "ready",
    summary: "ready",
    minutes: "ready",
    canRegister: false,
    canCancel: false,
    ...over,
  };
}

export function detail(over: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    ...row(),
    actualStartAt: "2026-10-12T09:01:00Z",
    actualEndAt: "2026-10-12T09:56:00Z",
    timezoneAtCreation: "Asia/Dhaka",
    failureMessage: null,
    substatus: null,
    participants: [{ displayName: "Priya", source: "provider" }],
    statusHistory: [
      { from: null, to: "scheduled", source: "calendar", reasonCode: null, occurredAt: "2026-10-10T00:00:00Z" },
      { from: "recording_processing", to: "completed", source: "ingestion", reasonCode: null, occurredAt: "2026-10-12T10:00:00Z" },
    ],
    fromCalendar: true,
    ...over,
  };
}

export const minutesContent = MinutesContentSchema.parse({
  meetingDetails: {
    title: "Quarterly planning",
    startAt: "2026-10-12T09:00:00Z",
    endAt: null,
    timezone: "Asia/Dhaka",
    platform: "google_meet",
    participants: ["Priya"],
    participantsSource: "provider",
  },
  objective: "Agree Q4 priorities",
  discussionPoints: [{ topic: "Hiring", summary: "Two roles open." }],
  decisions: [{ decision: "Launch behind a feature flag", evidence: null }],
  proposals: [{ proposal: "Move standup to 10am", evidence: null }],
  actionItems: [
    { task: "Finish accessibility review", owner: "Priya", dueDate: "Friday", status: "open", evidence: null },
    { task: "Follow up with legal", owner: null, dueDate: null, status: "not_specified", evidence: null },
  ],
  risks: ["Legal review pending"],
  openQuestions: [],
  nextSteps: [],
  nextMeeting: null,
});

export function minutesArtifact(over: Partial<MinutesArtifact> = {}): MinutesArtifact {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    status: "completed",
    version: 1,
    content: minutesContent,
    renderedText: renderMinutesText(minutesContent),
    generatedAt: "2026-10-12T10:05:00Z",
    provider: "anthropic",
    model: "claude-test",
    promptVersion: "minutes-v1",
    errorCode: null,
    isMock: false,
    canGenerate: true,
    ...over,
  };
}

export function summaryArtifact(over: Partial<SummaryArtifact> = {}): SummaryArtifact {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    status: "completed",
    version: 1,
    content: {
      purpose: "Agree Q4 priorities",
      keyPoints: ["Hiring two roles"],
      decisions: ["Launch behind a feature flag"],
      risks: [],
      nextSteps: ["Share notes"],
      uncertainties: [],
      insufficientSource: false,
      note: null,
    },
    renderedText: "x",
    generatedAt: "2026-10-12T10:05:00Z",
    provider: "anthropic",
    model: "claude-test",
    promptVersion: "summary-v1",
    errorCode: null,
    isMock: false,
    canGenerate: true,
    ...over,
  };
}

/** Default handlers: authenticated user, empty lists. Tests override what they need. */
export function baseHandlers() {
  return [
    http.get("/api/v1/me", () => HttpResponse.json(me)),
    http.get("/api/v1/auth/config", () => HttpResponse.json({ googleAuth: true, microsoftAuth: true, devLogin: false })),
    http.get("/api/v1/calendar-connections", () => HttpResponse.json({ items: [], available: ["google_calendar", "microsoft_calendar"] })),
    http.get("/api/v1/meetings", () =>
      HttpResponse.json({ items: [], page: 1, pageSize: 20, total: 0, stats: { total: 0, completed: 0, processing: 0, failed: 0 } }),
    ),
    http.get("/api/v1/meetings/:id/recording", () =>
      HttpResponse.json({ status: "ready", mimeType: "audio/mp4", durationSeconds: 3300, fileSizeBytes: 100, streamUrl: "/s", downloadUrl: "/d", errorCode: null }),
    ),
  ];
}

/** Overrides passed to server.use() take precedence over these defaults. */
export const server = setupServer(...baseHandlers());

export function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router, qc };
}

export { http, HttpResponse };
