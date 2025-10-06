import StatusPanel from "../helpers/StatusPanel";

export default function JobsComingSoonNotice() {
  return (
    <StatusPanel
      badge="Coming soon"
      tone="gray"
      title="Jobs"
      description="We’re building this soon. You’ll be able to browse and claim lawn care jobs right here."
    />
  );
}
