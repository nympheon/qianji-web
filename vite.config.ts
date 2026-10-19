import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) } },
  plugins: [react(), tailwindcss(), cloudflare({
    configPath: process.env.QIANJI_WRANGLER_CONFIG ?? 'wrangler.jsonc',
    viteEnvironment: { name: 'worker' },
  })],
  environments: { worker: { build: { sourcemap: true } } },
});
