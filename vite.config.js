import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the client on :5173 and proxies API/WS to the Node server on :3001.
// Prod (`npm start`): the Node server serves the built dist/ bundle on :3001.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'http://localhost:3001', ws: true },
    },
  },
});