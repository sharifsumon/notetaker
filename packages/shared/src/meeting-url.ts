import type { Platform } from "./status";

/**
 * Strict detection of supported meeting join URLs. Arbitrary links are NOT treated as
 * supported meetings (FR-02). Only https URLs on the exact official hosts are accepted.
 */
const GOOGLE_MEET_CODE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/;
const TEAMS_MEETUP_JOIN = /^\/l\/meetup-join\/[^/]+(\/[^/]+)?\/?$/;
const TEAMS_LIVE_MEET = /^\/meet\/[0-9A-Za-z]+\/?$/;
const TEAMS_NEW_MEET = /^\/meet\/[0-9]+\/?$/;

export interface DetectedMeeting {
  platform: Platform;
  normalizedUrl: string;
}

export function detectMeetingUrl(raw: string | null | undefined): DetectedMeeting | null {
  if (!raw || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();

  if (host === "meet.google.com" && GOOGLE_MEET_CODE.test(url.pathname)) {
    return {
      platform: "google_meet",
      normalizedUrl: `https://meet.google.com${url.pathname.replace(/\/$/, "")}`,
    };
  }
  if (host === "teams.microsoft.com" && TEAMS_MEETUP_JOIN.test(url.pathname)) {
    return { platform: "microsoft_teams", normalizedUrl: url.toString() };
  }
  if (host === "teams.microsoft.com" && TEAMS_NEW_MEET.test(url.pathname)) {
    return { platform: "microsoft_teams", normalizedUrl: url.toString() };
  }
  if (host === "teams.live.com" && TEAMS_LIVE_MEET.test(url.pathname)) {
    return { platform: "microsoft_teams", normalizedUrl: url.toString() };
  }
  return null;
}

/** Finds the first supported meeting URL in free text (e.g. a calendar description). */
export function findMeetingUrlInText(text: string | null | undefined): DetectedMeeting | null {
  if (!text) return null;
  const candidates = text.match(/https:\/\/[^\s"'<>)\]]+/g) ?? [];
  for (const c of candidates.slice(0, 50)) {
    const found = detectMeetingUrl(c.replace(/[.,;]+$/, ""));
    if (found) return found;
  }
  return null;
}
