// W3BuildCost v0.1.0 — tests/helpers/buildHarness.mjs
//
// Copied from W3 Core v0.12.11 (frontend/command-center/tests/helpers/
// buildHarness.mjs). Build behaviour is unchanged; only this header and the
// default entry name (appHarness) differ.
//
// Bundles tests/harness/*.tsx with Vite (already a devDependency) in SSR mode so
// the real app TSX sources can be imported by Node's test runner.
// React and other node_modules stay external, which guarantees the test's
// `react-dom/client` and the bundle share one React instance.
//
// v0.12.10: accepts an optional `{ appRoot }` so the Admin Console tests
// (frontend/admin/tests) can reuse the same builder against their own
// src/ and tests/harness/ directories. Default behaviour is unchanged.

import path from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { consoleConfiguration, consoleConfigurationPlugin } from './consoleConfiguration.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultAppRoot = path.resolve(here, '..', '..');

export async function buildHarness(entryName = 'appHarness', { appRoot = defaultAppRoot, configuration = consoleConfiguration('w3forge') } = {}) {
  const entry = path.join(appRoot, 'tests', 'harness', `${entryName}.tsx`);
  if (!existsSync(entry)) throw new Error(`harness entry not found: ${entry}`);
  // Output lives inside the workspace (git-ignored) so Node can resolve the
  // externalized `react` / `react-dom` imports from the repo's node_modules.
  const outDir = path.join(appRoot, '.test-harness', `${entryName}-${process.pid}`);
  if (!path.resolve(outDir).startsWith(path.resolve(appRoot, '.test-harness') + path.sep)) throw new Error('Invalid harness output directory');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  await build({
    configFile: false,
    logLevel: 'silent',
    root: appRoot,
    mode: 'test',
    plugins: [react(), consoleConfigurationPlugin(configuration)],
    resolve: {
      alias: {
        '@': path.resolve(appRoot, 'src'),
        '@shared': path.resolve(appRoot, '../shared')
      }
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    ssr: { target: 'node', noExternal: [] },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      write: true,
      rollupOptions: { output: { format: 'es', entryFileNames: `${entryName}.mjs` } }
    }
  });
  const outFile = path.join(outDir, `${entryName}.mjs`);
  const mod = await import(pathToFileURL(outFile).href);
  rmSync(outDir, { recursive: true, force: true });
  return mod;
}
