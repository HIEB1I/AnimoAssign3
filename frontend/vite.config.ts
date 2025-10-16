import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const rawBase = env.VITE_BASE || '/';
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

  return {
    plugins: [react()],
    base,
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
          // /api/records -> /records (what your backend expects)
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        '/analytics': {
          target: 'http://localhost:8100',
          changeOrigin: true,
          // /analytics/summary -> /summary
          rewrite: (path) => path.replace(/^\/analytics/, ''),
        },
      },
    },
    preview: { port: 4173 },
  };
});
