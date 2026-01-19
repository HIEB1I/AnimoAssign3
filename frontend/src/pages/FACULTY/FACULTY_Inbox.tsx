import InboxShell from "@/pages/shared/InboxShell";

function FACULTYInboxMain() {
  return (
    <InboxShell
      title="Inbox"
      subtitle="Manage communication and support requests"
      fallbackRoute="/faculty/overview"
      closeEventName="faculty:closeInbox"
    />
  );
}

// Keep this export (your current file already uses this pattern)
export function InboxContent() {
  return <FACULTYInboxMain />;
}

export default FACULTYInboxMain;
