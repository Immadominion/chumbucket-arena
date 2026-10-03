import { ArenaFonts } from "@/components/ArenaFonts";

/** The legacy challenge page is styled like the Arena (Inter + JetBrains Mono). */
export default function LegacyChallengeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ArenaFonts />
      {children}
    </>
  );
}
