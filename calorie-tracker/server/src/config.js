import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the `server/` directory, independent of the cwd. */
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];

/** Reads the app config from environment variables (see .env.example). */
export function loadConfig(env = process.env) {
  const port = env.PORT ? Number(env.PORT) : 3001;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const models = (env.GEMINI_MODEL ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  const dbPath = env.DB_PATH?.trim() || 'data/calories.db';

  return {
    port,
    host: env.HOST?.trim() || '0.0.0.0',
    dbPath: dbPath === ':memory:' ? dbPath : path.resolve(SERVER_DIR, dbPath),
    appToken: env.APP_TOKEN?.trim() || null,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    geminiModels: models.length > 0 ? models : DEFAULT_MODELS,
    // Undocumented: points the SDK at another endpoint (e.g. a local fake in tests).
    geminiBaseUrl: env.GEMINI_BASE_URL?.trim() || null,
    geminiMock: env.GEMINI_MOCK?.trim() === '1',
  };
}
