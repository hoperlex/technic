import { Component, Suspense, type ReactNode } from 'react';
import { Alert, Button, Spin } from 'antd';
import { isChunkLoadError, reloadPage, requireChunkReload } from '@shared/lib';

interface BoundaryProps {
  children: ReactNode;
  resetKey?: unknown;
}

class ChunkLoadBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  /*
   * A failed boundary must let go once the screen it guards changes. React keeps one instance for
   * every route element of the same type at the same position, so without a reset an ordinary render
   * error in one section stayed on screen after the user picked another one, and only a reload got
   * them out. If the new screen fails as well it simply fails again.
   */
  override componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && !Object.is(previous.resetKey, this.props.resetKey))
      this.setState({ failed: false });
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

/**
 * Keep both loading and import failure local: navigation and the update banner must survive.
 * `resetKey` names the screen being guarded (a pathname, a tab key); when it changes, a failure
 * shown for the previous screen is cleared.
 */
export function AsyncContent({
  children,
  fallback = <Spin style={{ display: 'block', margin: '32px auto' }} />,
  resetKey,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  resetKey?: unknown;
}) {
  return (
    <ChunkLoadBoundary resetKey={resetKey}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ChunkLoadBoundary>
  );
}
