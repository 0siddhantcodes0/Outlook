import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnalysisError, normalizeAnalysis } from '../src/nutrition.js';
import { SAMPLE_ANALYSIS } from './helpers.js';

describe('normalizeAnalysis', () => {
  it('passes a clean object through', () => {
    const result = normalizeAnalysis(SAMPLE_ANALYSIS);
    assert.equal(result.is_food, true);
    assert.equal(result.meal_name, 'Toast and eggs');
    assert.equal(result.total_calories, 310);
    assert.equal(result.protein_g, 15.7);
    assert.equal(result.carbs_g, 14.3);
    assert.equal(result.fat_g, 20.9);
    assert.equal(result.confidence, 'high');
    assert.equal(result.notes, 'Assumed one pat of butter.');
    assert.deepEqual(result.items[0], {
      name: 'Fried egg',
      portion: '2 large',
      calories: 180,
      protein_g: 12.6,
      carbs_g: 0.8,
      fat_g: 14,
    });
  });

  it('parses a JSON string', () => {
    assert.equal(normalizeAnalysis(JSON.stringify(SAMPLE_ANALYSIS)).total_calories, 310);
  });

  it('parses JSON wrapped in ```json fences', () => {
    const text = '```json\n' + JSON.stringify(SAMPLE_ANALYSIS, null, 2) + '\n```';
    assert.equal(normalizeAnalysis(text).meal_name, 'Toast and eggs');
  });

  it('parses JSON in bare ``` fences and JSON surrounded by prose', () => {
    assert.equal(normalizeAnalysis('```\n' + JSON.stringify(SAMPLE_ANALYSIS) + '\n```').total_calories, 310);
    assert.equal(normalizeAnalysis(`Here you go: ${JSON.stringify(SAMPLE_ANALYSIS)} Enjoy!`).total_calories, 310);
  });

  it('coerces numeric strings', () => {
    const result = normalizeAnalysis({
      is_food: 'true',
      meal_name: 'Pizza',
      items: [{ name: 'Pizza', portion: '2 slices', calories: '1,200 kcal', protein_g: '50.25g', carbs_g: '140', fat_g: ' 45 ' }],
      total_calories: '1200',
    });
    assert.equal(result.is_food, true);
    assert.deepEqual(result.items[0], {
      name: 'Pizza',
      portion: '2 slices',
      calories: 1200,
      protein_g: 50.3,
      carbs_g: 140,
      fat_g: 45,
    });
  });

  it('clamps negatives to 0 and rounds kcal to integers and macros to 1 decimal', () => {
    const result = normalizeAnalysis({
      is_food: true,
      meal_name: 'Odd',
      items: [{ name: 'Thing', portion: '1', calories: -40.6, protein_g: -1, carbs_g: 2.345, fat_g: 0.04 }],
      total_calories: -40,
    });
    assert.deepEqual(result.items[0], { name: 'Thing', portion: '1', calories: 0, protein_g: 0, carbs_g: 2.3, fat_g: 0 });
    assert.equal(result.total_calories, 0);
  });

  it('recomputes the total from the items when they disagree', () => {
    const result = normalizeAnalysis({ ...SAMPLE_ANALYSIS, total_calories: 999 });
    assert.equal(result.total_calories, 310);
  });

  it('rounds item kcal before summing', () => {
    const result = normalizeAnalysis({
      is_food: true,
      meal_name: 'Snacks',
      items: [
        { name: 'A', calories: 100.4 },
        { name: 'B', calories: 100.4 },
      ],
    });
    assert.equal(result.total_calories, 200);
  });

  it('trims strings, drops items without a name, and nulls unknown macros', () => {
    const result = normalizeAnalysis({
      is_food: true,
      meal_name: '  Salad \n bowl ',
      items: [
        { name: '   ', calories: 500 },
        { name: null, calories: 500 },
        'not an item',
        { name: ' Lettuce ', portion: '  ', calories: 15, protein_g: 'n/a' },
        { name: 'Dressing', calories: 90, protein_g: 0.2, fat_g: 9 },
      ],
      notes: '   ',
    });
    assert.equal(result.meal_name, 'Salad bowl');
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0], { name: 'Lettuce', portion: null, calories: 15, protein_g: null, carbs_g: null, fat_g: null });
    assert.equal(result.total_calories, 105);
    assert.equal(result.protein_g, 0.2); // only known values are summed
    assert.equal(result.carbs_g, null); // no item knows its carbs
    assert.equal(result.fat_g, 9);
    assert.equal(result.notes, null);
  });

  it('falls back to "medium" confidence and builds a meal name from the items', () => {
    const result = normalizeAnalysis({
      is_food: true,
      meal_name: '',
      confidence: 'very sure',
      items: [{ name: 'Apple', calories: 95 }, { name: 'Peanut butter', calories: 190 }],
    });
    assert.equal(result.confidence, 'medium');
    assert.equal(result.meal_name, 'Apple, Peanut butter');
    assert.equal(normalizeAnalysis({ ...SAMPLE_ANALYSIS, confidence: ' LOW ' }).confidence, 'low');
  });

  it('uses the meal-level total when there are no items', () => {
    const result = normalizeAnalysis({
      is_food: true,
      meal_name: 'Smoothie',
      items: [],
      total_calories: '320.6',
      protein_g: 10.04,
    });
    assert.equal(result.total_calories, 321);
    assert.deepEqual(result.items, []);
    assert.equal(result.protein_g, 10);
    assert.equal(result.carbs_g, null);
  });

  it('throws when food has no items and no total', () => {
    assert.throws(
      () => normalizeAnalysis({ is_food: true, meal_name: 'Mystery', items: [] }),
      (err) => err instanceof AnalysisError && err.code === 'analysis_failed' && err.status === 502,
    );
  });

  it('throws when food has no items and a zero total (the schema always sends one)', () => {
    assert.throws(
      () =>
        normalizeAnalysis({
          is_food: true,
          meal_name: 'Blurry plate',
          items: [],
          total_calories: 0,
          confidence: 'low',
          notes: 'Could not identify the food.',
        }),
      AnalysisError,
    );
  });

  it('returns is_food=false with empty items for non-food', () => {
    const result = normalizeAnalysis({
      is_food: false,
      meal_name: '',
      items: [{ name: 'Keyboard', calories: 0 }],
      total_calories: 0,
      confidence: 'high',
      notes: 'This is a laptop keyboard.',
    });
    assert.equal(result.is_food, false);
    assert.deepEqual(result.items, []);
    assert.equal(result.total_calories, 0);
    assert.equal(result.notes, 'This is a laptop keyboard.');
  });

  it('infers is_food when the flag is missing', () => {
    const { is_food: _, ...withoutFlag } = SAMPLE_ANALYSIS;
    assert.equal(normalizeAnalysis(withoutFlag).is_food, true);
    assert.equal(normalizeAnalysis({ items: [], notes: 'empty plate' }).is_food, false);
  });

  it('throws a typed error for garbage', () => {
    for (const garbage of ['not json at all', '```json\n{oops\n```', '', '[1, 2]', '42', null, undefined, 42, [], true]) {
      assert.throws(() => normalizeAnalysis(garbage), AnalysisError, `should reject ${JSON.stringify(garbage)}`);
    }
  });
});
