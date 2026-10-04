import { safeDecode } from "@/lib/webapp/paths";
import { MarketScreen } from "@/components/webapp/screens/MarketScreen";

export const metadata = { title: "Market" };

export default async function Page({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params;
  return <MarketScreen marketId={safeDecode(marketId)} />;
}
