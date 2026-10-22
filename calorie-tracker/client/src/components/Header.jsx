import { addDays } from '../api.js';
import { dayLabel, daySubtitle } from '../format.js';
import { ChevronLeftIcon, ChevronRightIcon, SettingsIcon } from './Icons.jsx';

export default function Header({ date, today, onChangeDate, onOpenSettings }) {
  const isToday = date === today;
  const title = dayLabel(date, today);

  const openPicker = (event) => {
    try {
      event.currentTarget.showPicker?.();
    } catch {
      // Not allowed in this context; the browser's default handling still applies.
    }
  };

  const pick = (event) => {
    const value = event.target.value;
    if (value) onChangeDate(value > today ? today : value);
  };

  return (
    <header className="app-header">
      <div className="app-header-inner">
        {isToday ? (
          <img className="brand-mark" src="/icon.svg" alt="" width="32" height="32" />
        ) : (
          <button type="button" className="chip-btn" onClick={() => onChangeDate(today)}>
            Today
          </button>
        )}

        <nav className="day-switcher" aria-label="Day">
          <button
            type="button"
            className="icon-btn"
            onClick={() => onChangeDate(addDays(date, -1))}
            aria-label="Previous day"
          >
            <ChevronLeftIcon />
          </button>

          <label className="day-label">
            <span className="day-title">{title}</span>
            <span className="day-sub">{daySubtitle(date, today)}</span>
            <input
              type="date"
              className="day-picker"
              value={date}
              max={today}
              onChange={pick}
              onClick={openPicker}
              aria-label={`Pick a day, currently ${title}`}
            />
          </label>

          <button
            type="button"
            className="icon-btn"
            onClick={() => onChangeDate(addDays(date, 1))}
            disabled={isToday}
            aria-label="Next day"
          >
            <ChevronRightIcon />
          </button>
        </nav>

        <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
