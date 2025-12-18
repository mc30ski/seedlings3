import ComingSoonNotice from "@/src/ui/notices/ComingSoonNotice";

import {
  type TabPropsType,
  //  SERVICES_KIND,
  //  SERVICES_STATUS,
  //  type Service,
} from "@/src/lib/types";

// Constant representing the kind states for this entity.
//const kindStates = ["ALL", ...SERVICES_KIND] as const;

// Constant representing the status states for this entity.
//const statusStates = ["ALL", ...SERVICES_STATUS] as const;

export default function PropertiesTab({
  me,
  purpose = "WORKER",
}: TabPropsType) {
  return (
    <ComingSoonNotice
      title="Services"
      description="We’re building this soon. You’ll be able to browse and claim lawn care jobs right here."
    />
  );
}
