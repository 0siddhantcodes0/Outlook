import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_MODELS, SERVER_DIR, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses the documented defaults', () => {
    assert.deepEqual(loadConfig({}), {
      port: 3001,
      host: '0.0.0.0',
      dbPath: path.join(SERVER_DIR, 'data', 'calories.db'),
      appToken: null,
      geminiApiKey: null,
      geminiModels: DEFAULT_MODELS,
      geminiBaseUrl: null,
      geminiMock: false,
    });
    assert.deepEqual(DEFAULT_MODELS, ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash']);
  });

  it('reads every variable', () => {
    const config = loadConfig({
      GEMINI_API_KEY: ' key ',
      GEMINI_MODEL: 'a, b ,,c',
      PORT: '8080',
      HOST: '127.0.0.1',
      DB_PATH: 'elsewhere/x.db',
      APP_TOKEN: 'pass',
      GEMINI_MOCK: '1',
      GEMINI_BASE_URL: 'http://127.0.0.1:9999',
    });
    assert.equal(config.geminiApiKey, 'key');
    assert.deepEqual(config.geminiModels, ['a', 'b', 'c']);
    assert.equal(config.port, 8080);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.dbPath, path.join(SERVER_DIR, 'elsewhere', 'x.db'));
    assert.equal(config.appToken, 'pass');
    assert.equal(config.geminiMock, true);
    assert.equal(config.geminiBaseUrl, 'http://127.0.0.1:9999');
  });

  it('resolves DB_PATH against the server dir, not the cwd', () => {
    assert.ok(path.isAbsolute(loadConfig({ DB_PATH: 'data/test.db' }).dbPath));
    assert.ok(loadConfig({ DB_PATH: 'data/test.db' }).dbPath.startsWith(SERVER_DIR));
    assert.equal(loadConfig({ DB_PATH: '/var/tmp/x.db' }).dbPath, '/var/tmp/x.db');
    assert.equal(loadConfig({ DB_PATH: ':memory:' }).dbPath, ':memory:');
  });

  it('treats empty values as unset and only "1" as mock', () => {
    const config = loadConfig({ GEMINI_API_KEY: '', APP_TOKEN: '  ', GEMINI_MODEL: ' , ', GEMINI_MOCK: 'true' });
    assert.equal(config.geminiApiKey, null);
    assert.equal(config.appToken, null);
    assert.deepEqual(config.geminiModels, DEFAULT_MODELS);
    assert.equal(config.geminiMock, false);
  });

  it('rejects a bad PORT', () => {
    assert.throws(() => loadConfig({ PORT: 'eighty' }), /PORT/);
  });
});
