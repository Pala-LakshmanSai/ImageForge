import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  cacheDir: '.cache/vite',
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    restoreMocks: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/._*', '**/node_modules/**', '**/dist/**'],
  },
});
