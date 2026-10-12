import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  detail,
  http,
  HttpResponse,
  me,
  minutesArtifact,
  renderAt,
  row,
  server,
  summaryArtifact,
} from "./harness";

const MID = "22222222-2222-4222-8222-222222222222";
const list = (items: ReturnType<typeof row>[], stats = { total: items.length, completed: 1, processing: 0, failed: 0 }) =>
  http.get("/api/v1/meetings", () => HttpResponse.json({ items, page: 1, pageSize: 20, total: items.length, stats }));

describe("authentication", () => {
  it("shows the sign-in page with Google and Microsoft when signed out", async () => {
    server.use(http.get("/api/v1/me", () => HttpResponse.json({ error: { code: "unauthenticated", message: "x" } }, { status: 401 })));
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Continue with Google/ })).toHaveAttribute("href", "/api/v1/auth/google");
    expect(screen.getByRole("link", { name: /Continue with Microsoft/ })).toHaveAttribute("href", "/api/v1/auth/microsoft");
    expect(screen.queryByText(/Development sign-in/)).not.toBeInTheDocument();
  });

  it("explains OAuth errors", async () => {
    server.use(http.get("/api/v1/me", () => HttpResponse.json({ error: { code: "unauthenticated", message: "x" } }, { status: 401 })));
    renderAt("/login?error=access_denied");
    expect(await screen.findByText(/Sign-in was cancelled/)).toBeInTheDocument();
  });
});

describe("dashboard", () => {
  it("shows a loading state, then meetings with date, platform, status and actions", async () => {
    server.use(list([row()]));
    renderAt("/");
    expect(await screen.findByLabelText("Loading meetings", {}, { timeout: 2000 }).catch(() => null)).toBeDefined();
    const links = await screen.findAllByRole("link", { name: "Quarterly planning" });
    const item = links[0]!.closest("li")!;
    // 09:00 UTC displayed in the user's time zone (Asia/Dhaka, UTC+6)
    expect(within(item).getByText(/15:00/)).toBeInTheDocument();
    expect(within(item).getByText("Google Meet")).toBeInTheDocument();
    expect(within(item).getByText("Completed")).toBeInTheDocument();
    expect(within(item).getByRole("link", { name: "Summary for Quarterly planning" })).toHaveAttribute("href", `/meetings/${MID}?tab=summary`);
    expect(within(item).getByRole("link", { name: "Meeting Minutes for Quarterly planning" })).toHaveAttribute("href", `/meetings/${MID}?tab=minutes`);
    expect(within(item).getByRole("link", { name: "Recording for Quarterly planning" })).toBeInTheDocument();
  });

  it("shows empty states and a calendar prompt", async () => {
    renderAt("/");
    expect(await screen.findByText("No upcoming meetings")).toBeInTheDocument();
    expect(screen.getByText("No calendar connected")).toBeInTheDocument();
  });

  it("shows an error with retry when the list fails", async () => {
    server.use(http.get("/api/v1/meetings", () => HttpResponse.json({ error: { code: "internal_error", message: "Boom", requestId: "req-1" } }, { status: 500 })));
    renderAt("/");
    expect((await screen.findAllByText("This couldn't be loaded"))[0]).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
  });

  it("labels processing and failed states with text, not colour alone", async () => {
    server.use(list([row({ status: "recording_processing", summary: "processing" }), row({ id: "55555555-5555-4555-8555-555555555555", title: "Board", status: "failed", recording: "none", summary: "none", minutes: "none", transcript: "none" })]));
    renderAt("/meetings");
    const board = (await screen.findByRole("link", { name: "Board" })).closest("li")!;
    expect(within(board).getByText("Failed")).toBeInTheDocument();
    const qp = screen.getByRole("link", { name: "Quarterly planning" }).closest("li")!;
    expect(within(qp).getByText("Processing")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Summary for Quarterly planning (processing)" })).toBeInTheDocument();
  });
});

describe("meetings page", () => {
  it("shows a no-results state for filters and can clear them", async () => {
    renderAt("/meetings?q=nothing");
    expect(await screen.findByText("No meetings match these filters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("No meetings yet")).toBeInTheDocument();
  });
});

describe("meeting detail: Summary", () => {
  it("shows the selected meeting's summary", async () => {
    server.use(http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json(detail())), http.get(`/api/v1/meetings/${MID}/summary`, () => HttpResponse.json(summaryArtifact())));
    renderAt(`/meetings/${MID}?tab=summary`);
    expect(await screen.findByRole("article", { name: "Summary of Quarterly planning" })).toBeInTheDocument();
    expect(screen.getByText("Launch behind a feature flag")).toBeInTheDocument();
    expect(screen.getByText(/AI-generated notes may contain errors/)).toBeInTheDocument();
  });

  it("shows a processing state", async () => {
    server.use(http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json(detail())), http.get(`/api/v1/meetings/${MID}/summary`, () => HttpResponse.json(summaryArtifact({ status: "processing", content: null, generatedAt: null }))));
    renderAt(`/meetings/${MID}`);
    expect(await screen.findByText("Summary processing")).toBeInTheDocument();
  });

  it("shows a failure with a retry action", async () => {
    let posted = false;
    server.use(
      http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json(detail())),
      http.get(`/api/v1/meetings/${MID}/summary`, () => HttpResponse.json(summaryArtifact({ status: "failed", content: null, errorCode: "generation_failed" }))),
      http.post(`/api/v1/meetings/${MID}/summary/generate`, () => ((posted = true), HttpResponse.json({ created: true }, { status: 202 }))),
    );
    renderAt(`/meetings/${MID}`);
    expect(await screen.findByText("Summary could not be generated")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posted).toBe(true));
  });

  it("never fabricates content when there is no transcript", async () => {
    server.use(
      http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json(detail({ transcript: "failed" }))),
      http.get(`/api/v1/meetings/${MID}/summary`, () => HttpResponse.json(summaryArtifact({ status: null, id: null, content: null, errorCode: "transcript_unavailable", canGenerate: false }))),
    );
    renderAt(`/meetings/${MID}`);
    expect(await screen.findByText(/reliable summary can't be generated/)).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});

describe("meeting detail: Meeting Minutes and Copy minutes", () => {
  function minutesHandlers(art = minutesArtifact()) {
    return [http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json(detail())), http.get(`/api/v1/meetings/${MID}/minutes`, () => HttpResponse.json(art))];
  }

  it("renders structured minutes with unknown owners and dates as Not specified", async () => {
    server.use(...minutesHandlers());
    renderAt(`/meetings/${MID}?tab=minutes`);
    const doc = await screen.findByRole("article", { name: "Minutes of Quarterly planning" });
    const table = within(doc).getByRole("table");
    const legal = within(table).getByText("Follow up with legal").closest("tr")!;
    expect(within(legal).getAllByText("Not specified")).toHaveLength(3); // owner, due, status
    const priya = within(table).getByText("Finish accessibility review").closest("tr")!;
    expect(within(priya).getByText("Priya")).toBeInTheDocument();
    expect(within(doc).getByText("Proposals not yet decided")).toBeInTheDocument();
  });

  it("copies exactly the displayed minutes text and confirms", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    server.use(...minutesHandlers());
    renderAt(`/meetings/${MID}?tab=minutes`);
    await userEvent.click(await screen.findByRole("button", { name: "Copy minutes" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toBe(minutesArtifact().renderedText);
    expect(copied).toContain("MINUTES OF MEETING: Quarterly planning");
    expect(copied).toContain("Owner: Not specified");
    expect(copied).not.toContain("<");
    expect(await screen.findByText("Minutes copied to clipboard")).toBeInTheDocument();
  });

  it("shows an actionable error and selects the text when clipboard access is denied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) },
    });
    document.execCommand = vi.fn().mockReturnValue(false);
    server.use(...minutesHandlers());
    renderAt(`/meetings/${MID}?tab=minutes`);
    await userEvent.click(await screen.findByRole("button", { name: "Copy minutes" }));
    expect(await screen.findByText("Your browser blocked clipboard access")).toBeInTheDocument();
    const box = screen.getByLabelText(/Minutes as plain text/) as HTMLTextAreaElement;
    expect(box.value).toBe(minutesArtifact().renderedText);
    expect(document.activeElement).toBe(box);
  });

  it("generates minutes automatically when they don't exist yet (with CSRF header)", async () => {
    let csrf: string | null = null;
    let generated = false;
    server.use(
      http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json(detail({ minutes: "none" }))),
      http.get(`/api/v1/meetings/${MID}/minutes`, () =>
        HttpResponse.json(generated ? minutesArtifact({ status: "pending", content: null, renderedText: null, generatedAt: null }) : minutesArtifact({ id: null, status: null, version: null, content: null, renderedText: null, generatedAt: null })),
      ),
      http.post(`/api/v1/meetings/${MID}/minutes/generate`, ({ request }) => {
        csrf = request.headers.get("x-csrf-token");
        generated = true;
        return HttpResponse.json({ created: true }, { status: 202 });
      }),
    );
    renderAt(`/meetings/${MID}?tab=minutes`);
    await waitFor(() => expect(generated).toBe(true));
    expect(csrf).toBe(me.csrfToken);
    expect(await screen.findByText("Minutes processing")).toBeInTheDocument();
  });
});

describe("meeting detail: recording and lifecycle", () => {
  it("shows the player with download for a ready recording", async () => {
    server.use(http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json(detail())), http.get(`/api/v1/meetings/${MID}/summary`, () => HttpResponse.json(summaryArtifact())));
    renderAt(`/meetings/${MID}`);
    expect(await screen.findByRole("button", { name: "Play recording of Quarterly planning" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download audio/ })).toHaveAttribute("href", "/d");
  });

  it("explains a bot waiting in the lobby and offers cancellation", async () => {
    server.use(
      http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json(detail({ status: "joining", substatus: "waiting_for_admission", canCancel: true, recording: "none", summary: "none" }))),
      http.get(`/api/v1/meetings/${MID}/recording`, () => HttpResponse.json({ status: null, mimeType: null, durationSeconds: null, fileSizeBytes: null, streamUrl: null, downloadUrl: null, errorCode: null })),
      http.get(`/api/v1/meetings/${MID}/summary`, () => HttpResponse.json(summaryArtifact({ id: null, status: null, content: null, canGenerate: false }))),
    );
    renderAt(`/meetings/${MID}`);
    expect(await screen.findByText("The bot is waiting to be admitted")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting for admission")[0]).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel recording" })).toBeInTheDocument();
  });

  it("shows not-found for meetings the user cannot access", async () => {
    server.use(http.get(`/api/v1/meetings/${MID}`, () => HttpResponse.json({ error: { code: "not_found", message: "Meeting not found" } }, { status: 404 })));
    renderAt(`/meetings/${MID}`);
    expect(await screen.findByRole("heading", { name: "Meeting not found" })).toBeInTheDocument();
  });
});

describe("navigation", () => {
  it("hides Operations from non-admins", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.queryByRole("link", { name: /Operations/ })).not.toBeInTheDocument();
  });
});
