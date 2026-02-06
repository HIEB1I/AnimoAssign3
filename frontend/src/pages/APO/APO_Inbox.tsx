import InboxShell from "@/pages/shared/InboxShell";

function APOInboxMain() {
  return (
    <InboxShell
      title="Inbox"
      subtitle="Manage communication and support requests"
      fallbackRoute="/apo/preenlistment"
    />
  );
}

// Keep this export pattern (safe if you later embed inbox in a tab view)
export function InboxContent() {
  return <APOInboxMain />;
}

export default APOInboxMain;
