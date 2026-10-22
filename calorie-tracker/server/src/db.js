import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DEFAULT_DAILY_GOAL = 2000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    logged_at TEXT NOT NULL,
    meal_name TEXT NOT NULL,
    total_calories INTEGER NOT NULL,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL,
    confidence TEXT,
    notes TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meals_date ON meals(date);

  CREATE TABLE IF NOT EXISTS meal_items (
    id INTEGER PRIMARY KEY,
    meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    portion TEXT,
    calories INTEGER NOT NULL,
    protein_g REAL,
    carbs_g REAL,
    fat_g REAL
  );
  CREATE INDEX IF NOT EXISTS meal_items_meal_id ON meal_items(meal_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** Opens (creating if needed) the database at `file`, or ':memory:'. */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('daily_goal', ?)").run(
    String(DEFAULT_DAILY_GOAL),
  );
  return db;
}

// Prepared statements, cached per connection.
const statements = new WeakMap();
function sql(db, text) {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let statement = cache.get(text);
  if (!statement) cache.set(text, (statement = db.prepare(text)));
  return statement;
}

const MEAL_COLUMNS =
  'id, date, logged_at, meal_name, total_calories, protein_g, carbs_g, fat_g, confidence, notes, source';
const ITEM_COLUMNS = 'id, meal_id, name, portion, calories, protein_g, carbs_g, fat_g';

/** Inserts a meal and its items in one transaction and returns the saved meal. */
export function insertMeal(db, meal, items = []) {
  const insertMealRow = sql(
    db,
    `INSERT INTO meals (date, logged_at, meal_name, total_calories, protein_g, carbs_g, fat_g, confidence, notes, source)
     VALUES (@date, @logged_at, @meal_name, @total_calories, @protein_g, @carbs_g, @fat_g, @confidence, @notes, @source)`,
  );
  const insertItemRow = sql(
    db,
    `INSERT INTO meal_items (meal_id, name, portion, calories, protein_g, carbs_g, fat_g)
     VALUES (@meal_id, @name, @portion, @calories, @protein_g, @carbs_g, @fat_g)`,
  );

  const id = db.transaction(() => {
    const { lastInsertRowid: mealId } = insertMealRow.run({
      date: meal.date,
      logged_at: meal.logged_at ?? new Date().toISOString(),
      meal_name: meal.meal_name,
      total_calories: meal.total_calories,
      protein_g: meal.protein_g ?? null,
      carbs_g: meal.carbs_g ?? null,
      fat_g: meal.fat_g ?? null,
      confidence: meal.confidence ?? null,
      notes: meal.notes ?? null,
      source: meal.source,
    });
    for (const item of items) {
      insertItemRow.run({
        meal_id: mealId,
        name: item.name,
        portion: item.portion ?? null,
        calories: item.calories,
        protein_g: item.protein_g ?? null,
        carbs_g: item.carbs_g ?? null,
        fat_g: item.fat_g ?? null,
      });
    }
    return mealId;
  })();
  return getMeal(db, id);
}

/** The meal with its items, or null. */
export function getMeal(db, id) {
  const meal = sql(db, `SELECT ${MEAL_COLUMNS} FROM meals WHERE id = ?`).get(id);
  if (!meal) return null;
  const items = sql(db, `SELECT ${ITEM_COLUMNS} FROM meal_items WHERE meal_id = ? ORDER BY id`).all(id);
  return withItems(meal, items);
}

/** All meals on `date`, newest first, each with its items. */
export function listMeals(db, date) {
  const meals = sql(db, `SELECT ${MEAL_COLUMNS} FROM meals WHERE date = ? ORDER BY logged_at DESC, id DESC`).all(date);
  const items = sql(
    db,
    `SELECT ${ITEM_COLUMNS} FROM meal_items
     WHERE meal_id IN (SELECT id FROM meals WHERE date = ?) ORDER BY id`,
  ).all(date);
  const itemsByMeal = Map.groupBy(items, (item) => item.meal_id);
  return meals.map((meal) => withItems(meal, itemsByMeal.get(meal.id) ?? []));
}

const UPDATABLE = ['meal_name', 'total_calories', 'protein_g', 'carbs_g', 'fat_g', 'date'];

/** Applies the given fields and returns the updated meal, or null if it does not exist. */
export function updateMeal(db, id, fields) {
  const keys = UPDATABLE.filter((key) => key in fields);
  if (keys.length > 0) {
    const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
    const values = Object.fromEntries(keys.map((key) => [key, fields[key]]));
    const { changes } = sql(db, `UPDATE meals SET ${assignments} WHERE id = @id`).run({ ...values, id });
    if (changes === 0) return null;
  }
  return getMeal(db, id);
}

/** True if a meal was deleted. Its items go with it (ON DELETE CASCADE). */
export function deleteMeal(db, id) {
  return sql(db, 'DELETE FROM meals WHERE id = ?').run(id).changes > 0;
}

/** Calorie and macro totals for one date. */
export function dayTotals(db, date) {
  const row = sql(
    db,
    `SELECT COALESCE(SUM(total_calories), 0) AS calories,
            COALESCE(SUM(protein_g), 0) AS protein_g,
            COALESCE(SUM(carbs_g), 0) AS carbs_g,
            COALESCE(SUM(fat_g), 0) AS fat_g
     FROM meals WHERE date = ?`,
  ).get(date);
  const round1 = (value) => Math.round(value * 10) / 10;
  return {
    calories: row.calories,
    protein_g: round1(row.protein_g),
    carbs_g: round1(row.carbs_g),
    fat_g: round1(row.fat_g),
  };
}

/** Map of date -> total calories for the dates in [start, end] that have meals. */
export function caloriesByDate(db, start, end) {
  const rows = sql(
    db,
    'SELECT date, SUM(total_calories) AS calories FROM meals WHERE date BETWEEN ? AND ? GROUP BY date',
  ).all(start, end);
  return new Map(rows.map((row) => [row.date, row.calories]));
}

export function getDailyGoal(db) {
  const row = sql(db, "SELECT value FROM settings WHERE key = 'daily_goal'").get();
  const goal = Number(row?.value);
  return Number.isInteger(goal) ? goal : DEFAULT_DAILY_GOAL;
}

export function setDailyGoal(db, goal) {
  sql(db, "INSERT INTO settings (key, value) VALUES ('daily_goal', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(goal),
  );
  return goal;
}

function withItems(meal, items) {
  return { ...meal, items: items.map(({ meal_id, ...item }) => item) };
}
