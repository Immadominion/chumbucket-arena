/**
 * Generate an .ics (iCalendar) file from open fixtures so players add them to
 * their own calendar and get native reminders before kickoff — no push/email
 * infra needed. Each event has a 1-hour-before alarm ("call locks at kickoff").
 */

import type { MatchView } from "@/lib/adapters";

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function fixturesToIcs(matches: MatchView[]): string {
  const now = stamp(Date.now());
  const events = matches.flatMap((m) => {
    const f = m.fixture;
    return [
      "BEGIN:VEVENT",
      `UID:chumbucket-${f.matchId}@thegaffer.fun`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(f.kickoff)}`,
      `DTEND:${stamp(f.kickoff + 2 * 60 * 60 * 1000)}`,
      `SUMMARY:${f.home} v ${f.away} — make your call`,
      `DESCRIPTION:${(f.group ?? f.stage) || "World Cup"} · lock your Chumbucket call before kickoff.`,
      "BEGIN:VALARM",
      "TRIGGER:-PT1H",
      "ACTION:DISPLAY",
      "DESCRIPTION:Call locks at kickoff",
      "END:VALARM",
      "END:VEVENT",
    ];
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Chumbucket//Matchday//EN", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR"].join("\r\n");
}

export function downloadIcs(matches: MatchView[]): void {
  const blob = new Blob([fixturesToIcs(matches)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chumbucket-fixtures.ics";
  a.click();
  URL.revokeObjectURL(url);
}
