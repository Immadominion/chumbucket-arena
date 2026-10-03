import { ArenaFonts } from "@/components/ArenaFonts";

/** /proof is styled like the Arena (Inter + JetBrains Mono). */
export default function ProofLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ArenaFonts />
      {children}
    </>
  );
}
