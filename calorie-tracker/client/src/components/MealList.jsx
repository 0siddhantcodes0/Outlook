import { useId, useState } from 'react';
import { kcal, timeOf } from '../format.js';
import { CameraIcon, ChevronDownIcon, PencilIcon, PlusIcon, TrashIcon } from './Icons.jsx';
import { ConfidenceBadge, ItemList, MacroLine } from './MealDetails.jsx';

export default function MealList({ meals, isToday, onAdd, onEdit, onDelete }) {
  return (
    <section className="meals" aria-labelledby="meals-title">
      <div className="section-head">
        <h2 id="meals-title">Meals</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onAdd}>
          <PlusIcon size={18} /> Add manually
        </button>
      </div>

      {meals == null ? (
        <ul className="meal-list" aria-hidden="true">
          <li className="meal meal-skeleton" />
          <li className="meal meal-skeleton" />
        </ul>
      ) : meals.length === 0 ? (
        <div className="empty card">
          <p className="empty-title">{isToday ? 'Nothing logged yet today' : 'Nothing logged this day'}</p>
          <p className="muted">Scan a meal with your camera, or add one by hand.</p>
        </div>
      ) : (
        <ul className="meal-list">
          {meals.map((meal) => (
            <MealCard key={meal.id} meal={meal} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MealCard({ meal, onEdit, onDelete }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const itemCount = meal.items?.length ?? 0;
  const meta = [timeOf(meal.logged_at), itemCount ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : 'Manual']
    .filter(Boolean)
    .join(' · ');

  return (
    <li className={`meal${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="meal-summary"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={detailsId}
      >
        <span className="meal-icon" aria-hidden="true">
          {meal.source === 'scan' ? <CameraIcon size={20} /> : <PencilIcon size={18} />}
        </span>
        <span className="meal-main">
          <span className="meal-name">{meal.meal_name}</span>
          <span className="meal-meta">{meta}</span>
        </span>
        <span className="meal-kcal">
          {kcal(meal.total_calories)}
          <small>kcal</small>
        </span>
        <ChevronDownIcon className="meal-chevron" size={20} />
      </button>

      <div className="meal-details" id={detailsId} hidden={!open}>
        {open && (
          <>
            <ItemList items={meal.items} />
            <MacroLine meal={meal} />
            {(meal.confidence || meal.notes) && (
              <div className="meal-notes">
                <ConfidenceBadge confidence={meal.confidence} />
                {meal.notes && <p>{meal.notes}</p>}
              </div>
            )}
            <div className="meal-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit(meal)}>
                <PencilIcon size={16} /> Edit
              </button>
              <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => onDelete(meal)}>
                <TrashIcon size={16} /> Delete
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
