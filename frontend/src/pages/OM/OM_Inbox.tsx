// frontend/src/pages/OM/OM_Inbox.tsx
import InboxShell from "@/pages/shared/InboxShell";

function OMInboxMain() {
  return (
    <InboxShell
      title="Inbox"
      subtitle="Manage communication with faculty"
      fallbackRoute="/om/load-assignment"
      closeEventName="om:closeInbox"
    />
  );
}

// Keep this export if your routing/layout expects it
export function InboxContent() {
  return <OMInboxMain />;
}

export default OMInboxMain;
