import { describe, expect, it } from "vitest";
import { detectMeetingUrl, findMeetingUrlInText } from "./meeting-url";

describe("detectMeetingUrl", () => {
  it.each([
    ["https://meet.google.com/abc-defg-hij", "google_meet"],
    ["https://meet.google.com/abc-defg-hij/", "google_meet"],
    ["https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d", "microsoft_teams"],
    ["https://teams.microsoft.com/meet/1234567890?p=abc", "microsoft_teams"],
    ["https://teams.live.com/meet/9876543210", "microsoft_teams"],
  ])("accepts %s", (url, platform) => {
    expect(detectMeetingUrl(url)?.platform).toBe(platform);
  });

  it.each([
    "http://meet.google.com/abc-defg-hij",
    "https://meet.google.com.evil.com/abc-defg-hij",
    "https://evil.com/meet.google.com/abc-defg-hij",
    "https://meet.google.com/landing",
    "https://user:pw@meet.google.com/abc-defg-hij",
    "https://meet.google.com:8443/abc-defg-hij",
    "https://zoom.us/j/123",
    "https://teams.microsoft.com/v2/",
    "javascript:alert(1)",
    "",
    "not a url",
  ])("rejects %s", (url) => {
    expect(detectMeetingUrl(url)).toBeNull();
  });

  it("normalizes Google Meet URLs", () => {
    expect(detectMeetingUrl("https://meet.google.com/abc-defg-hij/?authuser=0")?.normalizedUrl).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });

  it("finds a meeting URL in free text", () => {
    const text = "Agenda: https://example.com/doc. Join: https://meet.google.com/xyz-abcd-efg.";
    expect(findMeetingUrlInText(text)?.normalizedUrl).toBe("https://meet.google.com/xyz-abcd-efg");
    expect(findMeetingUrlInText("no links")).toBeNull();
  });
});
