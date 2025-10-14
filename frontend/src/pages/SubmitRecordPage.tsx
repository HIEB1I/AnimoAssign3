import type { FormEvent } from "react";
import { useState } from "react";
import { createRecord } from "../api";
import type { RecordPayload } from "../api";

export default function SubmitRecordPage() {
  const [form, setForm] = useState<RecordPayload>({ title: "", content: "" });
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setStatus(null);

    try {
      const record = await createRecord(form);
      setStatus(`Record ${record.id} created successfully.`);
      setForm({ title: "", content: "" });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to create record");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <header className="page__header">
        <h1>Submit a Record</h1>
        <p>Send a record through the backend service into MongoDB.</p>
      </header>

      <form className="card form" onSubmit={handleSubmit}>
        <label className="form__field">
          <span>Title</span>
          <input
            type="text"
            value={form.title}
            onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
            required
            maxLength={200}
          />
        </label>

        <label className="form__field">
          <span>Content</span>
          <textarea
            value={form.content}
            onChange={(event) => setForm((prev) => ({ ...prev, content: event.target.value }))}
            required
            maxLength={4000}
            rows={6}
          />
        </label>

        <button className="button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Submitting..." : "Submit record"}
        </button>

        {status && <p className="form__status">{status}</p>}
      </form>
    </div>
  );
}
