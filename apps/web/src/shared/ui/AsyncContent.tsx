import { Component, Suspense, type ReactNode } from 'react';
import { Alert, Button, Spin } from 'antd';
import { isChunkLoadError, reloadPage, requireChunkReload } from '@shared/lib';

class ChunkLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    // Ordinary render bugs must not be presented as a server-side version refusal. Import failures
    // join the app's version flow, whose banner stays outside this boundary and offers a reload.
    if (isChunkLoadError(error)) requireChunkReload();
  }

  override render() {
    if (this.state.failed) {
      return (
        <Alert
          type="error"
          showIcon
          title="Не удалось открыть экран"
          description="Обновите страницу. Если ошибка повторяется, попробуйте позже."
          action={<Button onClick={reloadPage}>Обновить страницу</Button>}
        />
      );
    }
    return this.props.children;
  }
}

/** Keep both loading and import failure local: navigation and the update banner must survive. */
export function AsyncContent({
  children,
  fallback = <Spin style={{ display: 'block', margin: '32px auto' }} />,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <ChunkLoadBoundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ChunkLoadBoundary>
  );
}
