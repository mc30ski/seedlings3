import StatusPanel from "@/src/ui/helpers/StatusPanel";

export default function UnavailableNotice() {
  return (
    <StatusPanel
      badge="Unavailable"
      tone="red"
      title="Access to this resource is unavailable"
      description="An administrator needs to approve your access or make this resource available to you."
    />
  );
}
