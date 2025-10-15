import StatusPanel from "@/src/ui/helpers/StatusPanel";

export default function NoRoleNotice() {
  return (
    <StatusPanel
      badge="Setup needed"
      tone="blue"
      title="Approved, but no role assigned"
      description="You’ve been approved, but don’t have a role yet. Please contact your Administrator to be added as a Worker or Admin."
    />
  );
}
