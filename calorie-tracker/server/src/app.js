import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import * as store from './db.js';
import { dateRange, isValidDate, localDate } from './dates.js';
import { HttpError } from './errors.js';
import { sniffImageType, uploadMimeType } from './image.js';
import { normalizeAnalysis } from './nutrition.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_HINT_LENGTH = 300;
const MAX_MEAL_NAME = 120;
const MACROS = ['protein_g', 'carbs_g', 'fat_g'];

/**
 * Builds the Express app without listening.
 *
 * - db: handle from openDb()
 * - analyzer: { analyze(buffer, mimeType, hint) } or null when Gemini is not configured
 * - config: loadConfig() output; `clientDir` (optional) is where the client build is (or will be)
 * - logger: defaults to console
 */
export function createApp({ db, analyzer = null, config = {}, logger = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.use('/api', createApiRouter({ db, analyzer, config }));

  // Checked per request, so a build made while the server runs is served without a restart.
  const hasBuild = () => Boolean(config.clientDir) && fs.existsSync(path.join(config.clientDir, 'index.html'));

  if (config.clientDir) {
    app.use(
      express.static(config.clientDir, {
        setHeaders(res, file) {
          // Vite fingerprints everything in assets/, so it can be cached forever.
          if (path.relative(config.clientDir, file).split(path.sep)[0] === 'assets') {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // SPA fallback. The /api router answers every /api request itself, so this
    // only ever sees client-side routes.
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.accepts('html') || !hasBuild()) return next();
      res.setHeader('Cache-Control', 'no-cache');
      // With a root, only the relative path is checked for dotfiles, not the parent folders.
      res.sendFile('index.html', { root: config.clientDir });
    });
  }

  app.use((req, res) => {
    res
      .status(404)
      .type('text/plain')
      .send(
        hasBuild()
          ? 'Not found'
          : 'Snap Calories API is running. Build the client with "npm run build" to serve the app from this port.',
      );
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const { status, code, message } = describeError(err);
    if (status >= 500) {
      logger.error(`${req.method} ${req.originalUrl} -> ${status} ${code}`, err instanceof HttpError ? message : err);
    }
    res.status(status).json({ error: code, message });
  });

  return app;
}

function createApiRouter({ db, analyzer, config }) {
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));

  api.get('/health', (req, res) => {
    res.json({
      ok: true,
      gemini_configured: analyzer !== null,
      mock: Boolean(config.geminiMock),
      auth_required: Boolean(config.appToken),
    });
  });

  api.use(requireToken(config.appToken));

  api.post('/scan', requireAnalyzer(analyzer), uploadImage, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'no_image', 'Attach a photo in the "image" field.');
    const date = optionalDate(req.body.date);
    const hint = typeof req.body.hint === 'string' ? req.body.hint.trim().slice(0, MAX_HINT_LENGTH) : '';

    // Trust the bytes over the client's declared type.
    const mimeType = sniffImageType(req.file.buffer);
    if (!mimeType) {
      throw new HttpError(400, 'bad_image_type', 'That file is not a readable JPEG, PNG, WebP or HEIC image.');
    }

    // If the user cancels while Gemini is working, the connection drops. Logging
    // the meal anyway would add calories they never saw, and a retry would log it twice.
    let clientGone = false;
    res.once('close', () => {
      clientGone = !res.writableFinished;
    });

    let raw;
    try {
      raw = await analyzer.analyze(req.file.buffer, mimeType, hint);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'analysis_failed', 'Could not analyze the photo. Please try again.', { cause: err });
    }
    if (clientGone) return;

    const analysis = normalizeAnalysis(raw);
    if (!analysis.is_food) {
      throw new HttpError(422, 'no_food_detected', analysis.notes ?? 'No food or drink was found in this photo.');
    }

    const meal = store.insertMeal(
      db,
      {
        date,
        meal_name: analysis.meal_name,
        total_calories: analysis.total_calories,
        protein_g: analysis.protein_g,
        carbs_g: analysis.carbs_g,
        fat_g: analysis.fat_g,
        confidence: analysis.confidence,
        notes: analysis.notes,
        source: 'scan',
      },
      analysis.items,
    );
    res.status(201).json({ meal });
  });

  api.get('/meals', (req, res) => {
    const date = optionalDate(req.query.date);
    res.json({
      date,
      meals: store.listMeals(db, date),
      totals: store.dayTotals(db, date),
      goal: store.getDailyGoal(db),
    });
  });

  api.post('/meals', (req, res) => {
    const body = requireObject(req.body);
    const fields = parseMealFields(body, { partial: false });
    const meal = store.insertMeal(db, {
      ...fields,
      date: optionalDate(body.date),
      source: 'manual',
    });
    res.status(201).json({ meal });
  });

  api.patch('/meals/:id', (req, res) => {
    const id = mealId(req.params.id);
    const body = requireObject(req.body);
    const fields = parseMealFields(body, { partial: true });
    if ('date' in body) fields.date = requireDate(body.date);
    if (Object.keys(fields).length === 0) {
      throw validationError('Nothing to update. Send any of meal_name, total_calories, protein_g, carbs_g, fat_g, date.');
    }
    const meal = store.updateMeal(db, id, fields);
    if (!meal) throw notFound();
    res.json({ meal });
  });

  api.delete('/meals/:id', (req, res) => {
    if (!store.deleteMeal(db, mealId(req.params.id))) throw notFound();
    res.status(204).end();
  });

  api.get('/history', (req, res) => {
    const end = optionalDate(req.query.end);
    const days = req.query.days === undefined ? 7 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw validationError('days must be a whole number from 1 to 90.');
    }
    const dates = dateRange(end, days);
    const calories = store.caloriesByDate(db, dates[0], end);
    res.json({
      goal: store.getDailyGoal(db),
      days: dates.map((date) => ({ date, calories: calories.get(date) ?? 0 })),
    });
  });

  api.get('/settings', (req, res) => {
    res.json({ daily_goal: store.getDailyGoal(db) });
  });

  api.put('/settings', (req, res) => {
    const goal = toNumber(requireObject(req.body).daily_goal);
    if (!Number.isInteger(goal) || goal < 500 || goal > 10000) {
      throw validationError('daily_goal must be a whole number from 500 to 10000.');
    }
    res.json({ daily_goal: store.setDailyGoal(db, goal) });
  });

  api.use((req, res) => {
    throw new HttpError(404, 'not_found', `No API route for ${req.method} ${req.baseUrl}${req.path}.`);
  });

  return api;
}

// --- middleware ---------------------------------------------------------------

function requireToken(token) {
  if (!token) return (req, res, next) => next();
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  const expected = digest(token);
  return (req, res, next) => {
    const given = req.get('x-app-token');
    // Compare fixed-length digests so the check takes constant time.
    if (given && crypto.timingSafeEqual(digest(given), expected)) return next();
    next(new HttpError(401, 'unauthorized', 'Missing or wrong passcode.'));
  };
}

function requireAnalyzer(analyzer) {
  return (req, res, next) => {
    if (analyzer) return next();
    next(
      new HttpError(
        503,
        'gemini_not_configured',
        'Photo scanning is not set up. Add GEMINI_API_KEY to server/.env and restart the server.',
      ),
    );
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10 },
  fileFilter(req, file, cb) {
    if (uploadMimeType(file)) return cb(null, true);
    cb(new HttpError(400, 'bad_image_type', 'Unsupported image type. Use a JPEG, PNG, WebP or HEIC photo.'));
  },
});

function uploadImage(req, res, next) {
  upload.single('image')(req, res, (err) => next(err && uploadError(err)));
}

function uploadError(err) {
  if (err instanceof HttpError) return err;
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return new HttpError(413, 'image_too_large', 'The photo is larger than 15 MB.');
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return new HttpError(400, 'no_image', 'Send exactly one photo, in the "image" field.');
    }
  }
  return new HttpError(400, 'validation_error', 'Could not read the upload. Please try again.', { cause: err });
}

// --- validation ---------------------------------------------------------------

function parseMealFields(body, { partial }) {
  const fields = {};

  if (!partial || 'meal_name' in body) {
    const name = typeof body.meal_name === 'string' ? body.meal_name.trim() : '';
    if (!name || name.length > MAX_MEAL_NAME) {
      throw validationError(`meal_name is required (1-${MAX_MEAL_NAME} characters).`);
    }
    fields.meal_name = name;
  }

  if (!partial || 'total_calories' in body) {
    const kcal = toNumber(body.total_calories);
    if (kcal === null || kcal < 0 || kcal > 50000) {
      throw validationError('total_calories must be a number from 0 to 50000.');
    }
    fields.total_calories = Math.round(kcal);
  }

  for (const key of MACROS) {
    if (!(key in body)) continue;
    if (body[key] === null || body[key] === '') {
      fields[key] = null;
      continue;
    }
    const value = toNumber(body[key]);
    if (value === null || value < 0 || value > 5000) {
      throw validationError(`${key} must be a number from 0 to 5000, or null.`);
    }
    fields[key] = Math.round(value * 10) / 10;
  }

  return fields;
}

/** A number from a JSON number or a numeric string; otherwise null. */
function toNumber(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function requireObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('Send a JSON object with Content-Type: application/json.');
  }
  return body;
}

function requireDate(value) {
  if (!isValidDate(value)) {
    throw new HttpError(400, 'invalid_date', 'Dates must be real calendar dates in YYYY-MM-DD format.');
  }
  return value;
}

/** The given date, or the server's local today when it is missing. */
function optionalDate(value) {
  return value === undefined || value === null || value === '' ? localDate() : requireDate(value);
}

function mealId(param) {
  if (!/^[1-9]\d{0,15}$/.test(param)) throw notFound();
  return Number(param);
}

const validationError = (message) => new HttpError(400, 'validation_error', message);
const notFound = () => new HttpError(404, 'not_found', 'Meal not found.');

/** Maps any error to { status, code, message } without leaking internals. */
function describeError(err) {
  if (err instanceof HttpError) return err;
  if (err?.type === 'entity.parse.failed') {
    return { status: 400, code: 'validation_error', message: 'Request body is not valid JSON.' };
  }
  if (err?.type === 'entity.too.large') {
    return { status: 413, code: 'payload_too_large', message: 'Request body is too large.' };
  }
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
    return { status: err.status, code: 'bad_request', message: 'The request could not be processed.' };
  }
  return { status: 500, code: 'internal_error', message: 'Something went wrong on the server.' };
}
