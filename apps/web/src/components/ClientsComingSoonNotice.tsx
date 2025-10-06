import StatusPanel from "./StatusPanel";

export default function ClientsComingSoonNotice() {
  return (
    <StatusPanel
      badge="Coming soon"
      tone="gray"
      title="Clients"
      description="We’re building this soon. You’ll be able to view client info and manage client interactions here."
    />
  );
}
