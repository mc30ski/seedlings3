import ComingSoonNotice from "@/src/ui/notices/ComingSoonNotice";
import { TabRolePropType } from "@/src/lib/types";

export default function JobsTab({ role = "worker" }: TabRolePropType) {
  return (
    <ComingSoonNotice
      title="Jobs"
      description="We’re building this soon. You’ll be able to browse and claim lawn care jobs right here."
    />
  );
}
