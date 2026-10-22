import { HttpError } from './errors.js';

/** The model's answer could not be turned into a usable meal. */
export class AnalysisError extends HttpError {
  constructor(message) {
    super(502, 'analysis_failed', message);
    this.name = 'AnalysisError';
  }
}

const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high']);
const MACROS = ['protein_g', 'carbs_g', 'fat_g'];
const MAX_NAME = 120;
const MAX_NOTES = 1000;

/**
 * Turns whatever the model returned (an object, a JSON string, or JSON wrapped
 * in ``` fences) into a clean analysis:
 *
 *   { is_food, meal_name, items: [{ name, portion, calories, protein_g, carbs_g, fat_g }],
 *     total_calories, protein_g, carbs_g, fat_g, confidence, notes }
 *
 * Per-item numbers win: when there are items, the meal total and macros are
 * their sums. Throws AnalysisError when nothing usable is left.
 */
export function normalizeAnalysis(raw) {
  const data = toObject(raw);
  const items = (Array.isArray(data.items) ? data.items : []).map(normalizeItem).filter(Boolean);
  const reportedTotal = toNumber(data.total_calories);
  const isFood = toBoolean(data.is_food) ?? (items.length > 0 || reportedTotal > 0);
  const confidence = typeof data.confidence === 'string' ? data.confidence.trim().toLowerCase() : '';

  const common = {
    confidence: CONFIDENCE_LEVELS.has(confidence) ? confidence : 'medium',
    notes: cleanText(data.notes, MAX_NOTES) || null,
  };

  if (!isFood) {
    return {
      is_food: false,
      meal_name: cleanText(data.meal_name, MAX_NAME),
      items: [],
      total_calories: 0,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      ...common,
    };
  }

  let totals;
  if (items.length > 0) {
    totals = { total_calories: items.reduce((sum, item) => sum + item.calories, 0) };
    for (const key of MACROS) totals[key] = sumGrams(items.map((item) => item[key]));
  } else if (reportedTotal > 0) {
    // No breakdown, but the model still gave a meal-level estimate. A 0 here is
    // just the schema's required field filled in, not an estimate.
    totals = { total_calories: kcal(reportedTotal) };
    for (const key of MACROS) totals[key] = grams(toNumber(data[key]));
  } else {
    throw new AnalysisError('Could not estimate the calories in this photo. Try a clearer photo or add a hint.');
  }

  const mealName =
    cleanText(data.meal_name, MAX_NAME) ||
    items.slice(0, 3).map((item) => item.name).join(', ') ||
    'Meal';

  return { is_food: true, meal_name: mealName, items, ...totals, ...common };
}

function normalizeItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const name = cleanText(item.name, MAX_NAME);
  if (!name) return null;
  return {
    name,
    portion: cleanText(item.portion, MAX_NAME) || null,
    calories: kcal(toNumber(item.calories)),
    protein_g: grams(toNumber(item.protein_g)),
    carbs_g: grams(toNumber(item.carbs_g)),
    fat_g: grams(toNumber(item.fat_g)),
  };
}

function toObject(raw) {
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalysisError('The analysis was not a JSON object.');
  }
  return value;
}

function parseJson(text) {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    // The model may have wrapped the JSON in prose; try the outermost braces.
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
  }
  throw new AnalysisError('The analysis was not valid JSON.');
}

/** A finite number from a number or a string such as "1,200 kcal"; otherwise null. */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /-?\d+(?:\.\d+)?/.exec(value.replace(/(\d),(?=\d{3}\b)/g, '$1'));
  return match ? Number(match[0]) : null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === 'yes') return true;
    if (text === 'false' || text === 'no') return false;
  }
  return null;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

const kcal = (value) => Math.round(Math.max(0, value ?? 0));
const round1 = (value) => Math.round(value * 10) / 10;
const grams = (value) => (value === null ? null : round1(Math.max(0, value)));

/** Sum of the known values, or null when none are known. */
function sumGrams(values) {
  const known = values.filter((value) => value !== null);
  return known.length > 0 ? round1(known.reduce((sum, value) => sum + value, 0)) : null;
}
