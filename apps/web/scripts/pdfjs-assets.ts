import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * The files pdf.js loads BY URL at run time, served from the portal's own origin (lessor receipt
 * plan, P14): the worker, the Adobe CMaps, the standard fonts and the no-WebAssembly fallbacks of
 * the JBIG2 and JPX decoders. They are not imports, so the bundler never sees them; a renderer that
 * found none of them would still draw a Cyrillic receipt with a non-embedded font as empty boxes.
 *
 * WHY SAME ORIGIN AND NOT A BLOB OR A CDN. The portal's CSP (`deploy/nginx/technic.conf`) has
 * `script-src 'self'` and no `worker-src`, so a worker from a `blob:` URL or another host is
 * refused, and `connect-src` lets the worker fetch CMaps only from `'self'`. No `wasm-unsafe-eval`
 * either: the renderer runs with `useWasm: false`, and the JS fallbacks below take the place of the
 * WebAssembly decoders.
 *
 * WHY `.js` AND NOT THE PACKAGE'S `.mjs`. The web container is `nginx:1.27-alpine`, whose
 * `mime.types` has no `mjs`: such a file goes out as `application/octet-stream`, and with
 * `X-Content-Type-Options: nosniff` a browser refuses to start a module worker from it. The bytes
 * are the same; only the name decides the type nginx sends.
 *
 * WHY A VERSIONED DIRECTORY UNDER `assets/`. Everything under `/assets/` is cached as immutable by
 * `deploy/nginx/spa.conf`; the package version in the path is the cache key, so an upgrade of
 * `pdfjs-dist` cannot pair a new library with an old cached worker (pdf.js refuses a worker of
 * another version). The renderer builds the same path from the library's own `version` export.
 *
 * The LEGACY build is served on purpose, as the renderer imports it: the modern build calls APIs
 * (`Map.prototype.getOrInsertComputed`, `Math.sumPrecise`) newer than the portal's browser target,
 * and the legacy one carries their polyfills.
 */

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

/** Where the files live in `dist`, relative to its root: `assets/pdfjs-<version>`. */
export const PDFJS_ASSET_DIR = `assets/pdfjs-${PACKAGE_VERSION}`;

const filesOf = (dir: string, extensions: readonly string[]): [string, string][] =>
  readdirSync(path.join(PACKAGE_ROOT, dir))
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map((name) => [`${dir}/${name}`, `${dir}/${name}`]);

/** `[source in the package, path under PDFJS_ASSET_DIR]`. */
export function pdfjsAssetFiles(): [string, string][] {
  return [
    ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.js'],
    // Imported by the worker as `${wasmUrl}<name>` when WebAssembly is off; their names are fixed
    // by pdf.js, so they keep them.
    ['wasm/jbig2_nowasm_fallback.js', 'wasm/jbig2_nowasm_fallback.js'],
    ['wasm/openjpeg_nowasm_fallback.js', 'wasm/openjpeg_nowasm_fallback.js'],
    ...filesOf('cmaps', ['.bcmap']),
    ...filesOf('standard_fonts', ['.pfb', '.ttf']),
  ];
}

export function pdfjsAssets(): Plugin {
  const files = pdfjsAssetFiles();
  const bySource = new Map(files.map(([from, to]) => [`/${PDFJS_ASSET_DIR}/${to}`, from]));
  return {
    name: 'pdfjs-assets',
    // The dev server answers the same paths from the package, so `pnpm dev` exercises the very
    // URLs production serves.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const from = req.url ? bySource.get(req.url.split('?')[0]!) : undefined;
        if (!from) return next();
        res.setHeader(
          'Content-Type',
          from.endsWith('.js') || from.endsWith('.mjs')
            ? 'text/javascript'
            : 'application/octet-stream',
        );
        createReadStream(path.join(PACKAGE_ROOT, from)).pipe(res);
      });
    },
    generateBundle() {
      for (const [from, to] of files) {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_ASSET_DIR}/${to}`,
          source: readFileSync(path.join(PACKAGE_ROOT, from)),
        });
      }
    },
  };
}
