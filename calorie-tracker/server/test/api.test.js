import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { localDate } from '../src/dates.js';
import { insertMeal, openDb } from '../src/db.js';
import { makeApp, silentLogger } from './helpers.js';

const addManual = (app, body) => request(app).post('/api/meals').send(body);

describe('GET /api/health', () => {
  it('reports configuration', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/health').expect(200);
    assert.deepEqual(res.body, { ok: true, gemini_configured: true, mock: false, auth_required: false });
  });

  it('reports a missing analyzer, mock mode and auth', async () => {
    const { app } = makeApp({ analyzer: null, config: { geminiMock: true, appToken: 'secret' } });
    const res = await request(app).get('/api/health').expect(200);
    assert.deepEqual(res.body, { ok: true, gemini_configured: false, mock: true, auth_required: true });
  });
});

describe('meals', () => {
  it('creates a manual meal and lists it with totals and goal', async () => {
    const { app } = makeApp();
    const created = await addManual(app, {
      meal_name: '  Banana ',
      total_calories: 105.4,
      protein_g: 1.3,
      carbs_g: '27',
      date: '2026-05-04',
    }).expect(201);

    const { meal } = created.body;
    assert.equal(meal.meal_name, 'Banana');
    assert.equal(meal.total_calories, 105);
    assert.equal(meal.carbs_g, 27);
    assert.equal(meal.fat_g, null);
    assert.equal(meal.source, 'manual');
    assert.equal(meal.date, '2026-05-04');
    assert.deepEqual(meal.items, []);
    assert.ok(!Number.isNaN(Date.parse(meal.logged_at)));
    assert.deepEqual(Object.keys(meal).sort(), [
      'carbs_g', 'confidence', 'date', 'fat_g', 'id', 'items', 'logged_at', 'meal_name', 'notes', 'protein_g', 'source', 'total_calories',
    ]);

    await addManual(app, { meal_name: 'Yogurt', total_calories: 150, protein_g: 8.25, fat_g: 4, date: '2026-05-04' }).expect(201);
    await addManual(app, { meal_name: 'Other day', total_calories: 999, date: '2026-05-05' }).expect(201);

    const res = await request(app).get('/api/meals?date=2026-05-04').expect(200);
    assert.equal(res.body.date, '2026-05-04');
    assert.deepEqual(res.body.meals.map((m) => m.meal_name), ['Yogurt', 'Banana']); // newest first
    assert.deepEqual(res.body.totals, { calories: 255, protein_g: 9.6, carbs_g: 27, fat_g: 4 });
    assert.equal(res.body.goal, 2000);
  });

  it("defaults to the server's local date", async () => {
    const { app } = makeApp();
    const created = await addManual(app, { meal_name: 'Tea', total_calories: 2 }).expect(201);
    assert.equal(created.body.meal.date, localDate());
    const res = await request(app).get('/api/meals').expect(200);
    assert.equal(res.body.date, localDate());
    assert.equal(res.body.meals.length, 1);
  });

  it('returns an empty day with zero totals', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/meals?date=2026-01-01').expect(200);
    assert.deepEqual(res.body, {
      date: '2026-01-01',
      meals: [],
      totals: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
      goal: 2000,
    });
  });

  it('includes scanned items on each meal', async () => {
    const { app, db } = makeApp();
    insertMeal(
      db,
      { date: '2026-05-04', meal_name: 'Lunch', total_calories: 300, source: 'scan', confidence: 'high' },
      [
        { name: 'Rice', portion: '1 cup', calories: 200, protein_g: 4, carbs_g: 44, fat_g: 0.4 },
        { name: 'Beans', portion: '1/2 cup', calories: 100 },
      ],
    );
    const res = await request(app).get('/api/meals?date=2026-05-04').expect(200);
    const [meal] = res.body.meals;
    assert.equal(meal.items.length, 2);
    assert.deepEqual(Object.keys(meal.items[0]).sort(), ['calories', 'carbs_g', 'fat_g', 'id', 'name', 'portion', 'protein_g']);
    assert.equal(meal.items[1].protein_g, null);
  });

  it('rejects invalid dates', async () => {
    const { app } = makeApp();
    for (const date of ['2026-02-30', 'yesterday', '2026-2-3']) {
      const res = await request(app).get('/api/meals').query({ date }).expect(400);
      assert.equal(res.body.error, 'invalid_date');
      assert.equal(typeof res.body.message, 'string');
    }
    const res = await addManual(app, { meal_name: 'X', total_calories: 1, date: '2026-04-31' }).expect(400);
    assert.equal(res.body.error, 'invalid_date');
  });

  it('validates manual entries', async () => {
    const { app } = makeApp();
    const bad = [
      {},
      { total_calories: 100 },
      { meal_name: '   ', total_calories: 100 },
      { meal_name: 'x'.repeat(121), total_calories: 100 },
      { meal_name: 'Soup' },
      { meal_name: 'Soup', total_calories: -5 },
      { meal_name: 'Soup', total_calories: 'lots' },
      { meal_name: 'Soup', total_calories: 100, protein_g: -1 },
      { meal_name: 'Soup', total_calories: 100, fat_g: 'abc' },
      [],
    ];
    for (const body of bad) {
      const res = await addManual(app, body).expect(400);
      assert.equal(res.body.error, 'validation_error', JSON.stringify(body));
    }
    const notJson = await request(app).post('/api/meals').type('json').send('{"meal_name":').expect(400);
    assert.equal(notJson.body.error, 'validation_error');
    const form = await request(app).post('/api/meals').type('form').send('meal_name=Soup').expect(400);
    assert.equal(form.body.error, 'validation_error');
  });

  it('updates a meal with PATCH', async () => {
    const { app } = makeApp();
    const { body } = await addManual(app, { meal_name: 'Oats', total_calories: 300, protein_g: 10, date: '2026-05-04' });
    const id = body.meal.id;

    const res = await request(app)
      .patch(`/api/meals/${id}`)
      .send({ meal_name: 'Overnight oats', total_calories: '350', protein_g: null, fat_g: 6.66, date: '2026-05-05' })
      .expect(200);
    assert.equal(res.body.meal.meal_name, 'Overnight oats');
    assert.equal(res.body.meal.total_calories, 350);
    assert.equal(res.body.meal.protein_g, null);
    assert.equal(res.body.meal.fat_g, 6.7);
    assert.equal(res.body.meal.date, '2026-05-05');
    assert.equal(res.body.meal.logged_at, body.meal.logged_at);

    const moved = await request(app).get('/api/meals?date=2026-05-05').expect(200);
    assert.equal(moved.body.meals[0].id, id);
  });

  it('rejects bad PATCH requests', async () => {
    const { app } = makeApp();
    const { body } = await addManual(app, { meal_name: 'Oats', total_calories: 300 });
    const id = body.meal.id;

    assert.equal((await request(app).patch('/api/meals/9999').send({ total_calories: 1 }).expect(404)).body.error, 'not_found');
    assert.equal((await request(app).patch('/api/meals/abc').send({ total_calories: 1 }).expect(404)).body.error, 'not_found');
    assert.equal((await request(app).patch(`/api/meals/${id}`).send({}).expect(400)).body.error, 'validation_error');
    assert.equal((await request(app).patch(`/api/meals/${id}`).send({ source: 'scan' }).expect(400)).body.error, 'validation_error');
    assert.equal((await request(app).patch(`/api/meals/${id}`).send({ meal_name: '' }).expect(400)).body.error, 'validation_error');
    assert.equal((await request(app).patch(`/api/meals/${id}`).send({ date: '2026-02-30' }).expect(400)).body.error, 'invalid_date');
    assert.equal((await request(app).patch(`/api/meals/${id}`).send({ date: null }).expect(400)).body.error, 'invalid_date');
  });

  it('deletes a meal and its items', async () => {
    const { app, db } = makeApp();
    const meal = insertMeal(db, { date: '2026-05-04', meal_name: 'Lunch', total_calories: 100, source: 'scan' }, [
      { name: 'Rice', calories: 100 },
    ]);
    await request(app).delete(`/api/meals/${meal.id}`).expect(204);
    await request(app).delete(`/api/meals/${meal.id}`).expect(404);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meal_items').get().n, 0);
  });
});

describe('GET /api/history', () => {
  it('zero-fills missing days, oldest first, across a month boundary', async () => {
    const { app } = makeApp();
    await addManual(app, { meal_name: 'A', total_calories: 500, date: '2026-02-27' });
    await addManual(app, { meal_name: 'B', total_calories: 700, date: '2026-03-02' });
    await addManual(app, { meal_name: 'C', total_calories: 300, date: '2026-03-02' });
    await addManual(app, { meal_name: 'Outside', total_calories: 999, date: '2026-03-03' });

    const res = await request(app).get('/api/history?end=2026-03-02&days=5').expect(200);
    assert.deepEqual(res.body, {
      goal: 2000,
      days: [
        { date: '2026-02-26', calories: 0 },
        { date: '2026-02-27', calories: 500 },
        { date: '2026-02-28', calories: 0 },
        { date: '2026-03-01', calories: 0 },
        { date: '2026-03-02', calories: 1000 },
      ],
    });
  });

  it('defaults to the last 7 days ending today', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/history').expect(200);
    assert.equal(res.body.days.length, 7);
    assert.equal(res.body.days.at(-1).date, localDate());
    assert.ok(res.body.days.every((day) => day.calories === 0));
  });

  it('accepts 1..90 days and rejects anything else', async () => {
    const { app } = makeApp();
    assert.equal((await request(app).get('/api/history?end=2026-01-10&days=90').expect(200)).body.days.length, 90);
    assert.equal((await request(app).get('/api/history?end=2026-01-10&days=1').expect(200)).body.days.length, 1);
    for (const days of ['0', '91', '2.5', 'abc', '']) {
      const res = await request(app).get('/api/history').query({ end: '2026-01-10', days }).expect(400);
      assert.equal(res.body.error, 'validation_error', days);
    }
    assert.equal((await request(app).get('/api/history?end=2026-02-30').expect(400)).body.error, 'invalid_date');
  });
});

describe('settings', () => {
  it('reads and updates the daily goal', async () => {
    const { app } = makeApp();
    assert.deepEqual((await request(app).get('/api/settings').expect(200)).body, { daily_goal: 2000 });
    assert.deepEqual((await request(app).put('/api/settings').send({ daily_goal: 1800 }).expect(200)).body, { daily_goal: 1800 });
    assert.deepEqual((await request(app).get('/api/settings').expect(200)).body, { daily_goal: 1800 });
    assert.equal((await request(app).get('/api/meals?date=2026-01-01')).body.goal, 1800);
    assert.equal((await request(app).get('/api/history')).body.goal, 1800);
  });

  it('validates the goal', async () => {
    const { app } = makeApp();
    for (const daily_goal of [499, 10001, 1800.5, 'abc', null, undefined, true]) {
      const res = await request(app).put('/api/settings').send({ daily_goal }).expect(400);
      assert.equal(res.body.error, 'validation_error', String(daily_goal));
    }
    assert.deepEqual((await request(app).put('/api/settings').send({ daily_goal: '2500' }).expect(200)).body, { daily_goal: 2500 });
  });
});

describe('APP_TOKEN auth', () => {
  const config = { appToken: 'open-sesame' };

  it('requires x-app-token on every /api route except /api/health', async () => {
    const { app } = makeApp({ config });
    await request(app).get('/api/health').expect(200);
    for (const [method, url] of [
      ['get', '/api/meals'],
      ['post', '/api/meals'],
      ['patch', '/api/meals/1'],
      ['delete', '/api/meals/1'],
      ['get', '/api/history'],
      ['get', '/api/settings'],
      ['put', '/api/settings'],
      ['post', '/api/scan'],
      ['get', '/api/nope'],
    ]) {
      const res = await request(app)[method](url).expect(401);
      assert.equal(res.body.error, 'unauthorized', `${method} ${url}`);
    }
    const wrong = await request(app).get('/api/meals').set('x-app-token', 'open-sesame!').expect(401);
    assert.equal(wrong.body.error, 'unauthorized');
  });

  it('accepts the right token', async () => {
    const { app } = makeApp({ config });
    await request(app).get('/api/settings').set('x-app-token', 'open-sesame').expect(200);
    await request(app)
      .post('/api/meals')
      .set('x-app-token', 'open-sesame')
      .send({ meal_name: 'Soup', total_calories: 200 })
      .expect(201);
  });

  it('is off when APP_TOKEN is not set', async () => {
    const { app } = makeApp();
    await request(app).get('/api/settings').expect(200);
  });
});

describe('routing', () => {
  it('returns JSON 404s for unknown /api routes', async () => {
    const { app } = makeApp();
    for (const url of ['/api/nope', '/api', '/api/meals/1/extra']) {
      const res = await request(app).get(url).expect(404).expect('Content-Type', /json/);
      assert.equal(res.body.error, 'not_found', url);
      assert.equal(typeof res.body.message, 'string');
    }
    await request(app).put('/api/meals').send({}).expect(404);
  });

  it('never leaks stack traces', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, analyzer: null, config: {}, logger: silentLogger });
    db.close(); // every query now throws
    const res = await request(app).get('/api/settings').expect(500);
    assert.deepEqual(Object.keys(res.body).sort(), ['error', 'message']);
    assert.equal(res.body.error, 'internal_error');
    assert.doesNotMatch(JSON.stringify(res.body), /at \w|\.js:/);
  });

  describe('serving the client build', () => {
    let tmpDir;
    let app;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-client-'));
      // Awkward parent folders (one named "assets", one starting with a dot) must not matter.
      const clientDir = path.join(tmpDir, 'assets', '.checkout', 'dist');
      fs.mkdirSync(path.join(clientDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Snap Calories</title>');
      fs.writeFileSync(path.join(clientDir, 'assets', 'app-abc123.js'), 'console.log(1)');
      ({ app } = makeApp({ config: { clientDir } }));
    });

    after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it('serves static files and falls back to index.html for client routes', async () => {
      const asset = await request(app).get('/assets/app-abc123.js').expect(200);
      assert.match(asset.headers['cache-control'], /immutable/);
      const home = await request(app).get('/').expect(200).expect('Content-Type', /html/);
      assert.match(home.text, /Snap Calories/);
      assert.doesNotMatch(home.headers['cache-control'], /immutable/);
      const deep = await request(app).get('/history/week').set('Accept', 'text/html').expect(200);
      assert.match(deep.text, /Snap Calories/);
      assert.equal(deep.headers['cache-control'], 'no-cache');
    });

    it('never swallows /api', async () => {
      const res = await request(app).get('/api/unknown').set('Accept', 'text/html').expect(404);
      assert.equal(res.body.error, 'not_found');
      await request(app).get('/api/health').expect(200).expect('Content-Type', /json/);
    });
  });

  it('explains how to get the client when there is no build', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/').expect(404);
    assert.match(res.text, /npm run build/);
  });

  it('serves a build made after the server started', async () => {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-client-'));
    try {
      const { app } = makeApp({ config: { clientDir } });
      assert.match((await request(app).get('/').expect(404)).text, /npm run build/);

      fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Snap Calories</title>');
      assert.match((await request(app).get('/').expect(200)).text, /Snap Calories/);
      await request(app).get('/history').set('Accept', 'text/html').expect(200);
    } finally {
      fs.rmSync(clientDir, { recursive: true, force: true });
    }
  });
});
