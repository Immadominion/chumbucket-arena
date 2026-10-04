import { safeDecode } from "@/lib/webapp/paths";
import { PersonScreen } from "@/components/webapp/screens/PersonScreen";

export const metadata = { title: "Profile" };

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <PersonScreen personRef={safeDecode(handle).replace(/^@+/, "")} />;
}
