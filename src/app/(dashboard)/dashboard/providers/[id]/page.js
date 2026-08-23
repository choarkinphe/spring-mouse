import { redirect } from "next/navigation";

export default async function ProviderDetailPage({ params }) {
  const { id } = await params;
  redirect(`/dashboard/providers?channel=${encodeURIComponent(id)}`);
}
