import { lazy, Suspense, useEffect, useState } from 'react';
import { Alert, Spin } from 'antd';
import { errorMessage } from '@shared/lib';
import { filesApi } from '../api/filesApi';

/**
 * The minimum a shown file is described by. `contentType` is absent in places (form drafts keep only
 * the name and the size); without it the file counts as not viewable in the browser.
 */
export interface FileRef {
  id: string;
  filename: string;
  contentType?: string;
  size?: number;
}

/**
 * How a PDF is shown:
 *
 * - `frame` — the browser's own viewer in an `<iframe>`, as every attachment of the portal is
 *   shown today. Desktop browsers draw it; Android Chrome shows an empty frame;
 * - `pages` — the portal draws every page itself with pdf.js (lessor receipt plan, O11, P14). Only
 *   the receipt preview asks for it in this release, so no other screen changes behaviour; the
 *   library is loaded on the first such preview, never with the screen around it.
 */
export type PdfPreviewMode = 'frame' | 'pages';

/**
 * A dynamic import, not a static one: the renderer drags pdf.js (half a megabyte) behind it, and
 * this frame is reached from every screen that lists attachments.
 */
const PdfPages = lazy(() => import('./PdfPages'));

const center = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
} as const;

/**
 * The content of a file shown inside the portal: a picture, a frame, or the pages drawn by pdf.js.
 * It fills its parent; the parent decides the size and holds «Скачать» — a preview that cannot be
 * drawn must still leave the person a way to the file.
 *
 * The link is signed and lives minutes, so it is asked when the frame mounts, never in advance for a
 * whole list; a frame unmounted with its window drops it.
 */
export function FilePreviewFrame({ file, pdf = 'frame' }: { file: FileRef; pdf?: PdfPreviewMode }) {
  /*
   * The answer carries the id it belongs to: a frame switched to another file shows a spinner until
   * that file's link arrives, without a reset inside the effect.
   */
  const [link, setLink] = useState<{ id: string; url?: string; error?: string } | null>(null);
  const [drawError, setDrawError] = useState<{ url: string; message: string } | null>(null);
  const type = (file.contentType ?? '').toLowerCase();
  const isImage = type.startsWith('image/');
  const isPdf = type.split(';')[0]!.trim() === 'application/pdf';

  useEffect(() => {
    let cancelled = false;
    void filesApi
      .downloadUrl(file.id, 'inline')
      .then(({ url }) => {
        if (!cancelled) setLink({ id: file.id, url });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLink({ id: file.id, error: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  const current = link?.id === file.id ? link : null;
  const url = current?.url ?? null;
  const error =
    current?.error ?? (drawError && drawError.url === url ? drawError.message : undefined);

  if (error) {
    return (
      <div style={center}>
        <Alert type="error" title="Не удалось открыть файл" description={error} showIcon />
      </div>
    );
  }
  if (!url) {
    return (
      <div style={center}>
        <Spin />
      </div>
    );
  }
  if (isImage) {
    return (
      <div style={center}>
        <img
          src={url}
          alt={file.filename}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          onError={() => setDrawError({ url, message: 'Файл не загрузился — скачайте его' })}
        />
      </div>
    );
  }
  if (isPdf && pdf === 'pages') {
    return (
      <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
        <Suspense
          fallback={
            <div style={center}>
              <Spin />
            </div>
          }
        >
          <PdfPages url={url} onError={(message) => setDrawError({ url, message })} />
        </Suspense>
      </div>
    );
  }
  return (
    <iframe src={url} title={file.filename} style={{ width: '100%', height: '100%', border: 0 }} />
  );
}
