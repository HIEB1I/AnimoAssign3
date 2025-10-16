import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ''); // reads .env, .env.staging, etc.
  // ensure trailing slash when set
  const base = env.VITE_BASE ? (env.VITE_BASE.endsWith('/') ? env.VITE_BASE : env.VITE_BASE + '/') : '/';

  return {
    plugins: [react()],
    base,
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/analytics': {
          target: 'http://localhost:8100', // adjust if your local analytics isn’t on 8100
          changeOrigin: true,
        },
      },
    },
  };
});
