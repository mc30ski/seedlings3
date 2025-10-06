import StatusPanel from "../helpers/StatusPanel";

export default function AwaitingApprovalNotice() {
  return (
    <StatusPanel
      badge="Awaiting approval"
      tone="yellow"
      title="Your account is pending admin approval"
      description="An administrator needs to approve your access. You’ll get full access as soon as they do."
    />
  );
}
