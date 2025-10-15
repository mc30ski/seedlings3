import ComingSoonNotice from "@/src/ui/notices/ComingSoonNotice";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import { TabRolePropType } from "@/src/lib/types";

export default function PaymentsTab({ role = "worker" }: TabRolePropType) {
  return role !== "worker" && role !== "admin" ? (
    <UnavailableNotice />
  ) : (
    <ComingSoonNotice
      title="Payments"
      description="We’re building this soon. You’ll be able to see payments here."
    />
  );
}
