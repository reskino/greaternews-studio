import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths so the build works at any URL (GitHub Pages subpath, local file, root domain).
  base: './',
  plugins: [react()],
});
