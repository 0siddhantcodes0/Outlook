# Snap Calories: build contract

This file is the shared spec for the server and the client. Both sides must
match it exactly.

## Layout

```
calorie-tracker/
  package.json          root scripts (setup, dev, build, start, test)
  README.md             setup + phone instructions
  .gitignore
  server/               Node 22+, Express 5, ESM ("type": "module")
    package.json
    .env.example
    src/index.js        loads .env, opens DB, starts listening, prints LAN URLs
    src/app.js          createApp({ db, analyzer, config }) -> express app (no listen)
    src/db.js           openDb(path) -> better-sqlite3 handle with schema applied; query helpers
    src/gemini.js       createGeminiAnalyzer(config) -> { analyze(buffer, mimeType, hint) }
    src/nutrition.js    normalizeAnalysis(raw) -> clean, validated object (pure, unit-tested)
    test/*.test.js      node:test + supertest; Gemini is always faked in tests
    data/               SQLite file lives here (gitignored)
  client/               Vite + React 19, plain CSS, mobile-first
    package.json
    index.html
    vite.config.js      dev proxy /api -> http://localhost:3001, server.host = true
    public/manifest.webmanifest, public/icon.svg (+ apple-touch-icon png if feasible)
    src/...
```

The production build of the client goes to `client/dist`. In production
Express serves `client/dist` statically, with an SPA fallback for non-/api
GET routes, so one port (3001) serves everything.

## Config (server/.env)

| var | default | meaning |
|---|---|---|
| GEMINI_API_KEY | (none) | Google AI Studio key. If missing, /api/scan returns 503 `gemini_not_configured` |
| GEMINI_MODEL | `gemini-3.8-flash,gemini-3.6-flash,gemini-2.5-flash` | comma-separated list; try in order and fall through to the next ONLY on a model-not-found (404 / NOT_FOUND) error |
| PORT | 3001 | |
| HOST | 0.0.0.0 | so a phone on the same Wi-Fi can reach it |
| DB_PATH | `server/data/calories.db` (resolve relative to the server dir, not cwd) | |
| APP_TOKEN | (none) | optional shared passcode. If set, every /api route except /api/health requires header `x-app-token: <APP_TOKEN>`; otherwise 401 `{error:"unauthorized"}` |
| GEMINI_MOCK | (none) | if `1`, use a built-in fake analyzer that returns a fixed realistic meal (for demo/testing without a key) |

## Data model (SQLite via better-sqlite3, WAL mode, foreign_keys ON)

```
meals(id INTEGER PK, date TEXT NOT NULL /* YYYY-MM-DD in the user's local time */,
      logged_at TEXT NOT NULL /* ISO-8601 UTC */, meal_name TEXT NOT NULL,
      total_calories INTEGER NOT NULL, protein_g REAL, carbs_g REAL, fat_g REAL,
      confidence TEXT /* low|medium|high|null */, notes TEXT, source TEXT NOT NULL /* 'scan'|'manual' */)
meal_items(id INTEGER PK, meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
      name TEXT NOT NULL, portion TEXT, calories INTEGER NOT NULL, protein_g REAL, carbs_g REAL, fat_g REAL)
settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)   -- daily_goal default 2000
index on meals(date)
```

Images are NOT stored. They are analyzed in memory and thrown away.

## Gemini

- Use the official `@google/genai` SDK (`new GoogleGenAI({ apiKey })`,
  `ai.models.generateContent`). Send the image inline as base64 with its mime
  type and a text prompt. Ask for JSON through the SDK's structured output
  config (`responseMimeType: 'application/json'` plus a response schema).
  CHECK the exact config field names against the INSTALLED SDK's `.d.ts`
  files in node_modules, because the docs site can't be reached from this
  machine. Use low temperature.
- The model must return this shape (the response schema):
  ```
  { is_food: boolean,
    meal_name: string,
    items: [{ name: string, portion: string, calories: number, protein_g: number, carbs_g: number, fat_g: number }],
    total_calories: number,
    confidence: "low" | "medium" | "high",
    notes: string }
  ```
- The prompt tells the model to: identify every distinct food or drink,
  estimate realistic portion sizes from visual cues (plate size, utensils,
  packaging), read nutrition labels when visible and prefer them, use
  standard nutrition references, count cooking oils and sauces, give whole
  numbers for kcal, and set `is_food=false` with empty items if no
  food/drink is visible. Any user hint text is included as extra context and
  may override the visual guess (e.g. "2 slices", "no sugar").
- `normalizeAnalysis` is defensive. It accepts the parsed object, a JSON
  string, or a string wrapped in ```json fences. It coerces numbers, clamps
  negatives to 0, rounds kcal to integers and macros to 1 decimal, trims
  strings, and drops items with no name. It recomputes `total_calories` as
  the sum of item calories whenever there are items (the per-item numbers
  win). Meal macros are the sums of item macros. `confidence` falls back to
  "medium". It throws a typed error if the result is unusable.

## HTTP API (all JSON; dates are `YYYY-MM-DD`; invalid date -> 400)

Meal object returned everywhere:
```
{ id, date, logged_at, meal_name, total_calories, protein_g, carbs_g, fat_g,
  confidence, notes, source, items: [{ id, name, portion, calories, protein_g, carbs_g, fat_g }] }
```

| method + path | body / query | success | errors |
|---|---|---|---|
| GET /api/health | | `{ ok:true, gemini_configured:bool, mock:bool, auth_required:bool }` | |
| POST /api/scan | multipart/form-data: `image` (file, required, jpeg/png/webp/heic/heif, max 15 MB), `date` (optional, defaults to the server's local date), `hint` (optional text, max 300 chars) | **201** `{ meal }`, already saved to the DB | 400 `no_image` / `bad_image_type` / `invalid_date`; 413 `image_too_large`; 422 `no_food_detected` (NOT saved; include `message` from model notes); 429 `rate_limited`; 502 `analysis_failed`; 503 `gemini_not_configured` |
| GET /api/meals?date= | date defaults to the server's local today | `{ date, meals:[meal...] (newest first), totals:{ calories, protein_g, carbs_g, fat_g }, goal }` | |
| POST /api/meals | `{ meal_name, total_calories, protein_g?, carbs_g?, fat_g?, date? }` manual entry | 201 `{ meal }` (source 'manual', items []) | 400 `validation_error` |
| PATCH /api/meals/:id | any of `meal_name, total_calories, protein_g, carbs_g, fat_g, date` | `{ meal }` | 404 `not_found`, 400 |
| DELETE /api/meals/:id | | 204 | 404 |
| GET /api/history?end=&days=7 | days 1..90, end defaults to today | `{ goal, days:[{ date, calories }] }` oldest -> newest, zero-filled | |
| GET /api/settings | | `{ daily_goal }` | |
| PUT /api/settings | `{ daily_goal }` int 500..10000 | `{ daily_goal }` | 400 |

Every error body is `{ error: "<code>", message: "<human readable>" }`.
Unknown /api routes return 404 JSON. Never send stack traces or the API key
to clients.

## Client behaviour

- The client always sends ITS OWN local date (`YYYY-MM-DD` from the device
  clock, not `toISOString()`, which is UTC) for scans, lists and history.
- Before upload, downscale the photo in the browser (canvas, longest side
  ≤ 1600 px, JPEG quality ~0.85). If decoding fails (e.g. HEIC on a browser
  that can't decode it), upload the original file.
- File input: `accept="image/*"`, with a "Take photo" button
  (`capture="environment"`) and a "Choose from gallery" button (no capture).
  This works over plain HTTP on a LAN, unlike getUserMedia.
- If `/api/health` says `auth_required`, ask for the passcode once, keep it
  in localStorage, and send it as `x-app-token`.
