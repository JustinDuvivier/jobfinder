'use client';

import { useState } from 'react';

/**
 * An inline-editable salary cell. Click the value (or "+ Add") to type one in;
 * Enter or blur saves, Escape cancels. When empty and an `onFind` is provided
 * (the Jobs queue), it also offers the AI lookup. Shared by the Jobs queue and
 * the Tracker table so a salary you discover yourself is captured everywhere.
 */
export function EditableSalary({
  value,
  onSave,
  onFind,
  finding = false,
  searched = false,
}: {
  value: string | null;
  /** Persist the new salary (empty string clears it). Should update the row. */
  onSave: (salary: string) => Promise<void>;
  /** Optional AI lookup for an empty salary (Jobs queue only). */
  onFind?: () => void;
  finding?: boolean;
  /** True once the AI lookup ran and found nothing — hide the Find button. */
  searched?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function begin() {
    setDraft(value ?? '');
    setEditing(true);
  }

  async function commit() {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <input
        className="salary-input"
        autoFocus
        defaultValue={draft}
        placeholder="$120k–150k"
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          else if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={() => void commit()}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  if (value) {
    return (
      <button
        className="salary-chip"
        onClick={(e) => {
          e.stopPropagation();
          begin();
        }}
        title="Click to edit the salary"
      >
        {value} <span className="salary-pencil" aria-hidden>✎</span>
      </button>
    );
  }

  return (
    <span className="salary-empty" onClick={(e) => e.stopPropagation()}>
      {onFind && !searched && (
        <button
          className="btn-sm btn-ghost"
          onClick={onFind}
          disabled={finding}
          title="Search the description and the web for a salary"
        >
          {finding ? 'Searching…' : '🔍 Find'}
        </button>
      )}
      <button className="btn-sm btn-ghost" onClick={begin} title="Type in a salary you found">
        + Add
      </button>
    </span>
  );
}
