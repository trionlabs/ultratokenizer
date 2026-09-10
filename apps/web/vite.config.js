import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [sveltekit()],
  worker: { format: 'es' },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        fileURLToPath(new URL('../../packages', import.meta.url)),
      ],
    },
  },
});
