import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import InboxShell from "@/pages/shared/InboxShell";

/**
 * Embedded Inbox (used inside FACULTY_Overview when showInbox=true)
 */
export function InboxContent() {
  return (
    <InboxShell
      title="Inbox"
      subtitle="Manage communication and support requests"
      fallbackRoute="/faculty/overview"
      closeEventName="faculty:closeInbox"
    />
  );
}

/**
 * Route entry for /faculty/inbox.
 * We redirect back to /faculty/overview and open the embedded inbox,
 * so the TopBar + layout remain visible ("like a tab").
 */
export default function FACULTYInboxRoute() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate("/faculty/overview", { replace: true });
    // open inbox on the next tick so the Overview listeners are mounted
    window.setTimeout(() => window.dispatchEvent(new Event("faculty:openInbox")), 0);
  }, [navigate]);

  return null;
}
