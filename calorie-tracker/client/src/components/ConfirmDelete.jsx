import { useState } from 'react';
import { kcal } from '../format.js';
import Sheet from './Sheet.jsx';

export default function ConfirmDelete({ meal, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await onConfirm(meal);
    } catch (err) {
      setError(err.code === 'network_error' ? "Couldn't reach the server. Try again." : err.message);
      setBusy(false);
    }
  }

  return (
    <Sheet title="Delete meal?" onClose={onClose} dismissible={!busy}>
      <p className="confirm-text">
        <strong>{meal.meal_name}</strong> ({kcal(meal.total_calories)} kcal) will be removed from
        your log. This can't be undone.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy} data-autofocus>
          Keep it
        </button>
        <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Sheet>
  );
}
