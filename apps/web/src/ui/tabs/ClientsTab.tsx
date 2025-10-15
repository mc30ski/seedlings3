import ComingSoonNotice from "@/src/ui/notices/ComingSoonNotice";
import { TabRolePropType } from "@/src/lib/types";

export default function ClientsTab({ role = "worker" }: TabRolePropType) {
  return (
    <ComingSoonNotice
      title="Clients"
      description="We’re building this soon. You’ll be able to view client info and manage client interactions here."
    />
  );
}
