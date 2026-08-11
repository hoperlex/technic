import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { setupDayjs, useIsMobile, useMobileRootClass } from '@shared/lib';
import { FORM_VALIDATE_MESSAGES } from '@shared/config';
import { themeFor } from './theme';
import './styles.css';

// Часовой пояс и локаль — одной функцией на приложение и тесты: два места, обязанные совпадать,
// раньше были связаны только памятью.
setupDayjs();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

/**
 * Корень приложения: отсюда режим устройства расходится по обеим дорогам — в тему antd и в класс
 * на <html>, по которому работают мобильные стили (ADR 0030). На десктопе обе величины те же,
 * что и до появления мобильной версии.
 */
function Root() {
  const isMobile = useIsMobile();
  useMobileRootClass(isMobile);

  return (
    <ConfigProvider
      locale={ruRU}
      theme={themeFor(isMobile)}
      form={{ validateMessages: FORM_VALIDATE_MESSAGES }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
