import { useState } from 'react';
import { parseDecimal, parseWhole } from '../format.js';
import { MACROS } from './CalorieSummary.jsx';
import Sheet from './Sheet.jsx';

const MAX_KCAL = 50_000; // same limit as the server
const toField = (value) => (value == null ? '' : String(value));

// Add-manually and edit share one form. On edit, a cleared macro is sent as
// null so it is removed rather than silently kept.
export default function MealForm({ meal, dayName, onSubmit, onClose }) {
  const editing = Boolean(meal);
  const [values, setValues] = useState(() => ({
    meal_name: meal?.meal_name ?? '',
    total_calories: toField(meal?.total_calories),
    ...Object.fromEntries(MACROS.map((m) => [m.key, toField(meal?.[m.key])])),
  }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (key) => (event) => {
    setValues((v) => ({ ...v, [key]: event.target.value }));
    setError('');
  };

  function collect() {
    const name = values.meal_name.trim();
    if (!name) throw new Error('Give it a name, like "Banana" or "Latte".');

    const calories = parseWhole(values.total_calories);
    // Scan totals have no upper limit, so an untouched total is not re-checked
    // (or re-sent): renaming a huge meal must still work.
    const keepCalories = editing && calories === meal.total_calories;
    if (!keepCalories && (calories == null || Number.isNaN(calories) || calories > MAX_KCAL)) {
      throw new Error(`Calories must be a whole number from 0 to ${MAX_KCAL.toLocaleString()}.`);
    }

    const fields = { meal_name: name };
    if (!keepCalories) fields.total_calories = calories;
    for (const m of MACROS) {
      const grams = parseDecimal(values[m.key]);
      if (Number.isNaN(grams) || grams < 0) throw new Error(`${m.label} must be a number of grams.`);
      if (grams != null) fields[m.key] = Math.round(grams * 10) / 10;
      else if (editing && meal[m.key] != null) fields[m.key] = null;
    }
    return fields;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    let fields;
    try {
      fields = collect();
    } catch (err) {
      setError(err.message);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit(fields);
    } catch (err) {
      setError(err.code === 'network_error' ? "Couldn't reach the server. Try again." : err.message);
      setSaving(false);
    }
  }

  return (
    <Sheet title={editing ? 'Edit meal' : 'Add manually'} onClose={onClose} dismissible={!saving}>
      <form className="form" onSubmit={handleSubmit} noValidate>
        {!editing && dayName && <p className="muted form-intro">Logs to {dayName}.</p>}

        <label className="field">
          <span>Name</span>
          <input
            value={values.meal_name}
            onChange={set('meal_name')}
            placeholder="e.g. Protein bar"
            maxLength={120}
            autoComplete="off"
            enterKeyHint="next"
            required
          />
        </label>

        <label className="field">
          <span>Calories</span>
          <div className="input-unit">
            <input
              value={values.total_calories}
              onChange={set('total_calories')}
              inputMode="numeric"
              placeholder="0"
              autoComplete="off"
              required
            />
            <span>kcal</span>
          </div>
        </label>

        <fieldset className="field-row">
          <legend>
            Macros <span className="muted">(optional)</span>
          </legend>
          {MACROS.map((m) => (
            <label key={m.key} className="field">
              <span>{m.label}</span>
              <div className="input-unit">
                <input
                  value={values[m.key]}
                  onChange={set(m.key)}
                  inputMode="decimal"
                  placeholder="–"
                  autoComplete="off"
                />
                <span>g</span>
              </div>
            </label>
          ))}
        </fieldset>

        {editing && meal.items?.length > 0 && (
          <p className="muted small">
            Item breakdown from the scan stays as it was; only the totals change.
          </p>
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
            {saving ? 'Saving…' : editing ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
