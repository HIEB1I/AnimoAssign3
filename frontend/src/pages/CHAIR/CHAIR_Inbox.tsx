// frontend/src/pages/CHAIR/CHAIR_Inbox.tsx
import InboxShell from "@/pages/shared/InboxShell";

function CHAIRInboxMain() {
  return (
    <InboxShell
      title="Inbox"
      subtitle="Manage communication with faculty"
      fallbackRoute="/chair/plantilla"
    />
  );
}

export function InboxContent() {
  return <CHAIRInboxMain />;
}

export default CHAIRInboxMain;
