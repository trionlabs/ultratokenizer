import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

/** Resolve the same source imports used by the browser, without checked-in build output. */
export async function loadModule(relative) {
  const scratch = await mkdtemp(join(tmpdir(), 'ultratokenizer-web-test-'));
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      build: {
        ssr: fileURLToPath(new URL(relative, import.meta.url)),
        outDir: scratch,
        target: 'esnext',
        rollupOptions: { output: { entryFileNames: 'module.mjs' } },
      },
    });
    return await import(pathToFileURL(join(scratch, 'module.mjs')).href);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Opt in to configuration tools without making them part of the holder journey. */
export function operatorUrl(base) {
  const url = new URL(base);
  url.searchParams.set('operator', '1');
  return url.href;
}

export async function openOperatorConfiguration(page) {
  if (!(await page.locator('.setup-dialog').isVisible()))
    await page
      .getByRole('button', { name: 'Operator configuration', exact: true })
      .click();
}

/** Exercise the same drop surface used for a file dragged from the desktop. */
export async function dropFiles(page, label, files) {
  await page.getByLabel(label, { exact: true }).evaluate((input, files) => {
    const dataTransfer = new DataTransfer();
    for (const { name, content, type = 'application/json' } of files)
      dataTransfer.items.add(new File([content], name, { type }));
    input.closest('label').dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
  }, files);
}
