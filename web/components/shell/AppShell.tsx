import BottomNav from "./BottomNav";
import LeftRail from "./LeftRail";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <LeftRail />
      <main className="appmain">{children}</main>
      <BottomNav />
    </div>
  );
}
