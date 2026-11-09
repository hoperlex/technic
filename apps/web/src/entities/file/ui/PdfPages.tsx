import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Spin, Typography } from 'antd';
import {
  getDocument,
  GlobalWorkerOptions,
  version,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

/*
 * The PDF drawn by the portal itself (lessor receipt plan, O11, P14): Android Chrome shows nothing
 * for a PDF in a frame, and the visa holder signs what he SEES — a blank frame on his phone would
 * make the visa a signature on nothing.
 *
 * THIS MODULE IS REACHED ONLY THROUGH A DYNAMIC IMPORT (`FilePreviewFrame`), so the library stays
 * out of the entry and of every route chunk; it is downloaded the first time a receipt is shown.
 *
 * Every setting below answers the portal's CSP (`deploy/nginx/technic.conf`) or the storage:
 * - the worker, the CMaps, the standard fonts and the decoder fallbacks come from the portal's own
 *   origin (`scripts/pdfjs-assets.ts` puts them there): `script-src 'self'` refuses a `blob:` or a
 *   foreign worker, `connect-src 'self'` lets the worker fetch only same-origin files, and a
 *   Cyrillic receipt with non-embedded fonts needs the CMaps and fonts to draw its letters;
 * - `useWasm: false` — the policy has no `'wasm-unsafe-eval'`; the JBIG2 and JPX decoders run from
 *   their JS fallbacks under `wasmUrl`. pdf.js 6 has no `eval` path left (its `isEvalSupported`
 *   option was removed together with the code it switched off), so there is nothing to turn off;
 * - `disableRange` and `disableStream` — one plain GET of the signed URL. A range request needs
 *   the bucket to expose `Content-Range` and `Accept-Ranges` to the portal, which the bucket's
 *   CORS does not promise, and the runbook forbids a proxy through the API.
 */
const ASSETS = `${import.meta.env.BASE_URL}assets/pdfjs-${version}/`;
GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.js`;

/**
 * A receipt is a page or three. The cap keeps a stray hundred-page scan from filling the phone's
 * memory with canvases; the rest is one «Скачать» away.
 */
const MAX_PAGES = 30;
/** Sharper than 2× is invisible on a receipt and quadruples the memory of every page. */
const MAX_OUTPUT_SCALE = 2;
/** iOS Safari refuses a canvas larger than this area and draws nothing at all. */
const MAX_CANVAS_PIXELS = 16_777_216;

/** What the person reads when the file cannot be drawn: the reason, then the way out. */
function failureText(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PasswordException') return 'Файл защищён паролем — скачайте его';
  if (name === 'InvalidPDFException') return 'Файл повреждён или это не PDF — скачайте его';
  return 'Не удалось показать файл — скачайте его';
}

/**
 * Every page to a canvas fitted to the width of the host, one under another; the host scrolls.
 * The canvases are created by hand, not by React: their number is known only after the document
 * loads, and their pixels are pdf.js's business. The host has no React children, so React never
 * touches what is appended to it.
 *
 * The width is measured once, when the document loads; later the canvases follow the host by CSS.
 * Redrawing every page on every resize would cost more than the slight blur of a widened window.
 */
export default function PdfPages({
  url,
  onError,
}: {
  url: string;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState<{ url: string; shown: number; total: number } | null>(
    null,
  );
  // The parent's callback is a new function on every render; the drawing must not restart for it.
  const fail = useEffectEvent((message: string) => onError(message));

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let running: RenderTask | null = null;
    const task = getDocument({
      url,
      cMapUrl: `${ASSETS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}standard_fonts/`,
      wasmUrl: `${ASSETS}wasm/`,
      useWasm: false,
      disableRange: true,
      disableStream: true,
    });

    void (async () => {
      try {
        const pdf = await task.promise;
        const total = pdf.numPages;
        const count = Math.min(total, MAX_PAGES);
        const width = element.clientWidth || 600;
        for (let number = 1; number <= count; number += 1) {
          if (cancelled) return;
          const page = await pdf.getPage(number);
          const viewport = page.getViewport({
            scale: width / page.getViewport({ scale: 1 }).width,
          });
          const ratio = Math.min(
            window.devicePixelRatio || 1,
            MAX_OUTPUT_SCALE,
            Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
          );
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.cssText = 'display:block;width:100%;height:auto;margin:0 auto 8px;';
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `Страница ${number} из ${total}`);
          if (cancelled) return;
          element.append(canvas);
          running = page.render({
            canvas,
            viewport,
            transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          });
          await running.promise;
          running = null;
          if (!cancelled) setProgress({ url, shown: number, total });
        }
      } catch (error) {
        if (!cancelled) fail(failureText(error));
      }
    })();

    return () => {
      cancelled = true;
      running?.cancel();
      void task.destroy();
      element.replaceChildren();
    };
  }, [url]);

  const shown = progress?.url === url ? progress : null;
  return (
    <div style={{ width: '100%' }}>
      {!shown && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <Spin />
        </div>
      )}
      <div ref={host} data-testid="pdf-pages" />
      {shown && shown.total > MAX_PAGES && shown.shown === MAX_PAGES && (
        <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center' }}>
          Показаны первые {MAX_PAGES} страниц из {shown.total} — весь файл можно скачать
        </Typography.Text>
      )}
    </div>
  );
}
