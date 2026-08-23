import ChannelManagement from "./components/ChannelManagement";

export default async function ProvidersPage({ searchParams }) {
  const { channel } = await searchParams;
  return <ChannelManagement initialDetailProviderId={typeof channel === "string" ? channel : null} />;
}
