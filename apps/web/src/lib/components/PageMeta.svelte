<script lang="ts">
  import { SITE_ORIGIN, sitePage } from '../site-meta.js';
  let { route }: { route: string } = $props();
  const page = $derived(sitePage(route));
  const canonical = $derived(`${SITE_ORIGIN}${page.route}`);
  const markdown = $derived(`${SITE_ORIGIN}${page.markdown}`);
</script>

<svelte:head>
  <title>{page.title}</title>
  <meta name="description" content={page.description} />
  <link rel="canonical" href={canonical} />
  <!-- Agents that prefer source text over rendered HTML follow these. -->
  <link rel="alternate" type="text/markdown" href={markdown} title="Markdown" />
  <meta property="og:title" content={page.title} />
  <meta property="og:description" content={page.description} />
  <meta property="og:url" content={canonical} />
  <meta name="twitter:title" content={page.title} />
  <meta name="twitter:description" content={page.description} />
</svelte:head>
