import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API runs on :3001. In dev, Vite proxies /api there, and host: true
// exposes the dev server on the LAN so a phone on the same Wi-Fi can open it.
const proxy = {
  '/api': { target: 'http://localhost:3001', changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
});
