import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { describeError } from '../errors.js';
import { kcal } from '../format.js';
import { resizeImage } from '../imageResize.js';
import { AlertIcon, CameraIcon, CheckIcon, ImageIcon, PencilIcon } from './Icons.jsx';
import { ConfidenceBadge, ItemList, MacroLine } from './MealDetails.jsx';
import Sheet from './Sheet.jsx';

const SCAN_TIMEOUT_MS = 120_000;
// Cancel appears where Analyze was, so the second tap of a double tap would hit it.
const CANCEL_GRACE_MS = 600;
const STEPS = [
  'Looking at your photo…',
  'Spotting each food…',
  'Estimating portions…',
  'Counting calories…',
  'Almost there…',
];

export default function ScanSheet({
  file,
  date,
  dayName,
  onClose,
  onLogged,
  onEdit,
  onTakePhoto,
  onChoosePhoto,
  onAddManually,
  onUnauthorized,
}) {
  const [phase, setPhase] = useState('ready'); // ready | analyzing | done | error
  const [hint, setHint] = useState('');
  const [meal, setMeal] = useState(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const prepared = useRef(null);
  const controller = useRef(null);
  const startedAt = useRef(0);

  // Downscale once, up front, and preview the result (already upright).
  useEffect(() => {
    let url;
    let cancelled = false;
    const job = resizeImage(file);
    prepared.current = job;
    job.then((image) => {
      if (cancelled) return;
      url = URL.createObjectURL(image);
      setPreview(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  useEffect(() => () => controller.current?.abort(), []);

  async function analyze(event) {
    event?.preventDefault();
    const ctrl = new AbortController();
    controller.current = ctrl;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, SCAN_TIMEOUT_MS);

    startedAt.current = Date.now();
    setPhase('analyzing');
    setError(null);
    try {
      const image = await prepared.current;
      const result = await api.scan({ file: image, date, hint: hint.trim(), signal: ctrl.signal });
      setMeal(result);
      setPhase('done');
      onLogged(result);
    } catch (err) {
      if (err.name === 'AbortError' && !timedOut) return; // cancelled by the user
      if (timedOut) onLogged(); // in case the server saved it just as we gave up
      const failure = timedOut ? { code: 'timeout' } : err;
      if (failure.code === 'unauthorized') onUnauthorized();
      setError(failure);
      setPhase('error');
    } finally {
      clearTimeout(timer);
      if (controller.current === ctrl) controller.current = null;
    }
  }

  function cancelAnalyze() {
    if (Date.now() - startedAt.current < CANCEL_GRACE_MS) return;
    controller.current?.abort();
    setPhase('ready');
    // The server drops a scan whose client went away, unless it had already
    // saved it; refresh so such a meal shows up instead of being scanned twice.
    onLogged();
  }

  const busy = phase === 'analyzing';

  return (
    <Sheet
      title={phase === 'done' ? 'Meal logged' : 'Scan food'}
      onClose={onClose}
      dismissible={!busy}
      className="scan-sheet"
    >
      {phase === 'done' ? (
        <ScanResult
          meal={meal}
          preview={previewFailed ? null : preview}
          dayName={dayName}
          onDone={onClose}
          onEdit={() => onEdit(meal)}
          onScanAnother={onTakePhoto}
        />
      ) : (
        <>
          <figure className={`scan-photo${busy ? ' is-analyzing' : ''}`}>
            {previewFailed ? (
              <div className="scan-photo-fallback">
                <ImageIcon size={32} />
                <span>No preview for this format, but it can still be analyzed.</span>
              </div>
            ) : preview ? (
              <img src={preview} alt="Your photo" onError={() => setPreviewFailed(true)} />
            ) : (
              <div className="scan-photo-loading" aria-label="Preparing photo" />
            )}
            {busy && <span className="scan-line" aria-hidden="true" />}
          </figure>

          {busy ? (
            <div className="analyzing">
              <AnalyzingStatus />
              <button type="button" className="btn btn-secondary btn-block" onClick={cancelAnalyze}>
                Cancel
              </button>
            </div>
          ) : (
            <form className="form" onSubmit={analyze}>
              {error && <ScanError error={error} />}

              <label className="field">
                <span>
                  Hint <span className="muted">(optional)</span>
                </span>
                <input
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  maxLength={300}
                  placeholder="e.g. 2 slices, no sugar"
                  autoComplete="off"
                  enterKeyHint="go"
                />
              </label>
              <p className="muted small">
                Logs to {dayName}. The photo is analyzed, then thrown away.
              </p>

              <ScanActions
                error={error}
                onClose={onClose}
                onChoosePhoto={onChoosePhoto}
                onAddManually={onAddManually}
              />
            </form>
          )}
        </>
      )}
    </Sheet>
  );
}

function ScanActions({ error, onClose, onChoosePhoto, onAddManually }) {
  const described = error && describeError(error);
  let secondary = (
    <button type="button" className="btn btn-secondary" onClick={onClose}>
      Cancel
    </button>
  );
  let primary = (
    <button type="submit" className="btn btn-primary">
      {error ? 'Try again' : 'Analyze'}
    </button>
  );

  if (described?.setup) {
    primary = (
      <button type="button" className="btn btn-primary" onClick={onAddManually}>
        <PencilIcon size={18} /> Add manually
      </button>
    );
  } else if (described && !described.retry) {
    primary = (
      <button type="button" className="btn btn-primary" onClick={onChoosePhoto}>
        <ImageIcon size={18} /> Choose another
      </button>
    );
  } else if (error) {
    secondary = (
      <button type="button" className="btn btn-secondary" onClick={onChoosePhoto}>
        Other photo
      </button>
    );
  }

  return (
    <div className="btn-row">
      {secondary}
      {primary}
    </div>
  );
}

// Wrap file and variable names in <code> so setup hints stand out.
function withCode(text) {
  return text.split(/(GEMINI_API_KEY|GEMINI_MODEL|server\/\.env)/).map((part, i) =>
    i % 2 ? <code key={i}>{part}</code> : part,
  );
}

function ScanError({ error }) {
  const { title, body } = describeError(error);
  return (
    <div className="alert alert-error" role="alert">
      <AlertIcon size={22} />
      <div>
        <p className="alert-title">{title}</p>
        <p>{withCode(body)}</p>
      </div>
    </div>
  );
}

function AnalyzingStatus() {
  const [step, setStep] = useState(0);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      setSeconds(Math.floor(elapsed));
      setStep(Math.min(STEPS.length - 1, Math.floor(elapsed / 2.5)));
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="analyzing-status" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div>
        <p className="analyzing-step">{STEPS[step]}</p>
        <p className="muted small">
          Gemini usually takes 3 to 10 seconds{seconds >= 5 ? ` · ${seconds}s` : ''}
        </p>
      </div>
      <span className="progress" aria-hidden="true">
        <span />
      </span>
    </div>
  );
}

function ScanResult({ meal, preview, dayName, onDone, onEdit, onScanAnother }) {
  return (
    <div className="scan-result">
      <p className="logged-banner">
        <CheckIcon size={18} /> Saved to {dayName}
      </p>

      <div className="result-head">
        {preview && <img className="result-thumb" src={preview} alt="" />}
        <div>
          <h3>{meal.meal_name}</h3>
          <ConfidenceBadge confidence={meal.confidence} />
        </div>
      </div>

      <ItemList items={meal.items} />

      <div className="result-total">
        <span>Total</span>
        <strong>{kcal(meal.total_calories)} kcal</strong>
      </div>
      <MacroLine meal={meal} />
      {meal.notes && <p className="result-notes">{meal.notes}</p>}

      <button type="button" className="btn btn-primary btn-block" onClick={onDone} autoFocus>
        Done
      </button>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={onEdit}>
          <PencilIcon size={16} /> Edit
        </button>
        <button type="button" className="btn btn-secondary" onClick={onScanAnother}>
          <CameraIcon size={18} /> Scan another
        </button>
      </div>
    </div>
  );
}
