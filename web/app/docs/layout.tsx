import { ArenaFonts } from "@/components/ArenaFonts";

/** /docs is styled like the Arena (Inter + JetBrains Mono). */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ArenaFonts />
      {children}
    </>
  );
}
