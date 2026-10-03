import { ArenaFonts } from "@/components/ArenaFonts";
import AppProviders from "@/components/AppProviders";

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders>
      <ArenaFonts />
      {children}
    </AppProviders>
  );
}
