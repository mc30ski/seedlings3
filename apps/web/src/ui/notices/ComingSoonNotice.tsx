import StatusPanel from "../helpers/StatusPanel";

export default function ComingSoonNotice({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <StatusPanel
      badge="Coming soon"
      tone="gray"
      title={title}
      description={description}
    />
  );
}
