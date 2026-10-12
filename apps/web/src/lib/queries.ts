import type {
  AdminJob,
  CalendarConnection,
  CalendarProvider,
  Me,
  MeetingDetail,
  MeetingListQuery,
  MeetingListResponse,
  MinutesArtifact,
  Recording,
  SummaryArtifact,
  Transcript,
  UpdateSettings,
} from "@notetaker/shared";
import { useMutation, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { api, ApiError, setCsrfToken } from "./api";

export const keys = {
  me: ["me"] as const,
  authConfig: ["auth-config"] as const,
  meetings: (q: Partial<MeetingListQuery>) => ["meetings", q] as const,
  meeting: (id: string) => ["meeting", id] as const,
  recording: (id: string) => ["meeting", id, "recording"] as const,
  transcript: (id: string) => ["meeting", id, "transcript"] as const,
  summary: (id: string) => ["meeting", id, "summary"] as const,
  minutes: (id: string) => ["meeting", id, "minutes"] as const,
  calendars: ["calendars"] as const,
  admin: ["admin"] as const,
};

const POLL_MS = 5000;
const ACTIVE_STATUSES = new Set([
  "queued",
  "joining",
  "in_progress",
  "recording_processing",
  "deletion_pending",
]);

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        const me = await api<Me>("/me");
        setCsrfToken(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useAuthConfig() {
  return useQuery({
    queryKey: keys.authConfig,
    queryFn: () =>
      api<{ googleAuth: boolean; microsoftAuth: boolean; devLogin: boolean }>("/auth/config"),
    staleTime: Infinity,
  });
}

function toQueryString(q: Partial<MeetingListQuery>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && v !== "" && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Polls while any listed meeting or artifact is still in progress (FR-06/13). */
function listNeedsPolling(data: MeetingListResponse | undefined): boolean {
  return !!data?.items.some(
    (m) =>
      ACTIVE_STATUSES.has(m.status) ||
      [m.recording, m.transcript, m.summary, m.minutes].includes("processing"),
  );
}

export function useMeetings(q: Partial<MeetingListQuery>) {
  return useQuery({
    queryKey: keys.meetings(q),
    queryFn: ({ signal }) => api<MeetingListResponse>(`/meetings${toQueryString(q)}`, { signal }),
    placeholderData: (prev) => prev,
    refetchInterval: (query: Query<MeetingListResponse>) =>
      listNeedsPolling(query.state.data) ? POLL_MS : false,
  });
}

export function useMeeting(id: string) {
  return useQuery({
    queryKey: keys.meeting(id),
    queryFn: ({ signal }) => api<MeetingDetail>(`/meetings/${id}`, { signal }),
    refetchInterval: (query: Query<MeetingDetail>) => {
      const m = query.state.data;
      if (!m) return false;
      return ACTIVE_STATUSES.has(m.status) ||
        [m.recording, m.transcript, m.summary, m.minutes].includes("processing")
        ? POLL_MS
        : false;
    },
  });
}

export function useRecording(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.recording(id),
    queryFn: () => api<Recording>(`/meetings/${id}/recording`),
    enabled,
  });
}

export function useTranscript(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.transcript(id),
    queryFn: () => api<Transcript>(`/meetings/${id}/transcript?limit=2000`),
    enabled,
    refetchInterval: (q: Query<Transcript>) =>
      q.state.data?.status === "processing" || q.state.data?.status === "pending" ? POLL_MS : false,
  });
}

function artifactPolling(status: string | null | undefined) {
  return status === "pending" || status === "processing" ? POLL_MS : false;
}

export function useSummary(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.summary(id),
    queryFn: () => api<SummaryArtifact>(`/meetings/${id}/summary`),
    enabled,
    refetchInterval: (q: Query<SummaryArtifact>) => artifactPolling(q.state.data?.status),
  });
}

export function useMinutes(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.minutes(id),
    queryFn: () => api<MinutesArtifact>(`/meetings/${id}/minutes`),
    enabled,
    refetchInterval: (q: Query<MinutesArtifact>) => artifactPolling(q.state.data?.status),
  });
}

export function useGenerate(id: string, type: "summary" | "minutes") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (regenerate: boolean) =>
      api<{ created: boolean }>(`/meetings/${id}/${type}/generate`, {
        method: "POST",
        body: { regenerate },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: type === "summary" ? keys.summary(id) : keys.minutes(id),
      });
      void qc.invalidateQueries({ queryKey: keys.meeting(id) });
    },
  });
}

export function useMeetingAction() {
  const qc = useQueryClient();
  const refresh = (id?: string) => {
    void qc.invalidateQueries({ queryKey: ["meetings"] });
    if (id) void qc.invalidateQueries({ queryKey: keys.meeting(id) });
  };
  return {
    register: useMutation({
      mutationFn: (
        body:
          | { meetingId: string }
          | { title: string; meetingUrl: string; startAt: string; endAt?: string },
      ) => api<MeetingDetail>("/meetings/register", { method: "POST", body }),
      onSuccess: (m) => refresh(m.id),
    }),
    cancel: useMutation({
      mutationFn: (id: string) => api<MeetingDetail>(`/meetings/${id}/cancel`, { method: "POST" }),
      onSuccess: (m) => refresh(m.id),
    }),
    remove: useMutation({
      mutationFn: (id: string) => api<{ status: string }>(`/meetings/${id}`, { method: "DELETE" }),
      onSuccess: () => refresh(),
    }),
  };
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettings) => api<Me>("/me/settings", { method: "PATCH", body }),
    onSuccess: (me) => {
      qc.setQueryData(keys.me, me);
      void qc.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
}

export function useCalendars() {
  return useQuery({
    queryKey: keys.calendars,
    queryFn: () =>
      api<{ items: CalendarConnection[]; available: CalendarProvider[] }>("/calendar-connections"),
    refetchInterval: (q) => (q.state.data?.items.some((c) => c.syncInProgress) ? POLL_MS : false),
  });
}

export function useCalendarActions() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.calendars });
  return {
    connect: useMutation({
      mutationFn: (provider: CalendarProvider) =>
        api<{ authorizationUrl: string }>(`/calendar-connections/${provider}/connect`, {
          method: "POST",
        }),
      onSuccess: (r) => {
        window.location.assign(r.authorizationUrl);
      },
    }),
    disconnect: useMutation({
      mutationFn: (id: string) => api<void>(`/calendar-connections/${id}`, { method: "DELETE" }),
      onSuccess: () => {
        refresh();
        void qc.invalidateQueries({ queryKey: ["meetings"] });
      },
    }),
    sync: useMutation({
      mutationFn: (id: string) =>
        api<{ status: string }>(`/calendar-connections/${id}/sync`, { method: "POST" }),
      onSuccess: refresh,
    }),
  };
}

export function useAdminOverview(enabled: boolean) {
  return useQuery({
    queryKey: [...keys.admin, "overview"],
    queryFn: () => api<Record<string, unknown>>("/admin/overview"),
    enabled,
  });
}

export function useAdminJobs(status: string, enabled: boolean) {
  return useQuery({
    queryKey: [...keys.admin, "jobs", status],
    queryFn: () =>
      api<{ items: AdminJob[]; total: number }>(`/admin/jobs?status=${status}&pageSize=50`),
    enabled,
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ status: string }>(`/admin/jobs/${id}/retry`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.admin }),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (all: boolean) =>
      api<void>(all ? "/auth/logout-all" : "/auth/logout", { method: "POST" }),
    onSettled: () => {
      setCsrfToken(null);
      qc.clear();
      window.location.assign("/login");
    },
  });
}
