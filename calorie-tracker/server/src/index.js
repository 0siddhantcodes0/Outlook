import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { SERVER_DIR, loadConfig } from './config.js';
import { openDb } from './db.js';
import { createGeminiAnalyzer, createMockAnalyzer } from './gemini.js';

// server/.env, wherever the process was started from. Real env vars win.
dotenv.config({ path: path.join(SERVER_DIR, '.env'), quiet: true });

const config = loadConfig();
const db = openDb(config.dbPath);

let analyzer = null;
if (config.geminiMock) analyzer = createMockAnalyzer();
else if (config.geminiApiKey) analyzer = createGeminiAnalyzer(config);

const clientDir = path.resolve(SERVER_DIR, '../client/dist');
const hasClient = fs.existsSync(path.join(clientDir, 'index.html'));

const app = createApp({ db, analyzer, config: { ...config, clientDir } });

const server = app.listen(config.port, config.host, (err) => {
  if (err) {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use. Stop the other process or set PORT in server/.env.`
        : `Could not start the server: ${err.message}`,
    );
    process.exit(1);
  }
  printBanner(server.address().port);
});

function printBanner(port) {
  const allInterfaces = config.host === '0.0.0.0' || config.host === '::';
  const lines = ['', 'Snap Calories server is running:'];
  lines.push(`  Local:   http://${allInterfaces ? 'localhost' : config.host}:${port}`);
  if (allInterfaces) {
    for (const address of lanAddresses()) lines.push(`  Network: http://${address}:${port}   <- open this on your phone`);
  }

  if (config.geminiMock) {
    lines.push('', 'Gemini: MOCKED (GEMINI_MOCK=1). Every scan returns the same sample meal.');
  } else if (config.geminiApiKey) {
    lines.push('', `Gemini: configured (models: ${config.geminiModels.join(' -> ')})`);
  } else {
    lines.push('', 'Gemini: NOT configured. Add GEMINI_API_KEY to server/.env (or set GEMINI_MOCK=1); scans return 503 until then.');
  }
  lines.push(`Passcode: ${config.appToken ? 'required (APP_TOKEN is set)' : 'off (set APP_TOKEN to require one)'}`);
  lines.push(`Database: ${config.dbPath}`);
  lines.push(
    hasClient
      ? `Client:   serving ${clientDir}`
      : 'Client:   no build found. Run "npm run build" to serve it here, or use "npm run dev" for the Vite dev server.',
  );
  console.log(lines.join('\n') + '\n');
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && (iface.family === 'IPv4' || iface.family === 4) && !iface.internal)
    .map((iface) => iface.address);
}

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Keep-alive connections can hold close() open; don't hang on Ctrl+C.
  server.closeAllConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
