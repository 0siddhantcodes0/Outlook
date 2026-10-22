import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

/** A 1x1 transparent PNG. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Minimal JPEG header bytes: enough for type sniffing. */
export const JPEG_HEADER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);

export const silentLogger = { log() {}, warn() {}, error() {} };

export const SAMPLE_ANALYSIS = {
  is_food: true,
  meal_name: 'Toast and eggs',
  items: [
    { name: 'Fried egg', portion: '2 large', calories: 180, protein_g: 12.6, carbs_g: 0.8, fat_g: 14 },
    { name: 'Buttered toast', portion: '1 slice', calories: 130, protein_g: 3.1, carbs_g: 13.5, fat_g: 6.9 },
  ],
  total_calories: 310,
  confidence: 'high',
  notes: 'Assumed one pat of butter.',
};

/** A fake analyzer that records its calls and returns (or throws) what it is told. */
export function fakeAnalyzer(result = SAMPLE_ANALYSIS) {
  const calls = [];
  return {
    calls,
    async analyze(buffer, mimeType, hint) {
      calls.push({ buffer, mimeType, hint });
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result() : result;
    },
  };
}

/** A fresh app on an in-memory database. */
export function makeApp({ analyzer = fakeAnalyzer(), config = {} } = {}) {
  const db = openDb(':memory:');
  const app = createApp({ db, analyzer, config, logger: silentLogger });
  return { app, db, analyzer };
}
