import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getDailyGoal, insertMeal, listMeals, openDb, setDailyGoal, updateMeal } from '../src/db.js';

describe('db', () => {
  it('creates the file and its folder, with WAL and foreign keys on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-db-'));
    try {
      const file = path.join(dir, 'nested', 'calories.db');
      const db = openDb(file);
      assert.ok(fs.existsSync(file));
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
      setDailyGoal(db, 2200);
      db.close();

      // Reopening keeps data and does not reset the goal.
      const again = openDb(file);
      assert.equal(getDailyGoal(again), 2200);
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inserts a meal and its items atomically', () => {
    const db = openDb(':memory:');
    assert.throws(() =>
      insertMeal(db, { date: '2026-05-04', meal_name: 'Broken', total_calories: 100, source: 'scan' }, [
        { name: 'Fine', calories: 50 },
        { name: null, calories: 50 }, // violates NOT NULL
      ]),
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meals').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meal_items').get().n, 0);
  });

  it('keeps items with their own meal', () => {
    const db = openDb(':memory:');
    insertMeal(db, { date: '2026-05-04', meal_name: 'A', total_calories: 1, source: 'scan' }, [{ name: 'a1', calories: 1 }]);
    insertMeal(db, { date: '2026-05-04', meal_name: 'B', total_calories: 2, source: 'scan' }, [
      { name: 'b1', calories: 1 },
      { name: 'b2', calories: 1 },
    ]);
    const meals = listMeals(db, '2026-05-04');
    assert.deepEqual(
      meals.map((meal) => [meal.meal_name, meal.items.map((item) => item.name)]),
      [
        ['B', ['b1', 'b2']],
        ['A', ['a1']],
      ],
    );
  });

  it('returns null when updating a missing meal', () => {
    const db = openDb(':memory:');
    assert.equal(updateMeal(db, 42, { total_calories: 5 }), null);
  });
});
