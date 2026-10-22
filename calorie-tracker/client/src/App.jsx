import { useCallback, useEffect, useRef, useState } from 'react';
import { addDays, api, getToken, localDate, setToken } from './api.js';
import { describeError } from './errors.js';
import { dayLabel } from './format.js';
import CalorieSummary from './components/CalorieSummary.jsx';
import ConfirmDelete from './components/ConfirmDelete.jsx';
import Header from './components/Header.jsx';
import HistoryChart from './components/HistoryChart.jsx';
import { AlertIcon, CameraIcon, ImageIcon, SparkleIcon } from './components/Icons.jsx';
import MealForm from './components/MealForm.jsx';
import MealList from './components/MealList.jsx';
import PasscodePrompt from './components/PasscodePrompt.jsx';
import ScanSheet from './components/ScanSheet.jsx';
import SettingsSheet from './components/SettingsSheet.jsx';

const HISTORY_DAYS = 7;
const TOAST_MS = 2600;

export default function App() {
  const [today, setToday] = useState(localDate);
  const [date, setDate] = useState(today);
  const [day, setDay] = useState(null); // { date, meals, totals, goal }
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [health, setHealth] = useState(null);
  const [booted, setBooted] = useState(false);
  const [auth, setAuth] = useState(null); // null | 'needed' | 'rejected'
  const [sheet, setSheet] = useState(null); // { type: 'scan' | 'add' | 'edit' | 'delete' | 'settings', ... }
  const [toast, setToast] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const cameraInput = useRef(null);
  const galleryInput = useRef(null);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const showToast = useCallback((message) => setToast({ message, id: Date.now() }), []);
  const requireAuth = useCallback(() => setAuth(getToken() ? 'rejected' : 'needed'), []);
  const closeSheet = useCallback(() => setSheet(null), []);

  // Every mutation goes through here so a 401 anywhere brings up the passcode prompt.
  const call = useCallback(
    async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err.code === 'unauthorized') requireAuth();
        throw err;
      }
    },
    [requireAuth],
  );

  const checkHealth = useCallback(
    () =>
      api
        .health()
        .then((h) => {
          setHealth(h);
          if (h.auth_required && !getToken()) setAuth('needed');
        })
        .catch(() => {
          // Unreachable server: the data load shows the error.
        }),
    [],
  );

  useEffect(() => {
    checkHealth().finally(() => setBooted(true));
  }, [checkHealth]);

  // Server status can change too (key added, restarted in demo mode), so it is
  // re-checked along with the data whenever it might have.
  const refreshAll = useCallback(() => {
    checkHealth();
    refresh();
  }, [checkHealth, refresh]);

  // Keep "today" correct if the app stays open past midnight, and refresh
  // when the phone brings the app back to the foreground.
  useEffect(() => {
    const tick = () => setToday(localDate());
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      tick();
      refreshAll();
    };
    const id = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshAll]);

  // When the date rolls over, follow it if the old "today" was selected.
  const prevToday = useRef(today);
  useEffect(() => {
    const prev = prevToday.current;
    if (prev === today) return;
    prevToday.current = today;
    setDate((d) => (d === prev ? today : d));
  }, [today]);

  useEffect(() => {
    if (!booted || auth) return;
    let cancelled = false;
    // Keep the selected day inside the chart window.
    const historyEnd = date >= addDays(today, -(HISTORY_DAYS - 1)) ? today : date;
    setLoading(true);
    Promise.all([api.meals(date), api.history(historyEnd, HISTORY_DAYS)])
      .then(([dayData, historyData]) => {
        if (cancelled) return;
        setDay(dayData);
        setHistory(historyData);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.code === 'unauthorized') requireAuth();
        else setLoadError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [booted, auth, date, today, reloadKey, requireAuth]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast]);

  function pickFile(event) {
    const file = event.target.files?.[0];
    event.target.value = ''; // so picking the same photo again still fires change
    if (!file) return;
    // Some phones report HEIC with an empty type; let the server decide those.
    if (file.type && !file.type.startsWith('image/')) {
      showToast("That file isn't a photo.");
      return;
    }
    setSheet({ type: 'scan', file, key: `${file.name}-${file.size}-${Date.now()}` });
  }

  const takePhoto = () => cameraInput.current?.click();
  const choosePhoto = () => galleryInput.current?.click();

  function selectDay(next) {
    const target = next > today ? today : next;
    if (target === date) return;
    // An earlier failed refresh says nothing about the new day; without this,
    // the full-page error would show while it loads.
    setLoadError(null);
    setDate(target);
  }

  function selectFromChart(next) {
    selectDay(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function unlock(code) {
    setToken(code);
    try {
      await api.settings();
    } catch (err) {
      setToken(''); // only keep a passcode the server has accepted
      throw err;
    }
    setAuth(null);
    refresh();
  }

  async function addMeal(fields) {
    await call(() => api.addMeal({ ...fields, date }));
    setSheet(null);
    refresh();
    showToast(`Added ${fields.meal_name}`);
  }

  async function editMeal(meal, fields) {
    await call(() => api.updateMeal(meal.id, fields));
    setSheet(null);
    refresh();
    showToast('Meal updated');
  }

  async function deleteMeal(meal) {
    await call(() => api.deleteMeal(meal.id));
    setSheet(null);
    // Drop it from the list right away; totals catch up with the refresh.
    setDay((d) => d && { ...d, meals: d.meals.filter((m) => m.id !== meal.id) });
    refresh();
    showToast('Meal deleted');
  }

  async function saveSettings({ dailyGoal, passcode }) {
    const previousToken = getToken();
    if (passcode) setToken(passcode);
    try {
      await api.saveSettings({ daily_goal: dailyGoal });
    } catch (err) {
      if (passcode) setToken(previousToken); // only keep a passcode the server has accepted
      else if (err.code === 'unauthorized') requireAuth();
      throw err;
    }
    setSheet(null);
    refresh();
    showToast('Settings saved');
  }

  function forgetPasscode() {
    setToken('');
    setSheet(null);
    if (health?.auth_required) setAuth('needed');
    showToast('Passcode removed from this device');
  }

  const isToday = date === today;
  const dayName = dayLabel(date, today);
  const dayPhrase = isToday || dayName === 'Yesterday' ? dayName.toLowerCase() : dayName;
  // While a new day loads, keep showing the previous one (dimmed) instead of flashing.
  const shown = day && (day.date === date || (loading && !loadError)) ? day : null;
  const stale = day != null && day.date !== date;
  const scanningOff = health && !health.mock && !health.gemini_configured;

  return (
    <div className="app">
      <Header
        date={date}
        today={today}
        onChangeDate={selectDay}
        onOpenSettings={() => setSheet({ type: 'settings' })}
      />

      <main className="app-main">
        {scanningOff && (
          <p className="banner">
            <AlertIcon size={18} />
            <span>
              Photo scanning is off: add <code>GEMINI_API_KEY</code> to <code>server/.env</code> and
              restart the server. Manual logging still works.
            </span>
          </p>
        )}
        {health?.mock && (
          <p className="banner banner-info">
            <SparkleIcon size={18} />
            <span>Demo mode: every scan returns a sample meal.</span>
          </p>
        )}

        {loadError && !shown ? (
          <LoadError error={loadError} onRetry={refreshAll} />
        ) : (
          <div className={`day-view${stale ? ' is-stale' : ''}`}>
            {loadError && (
              <p className="banner">
                <AlertIcon size={18} />
                <span>Couldn't refresh. Showing the last data loaded.</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>
                  Retry
                </button>
              </p>
            )}
            <CalorieSummary totals={shown?.totals} goal={shown?.goal} busy={loading} />
            <MealList
              meals={shown?.meals}
              isToday={isToday}
              onAdd={() => setSheet({ type: 'add' })}
              onEdit={(meal) => setSheet({ type: 'edit', meal })}
              onDelete={(meal) => setSheet({ type: 'delete', meal })}
            />
          </div>
        )}

        <HistoryChart history={history} today={today} selected={date} onSelect={selectFromChart} />
      </main>

      <div className="action-bar">
        <div className="action-bar-inner">
          <button
            type="button"
            className="btn btn-secondary btn-lg"
            onClick={choosePhoto}
            aria-label="Choose from gallery"
          >
            <ImageIcon size={22} /> Gallery
          </button>
          <button type="button" className="btn btn-primary btn-lg btn-scan" onClick={takePhoto}>
            <CameraIcon size={22} /> Scan food
          </button>
        </div>
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={pickFile}
          hidden
        />
        <input ref={galleryInput} type="file" accept="image/*" onChange={pickFile} hidden />
      </div>

      {sheet?.type === 'scan' && (
        <ScanSheet
          key={sheet.key}
          file={sheet.file}
          date={date}
          dayName={dayPhrase}
          onClose={closeSheet}
          onLogged={refreshAll}
          onEdit={(meal) => setSheet({ type: 'edit', meal })}
          onTakePhoto={takePhoto}
          onChoosePhoto={choosePhoto}
          onAddManually={() => setSheet({ type: 'add' })}
          onUnauthorized={requireAuth}
        />
      )}
      {sheet?.type === 'add' && (
        <MealForm dayName={dayPhrase} onSubmit={addMeal} onClose={closeSheet} />
      )}
      {sheet?.type === 'edit' && (
        <MealForm
          meal={sheet.meal}
          onSubmit={(fields) => editMeal(sheet.meal, fields)}
          onClose={closeSheet}
        />
      )}
      {sheet?.type === 'delete' && (
        <ConfirmDelete meal={sheet.meal} onConfirm={deleteMeal} onClose={closeSheet} />
      )}
      {sheet?.type === 'settings' && (
        <SettingsSheet
          goal={day?.goal ?? history?.goal}
          health={health}
          onSave={saveSettings}
          onForgetPasscode={forgetPasscode}
          onClose={closeSheet}
        />
      )}

      {auth && <PasscodePrompt key={auth} rejected={auth === 'rejected'} onSubmit={unlock} />}

      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.id}>
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadError({ error, onRetry }) {
  const { title, body } = describeError(error);
  return (
    <div className="card load-error" role="alert">
      <AlertIcon size={28} />
      <p className="empty-title">{title}</p>
      <p className="muted">{body}</p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
