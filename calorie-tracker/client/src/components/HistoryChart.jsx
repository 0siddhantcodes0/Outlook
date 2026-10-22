import { dayLabel, kcal, weekday } from '../format.js';

// Seven columns against a dashed goal line. Tapping a column opens that day.
export default function HistoryChart({ history, today, selected, onSelect }) {
  if (!history?.days?.length) return null;
  const { days, goal } = history;

  const max = Math.max(goal * 1.15, ...days.map((d) => d.calories), 1);
  const logged = days.filter((d) => d.calories > 0);
  const average = logged.length ? logged.reduce((sum, d) => sum + d.calories, 0) / logged.length : 0;
  const onTarget = logged.filter((d) => d.calories <= goal).length;

  return (
    <section className="card history" aria-labelledby="history-title">
      <div className="section-head">
        <h2 id="history-title">Last {days.length} days</h2>
        <span className="muted small">
          {logged.length
            ? `Avg ${kcal(average)} kcal · ${onTarget}/${logged.length} on target`
            : 'No meals yet'}
        </span>
      </div>

      <div className="chart" style={{ '--goal': goal / max }}>
        <div className="chart-goal" aria-hidden="true">
          <span>{kcal(goal)}</span>
        </div>
        {days.map((d) => {
          const isToday = d.date === today;
          const isSelected = d.date === selected;
          const over = d.calories > goal;
          const label = `${dayLabel(d.date, today)}: ${kcal(d.calories)} kcal`;
          return (
            <button
              key={d.date}
              type="button"
              className={[
                'chart-col',
                isToday && 'is-today',
                isSelected && 'is-selected',
                over && 'is-over',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(d.date)}
              aria-label={label}
              aria-pressed={isSelected}
              title={label}
            >
              <span className="chart-track">
                {d.calories > 0 && (
                  <span className="chart-bar" style={{ height: `${(d.calories / max) * 100}%` }}>
                    {isSelected && <span className="chart-value">{kcal(d.calories)}</span>}
                  </span>
                )}
              </span>
              <span className="chart-day">{isToday ? 'Today' : weekday(d.date)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
