import { safeDecode } from "@/lib/webapp/paths";
import { CallScreen } from "@/components/webapp/screens/CallScreen";

export const metadata = { title: "Call" };

export default async function Page({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  return <CallScreen callId={safeDecode(callId)} />;
}
