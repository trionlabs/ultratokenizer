import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    csp: {
      // Prerendered HTML receives hashes for SvelteKit's hydration script.
      mode: 'hash',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'script-src-attr': ['none'],
        // Orbit uses reactive CSS custom properties and Svelte-managed styles.
        'style-src': ['self', 'unsafe-inline'],
        'font-src': ['self'],
        'img-src': ['self', 'data:'],
        // RPC origins are explicit user imports, never supplied by a receipt.
        'connect-src': [
          'self',
          'https:',
          'http://localhost:*',
          'http://127.0.0.1:*',
        ],
        'worker-src': ['self'],
        'object-src': ['none'],
        'frame-src': ['none'],
        'base-uri': ['none'],
        'form-action': ['none'],
      },
    },
  },
};
