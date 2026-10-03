import AppProviders from "@/components/AppProviders";

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
