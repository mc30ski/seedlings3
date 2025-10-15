import ComingSoonNotice from "@/src/ui/notices/ComingSoonNotice";
import { TabRolePropType } from "@/src/lib/types";

export default function PropertiesTab({ role = "worker" }: TabRolePropType) {
  return (
    <ComingSoonNotice
      title="Properties"
      description="We’re building this soon. You’ll be able to browse and acces properties right here."
    />
  );
}
