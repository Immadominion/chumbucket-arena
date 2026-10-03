import AppProviders from "@/components/AppProviders";
import AppGate from "@/components/shell/AppGate";
import AppShell from "@/components/shell/AppShell";
import LiveSync from "@/components/LiveSync";

export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders>
      <AppGate>
        <LiveSync />
        <AppShell>{children}</AppShell>
      </AppGate>
    </AppProviders>
  );
}
