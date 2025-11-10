import { Save, Check } from "lucide-react";

export default function Toolbar({
  onSaveDraft,
  onApprove,
}: {
  onSaveDraft?: () => void;
  onApprove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onSaveDraft}
        className="inline-flex items-center gap-2 rounded-md border bg-gray-100 px-3 py-2 text-sm text-gray-700 hover:bg-gray-200"
      >
        <Save size={16} /> Save Draft
      </button>
      <button
        onClick={onApprove}
        className="inline-flex items-center gap-2 rounded-md border bg-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-300"
      >
        <Check size={16} /> Approve
      </button>
    </div>
  );
}
