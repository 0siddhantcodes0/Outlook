import { grams, kcal } from '../format.js';

const RADIUS = 84;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const MACROS = [
  { key: 'protein_g', label: 'Protein', kcalPerGram: 4 },
  { key: 'carbs_g', label: 'Carbs', kcalPerGram: 4 },
  { key: 'fat_g', label: 'Fat', kcalPerGram: 9 },
];

export default function CalorieSummary({ totals, goal, busy }) {
  const eaten = Math.round(totals?.calories ?? 0);
  const ready = totals != null && goal != null;
  const left = (goal ?? 0) - eaten;
  const over = ready && left < 0;
  const progress = ready && goal > 0 ? Math.min(eaten / goal, 1) : 0;

  const summary = ready
    ? `${kcal(eaten)} of ${kcal(goal)} kcal eaten, ${over ? `${kcal(-left)} over` : `${kcal(left)} left`}`
    : 'Loading';

  return (
    <section className={`card summary${over ? ' is-over' : ''}`} aria-busy={busy || !ready}>
      <div className="summary-top">
        <div className="ring" role="img" aria-label={summary}>
          <svg viewBox="0 0 200 200">
            <circle className="ring-track" cx="100" cy="100" r={RADIUS} />
            {progress > 0 && (
              <circle
                className="ring-value"
                cx="100"
                cy="100"
                r={RADIUS}
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
                transform="rotate(-90 100 100)"
              />
            )}
          </svg>
          <div className="ring-center" aria-hidden="true">
            <span className="ring-number">{ready ? kcal(Math.abs(left)) : '–'}</span>
            <span className="ring-caption">{over ? 'kcal over' : 'kcal left'}</span>
          </div>
        </div>

        <dl className="summary-stats">
          <div>
            <dt>Eaten</dt>
            <dd>
              {ready ? kcal(eaten) : '–'} <small>kcal</small>
            </dd>
          </div>
          <div>
            <dt>Goal</dt>
            <dd>
              {ready ? kcal(goal) : '–'} <small>kcal</small>
            </dd>
          </div>
          <div>
            <dt>{over ? 'Over' : 'Left'}</dt>
            <dd className="summary-left">
              {ready ? kcal(Math.abs(left)) : '–'} <small>kcal</small>
            </dd>
          </div>
        </dl>
      </div>

      <MacroRow totals={totals} />
    </section>
  );
}

// Grams per macro, with a bar showing its share of macro energy.
function MacroRow({ totals }) {
  const energy = MACROS.map((m) => (totals?.[m.key] ?? 0) * m.kcalPerGram);
  const sum = energy.reduce((a, b) => a + b, 0);

  return (
    <ul className="macro-row">
      {MACROS.map((m, i) => {
        const share = sum > 0 ? Math.round((energy[i] / sum) * 100) : 0;
        return (
          <li key={m.key} className={`macro macro-${m.key.replace('_g', '')}`}>
            <span className="macro-label">{m.label}</span>
            <span className="macro-value">{totals ? grams(totals[m.key]) : '–'}</span>
            <span
              className="macro-bar"
              role="img"
              aria-label={`${share}% of calories from ${m.label.toLowerCase()}`}
            >
              <span style={{ width: `${share}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
