import { grams, kcal } from '../format.js';
import { MACROS } from './CalorieSummary.jsx';

export function ItemList({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="item-list">
      {items.map((item, i) => (
        <li key={item.id ?? i}>
          <span className="item-name">
            {item.name}
            {item.portion && <small>{item.portion}</small>}
          </span>
          <span className="item-kcal">{kcal(item.calories)} kcal</span>
        </li>
      ))}
    </ul>
  );
}

export function MacroLine({ meal }) {
  const present = MACROS.filter((m) => meal[m.key] != null);
  if (!present.length) return null;
  return (
    <p className="macro-line">
      {present.map((m) => (
        <span key={m.key} className={`macro-chip macro-${m.key.replace('_g', '')}`}>
          {m.label} <strong>{grams(meal[m.key])}</strong>
        </span>
      ))}
    </p>
  );
}

const CONFIDENCE_LABEL = { low: 'Low confidence', medium: 'Medium confidence', high: 'High confidence' };

export function ConfidenceBadge({ confidence }) {
  if (!CONFIDENCE_LABEL[confidence]) return null;
  return <span className={`badge badge-${confidence}`}>{CONFIDENCE_LABEL[confidence]}</span>;
}
