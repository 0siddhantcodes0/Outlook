import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import request from 'supertest';
import { MAX_IMAGE_BYTES } from '../src/app.js';
import { localDate } from '../src/dates.js';
import { HttpError } from '../src/errors.js';
import { sniffImageType, uploadMimeType } from '../src/image.js';
import { JPEG_HEADER, PNG_1X1, SAMPLE_ANALYSIS, fakeAnalyzer, makeApp } from './helpers.js';

const scan = (app) => request(app).post('/api/scan');
const attachPng = (req, options = { filename: 'meal.png', contentType: 'image/png' }) =>
  req.attach('image', PNG_1X1, options);

const countMeals = (db) => db.prepare('SELECT COUNT(*) AS n FROM meals').get().n;

describe('POST /api/scan', () => {
  it('analyzes the photo and saves the meal (201)', async () => {
    const analyzer = fakeAnalyzer();
    const { app, db } = makeApp({ analyzer });

    const res = await attachPng(scan(app).field('date', '2026-05-04').field('hint', '  2 eggs, not 3 ')).expect(201);

    const { meal } = res.body;
    assert.equal(meal.source, 'scan');
    assert.equal(meal.date, '2026-05-04');
    assert.equal(meal.meal_name, 'Toast and eggs');
    assert.equal(meal.total_calories, 310);
    assert.equal(meal.protein_g, 15.7);
    assert.equal(meal.confidence, 'high');
    assert.equal(meal.notes, 'Assumed one pat of butter.');
    assert.deepEqual(
      meal.items.map(({ id, ...item }) => item),
      SAMPLE_ANALYSIS.items,
    );
    assert.ok(meal.items.every((item) => Number.isInteger(item.id)));

    // The analyzer got the bytes, the sniffed type and the trimmed hint.
    assert.equal(analyzer.calls.length, 1);
    assert.ok(analyzer.calls[0].buffer.equals(PNG_1X1));
    assert.equal(analyzer.calls[0].mimeType, 'image/png');
    assert.equal(analyzer.calls[0].hint, '2 eggs, not 3');

    // It is really in the DB and shows up in the day's list.
    const day = await request(app).get('/api/meals?date=2026-05-04').expect(200);
    assert.equal(day.body.meals[0].id, meal.id);
    assert.equal(day.body.totals.calories, 310);
    assert.equal(countMeals(db), 1);
  });

  it("defaults to the server's local date and caps the hint at 300 chars", async () => {
    const analyzer = fakeAnalyzer();
    const { app } = makeApp({ analyzer });
    const res = await attachPng(scan(app).field('hint', 'x'.repeat(500))).expect(201);
    assert.equal(res.body.meal.date, localDate());
    assert.equal(analyzer.calls[0].hint.length, 300);
  });

  it('normalizes the raw model output (fenced JSON, wrong total)', async () => {
    const raw = '```json\n' + JSON.stringify({ ...SAMPLE_ANALYSIS, total_calories: 5000, confidence: 'meh' }) + '\n```';
    const { app } = makeApp({ analyzer: fakeAnalyzer(raw) });
    const res = await attachPng(scan(app)).expect(201);
    assert.equal(res.body.meal.total_calories, 310);
    assert.equal(res.body.meal.confidence, 'medium');
  });

  it('returns 422 and saves nothing when there is no food', async () => {
    const { app, db } = makeApp({
      analyzer: fakeAnalyzer({ is_food: false, meal_name: '', items: [], total_calories: 0, confidence: 'high', notes: 'That is a cat.' }),
    });
    const res = await attachPng(scan(app)).expect(422);
    assert.deepEqual(res.body, { error: 'no_food_detected', message: 'That is a cat.' });
    assert.equal(countMeals(db), 0);
  });

  it('returns 429 when the analyzer is rate limited', async () => {
    const { app, db } = makeApp({ analyzer: fakeAnalyzer(new HttpError(429, 'rate_limited', 'Slow down.')) });
    const res = await attachPng(scan(app)).expect(429);
    assert.deepEqual(res.body, { error: 'rate_limited', message: 'Slow down.' });
    assert.equal(countMeals(db), 0);
  });

  it('returns 502 when the analyzer fails or returns garbage', async () => {
    const secret = new Error('boom with key AIzaSy-secret');
    const failing = makeApp({ analyzer: fakeAnalyzer(secret) });
    const res = await attachPng(scan(failing.app)).expect(502);
    assert.equal(res.body.error, 'analysis_failed');
    assert.doesNotMatch(JSON.stringify(res.body), /AIzaSy|boom/);

    const garbage = makeApp({ analyzer: fakeAnalyzer('Sorry, I cannot help with that.') });
    assert.equal((await attachPng(scan(garbage.app)).expect(502)).body.error, 'analysis_failed');
    assert.equal(countMeals(garbage.db), 0);

    const blank = makeApp({
      analyzer: fakeAnalyzer({ is_food: true, meal_name: '', items: [], total_calories: 0, confidence: 'low', notes: '' }),
    });
    assert.equal((await attachPng(scan(blank.app)).expect(502)).body.error, 'analysis_failed');
    assert.equal(countMeals(blank.db), 0);
  });

  it('saves nothing when the client disconnects during the analysis', async () => {
    let analysisStarted;
    const started = new Promise((resolve) => (analysisStarted = resolve));
    let finishAnalysis;
    const analyzer = {
      analyze() {
        analysisStarted();
        return new Promise((resolve) => (finishAnalysis = () => resolve(SAMPLE_ANALYSIS)));
      },
    };
    const { app, db } = makeApp({ analyzer });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let socketClosed;
    server.once('connection', (socket) => (socketClosed = once(socket, 'close')));

    try {
      const form = new FormData();
      form.append('image', new Blob([PNG_1X1], { type: 'image/png' }), 'meal.png');
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${server.address().port}/api/scan`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });

      await started;
      controller.abort(); // the user taps Cancel
      await assert.rejects(response, { name: 'AbortError' });
      await socketClosed;

      finishAnalysis();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(countMeals(db), 0);
    } finally {
      server.close();
    }
  });

  it('returns 503 when Gemini is not configured', async () => {
    const { app } = makeApp({ analyzer: null });
    const res = await attachPng(scan(app)).expect(503);
    assert.equal(res.body.error, 'gemini_not_configured');
  });

  it('rejects a missing image', async () => {
    const { app } = makeApp();
    assert.equal((await scan(app).field('date', '2026-05-04').expect(400)).body.error, 'no_image');
    assert.equal((await scan(app).send({}).expect(400)).body.error, 'no_image');
    // A file in the wrong field.
    const wrongField = await scan(app).attach('photo', PNG_1X1, 'meal.png').expect(400);
    assert.equal(wrongField.body.error, 'no_image');
  });

  it('rejects unsupported image types', async () => {
    const analyzer = fakeAnalyzer();
    const { app } = makeApp({ analyzer });
    const gif = await scan(app)
      .attach('image', Buffer.from('GIF89a........'), { filename: 'a.gif', contentType: 'image/gif' })
      .expect(400);
    assert.equal(gif.body.error, 'bad_image_type');

    const text = await scan(app)
      .attach('image', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' })
      .expect(400);
    assert.equal(text.body.error, 'bad_image_type');

    // Declared as PNG but the bytes are not an image.
    const fake = await scan(app)
      .attach('image', Buffer.from('definitely not a png file'), { filename: 'a.png', contentType: 'image/png' })
      .expect(400);
    assert.equal(fake.body.error, 'bad_image_type');
    assert.equal(analyzer.calls.length, 0);
  });

  it('rejects an invalid date without calling the analyzer', async () => {
    const analyzer = fakeAnalyzer();
    const { app } = makeApp({ analyzer });
    const res = await attachPng(scan(app).field('date', '2026-02-30')).expect(400);
    assert.equal(res.body.error, 'invalid_date');
    assert.equal(analyzer.calls.length, 0);
  });

  it('returns 413 for images over 15 MB', async () => {
    const analyzer = fakeAnalyzer();
    const { app } = makeApp({ analyzer });
    const big = Buffer.concat([JPEG_HEADER, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const res = await scan(app).attach('image', big, { filename: 'big.jpg', contentType: 'image/jpeg' }).expect(413);
    assert.equal(res.body.error, 'image_too_large');
    assert.equal(analyzer.calls.length, 0);
  });

  it('accepts an image right at the limit', async () => {
    const { app } = makeApp();
    const atLimit = Buffer.concat([JPEG_HEADER, Buffer.alloc(MAX_IMAGE_BYTES - JPEG_HEADER.length)]);
    await scan(app).attach('image', atLimit, { filename: 'ok.jpg', contentType: 'image/jpeg' }).expect(201);
  });

  it('accepts HEIC sent as application/octet-stream', async () => {
    const analyzer = fakeAnalyzer();
    const { app } = makeApp({ analyzer });
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
    await scan(app)
      .attach('image', heic, { filename: 'IMG_0001.HEIC', contentType: 'application/octet-stream' })
      .expect(201);
    assert.equal(analyzer.calls[0].mimeType, 'image/heic');
  });
});

describe('image type helpers', () => {
  it('maps declared types and extensions', () => {
    assert.equal(uploadMimeType({ mimetype: 'image/jpeg', originalname: 'a.jpg' }), 'image/jpeg');
    assert.equal(uploadMimeType({ mimetype: 'image/jpg', originalname: 'a.jpg' }), 'image/jpeg');
    assert.equal(uploadMimeType({ mimetype: 'IMAGE/WEBP', originalname: 'a' }), 'image/webp');
    assert.equal(uploadMimeType({ mimetype: 'image/heif', originalname: 'a' }), 'image/heif');
    assert.equal(uploadMimeType({ mimetype: 'application/octet-stream', originalname: 'a.heic' }), 'image/heic');
    assert.equal(uploadMimeType({ mimetype: 'application/octet-stream', originalname: 'a.exe' }), null);
    assert.equal(uploadMimeType({ mimetype: 'image/gif', originalname: 'a.png' }), null);
  });

  it('sniffs magic bytes', () => {
    assert.equal(sniffImageType(PNG_1X1), 'image/png');
    assert.equal(sniffImageType(JPEG_HEADER), 'image/jpeg');
    assert.equal(sniffImageType(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.alloc(8)])), 'image/webp');
    assert.equal(sniffImageType(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypmif1'), Buffer.alloc(8)])), 'image/heif');
    assert.equal(sniffImageType(Buffer.from('GIF89a......')), null);
    assert.equal(sniffImageType(Buffer.alloc(3)), null);
  });
});
