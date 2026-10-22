import { useState } from 'react';
import { isValidToken } from '../api.js';
import { INVALID_PASSCODE } from '../errors.js';
import { LockIcon } from './Icons.jsx';
import Sheet from './Sheet.jsx';

export default function PasscodePrompt({ onSubmit, rejected }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState(rejected ? "That passcode didn't work. Try again." : '');
  const [checking, setChecking] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    const value = code.trim();
    if (!value) {
      setError('Enter the passcode.');
      return;
    }
    if (!isValidToken(value)) {
      setError(INVALID_PASSCODE);
      return;
    }
    setChecking(true);
    setError('');
    try {
      await onSubmit(value);
    } catch (err) {
      setError(
        err.code === 'unauthorized' ? "That passcode didn't work. Try again."
        : err.code === 'network_error' ? "Couldn't reach the server. Is it running?"
        : err.message,
      );
      setChecking(false);
    }
  }

  return (
    <Sheet title="Enter passcode" dismissible={false} className="passcode-sheet">
      <form className="form" onSubmit={handleSubmit}>
        <div className="passcode-intro">
          <span className="passcode-icon" aria-hidden="true">
            <LockIcon size={28} />
          </span>
          <p className="muted">
            This server is protected. Enter the <code>APP_TOKEN</code> passcode once and this device
            will remember it.
          </p>
        </div>
        <label className="field">
          <span>Passcode</span>
          <input
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="current-password"
            enterKeyHint="go"
            data-autofocus
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={checking}>
          {checking ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </Sheet>
  );
}
