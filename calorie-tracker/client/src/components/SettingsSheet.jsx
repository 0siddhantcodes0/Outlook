import { useState } from 'react';
import { getToken, isValidToken } from '../api.js';
import { INVALID_PASSCODE } from '../errors.js';
import { kcal, parseWhole } from '../format.js';
import Sheet from './Sheet.jsx';

const PRESETS = [1500, 1800, 2000, 2500, 3000];
const MIN_GOAL = 500;
const MAX_GOAL = 10000;

export default function SettingsSheet({ goal, health, onSave, onForgetPasscode, onClose }) {
  const [goalText, setGoalText] = useState(String(goal ?? 2000));
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const hasToken = Boolean(getToken());
  const showPasscode = health?.auth_required || hasToken;

  async function handleSubmit(event) {
    event.preventDefault();
    const value = parseWhole(goalText);
    if (value == null || Number.isNaN(value) || value < MIN_GOAL || value > MAX_GOAL) {
      setError(`Daily goal must be a whole number from ${kcal(MIN_GOAL)} to ${kcal(MAX_GOAL)} kcal.`);
      return;
    }
    const code = passcode.trim();
    if (code && !isValidToken(code)) {
      setError(INVALID_PASSCODE);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({ dailyGoal: value, passcode: code });
    } catch (err) {
      setError(
        err.code === 'unauthorized' ? "That passcode didn't work."
        : err.code === 'network_error' ? "Couldn't reach the server. Try again."
        : err.message,
      );
      setSaving(false);
    }
  }

  const current = parseWhole(goalText);

  return (
    <Sheet title="Settings" onClose={onClose} dismissible={!saving}>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <label className="field">
          <span>Daily calorie goal</span>
          <div className="input-unit">
            <input
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
            />
            <span>kcal</span>
          </div>
        </label>
        <div className="chips" role="group" aria-label="Common goals">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={`chip${current === p ? ' is-active' : ''}`}
              aria-pressed={current === p}
              onClick={() => setGoalText(String(p))}
            >
              {kcal(p)}
            </button>
          ))}
        </div>

        {showPasscode && (
          <label className="field">
            <span>Passcode {hasToken && <span className="muted">(saved on this device)</span>}</span>
            <input
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder={hasToken ? 'Leave blank to keep it' : 'Server passcode'}
              autoComplete="current-password"
            />
          </label>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      <div className="settings-info">
        <h3>Photo scanning</h3>
        <p className="muted">
          {health == null
            ? "Couldn't check the server status."
            : health.mock
              ? 'Demo mode (GEMINI_MOCK=1): every scan returns the same sample meal.'
              : health.gemini_configured
                ? 'Gemini is connected. Photos are analyzed and then discarded.'
                : (
                  <>
                    Not set up. Add <code>GEMINI_API_KEY</code> to <code>server/.env</code> and
                    restart the server.
                  </>
                )}
        </p>

        <h3>Use it like an app</h3>
        <p className="muted">
          iPhone: tap Share, then <em>Add to Home Screen</em>. Android: open the browser menu and
          choose <em>Install app</em> or <em>Add to Home screen</em>.
        </p>

        {hasToken && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onForgetPasscode}>
            Forget passcode on this device
          </button>
        )}
      </div>
    </Sheet>
  );
}
