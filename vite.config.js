import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/tomari-guruguru/' : '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    open: '/',
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
}));
