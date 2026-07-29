import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import dayjs from 'dayjs';
import 'dayjs/locale/ru';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { BrowserRouter } from 'react-router';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { useIsMobile, useMobileRootClass } from './hooks/useIsMobile';
import { MOSCOW_TZ, themeFor } from './theme';
import './styles.css';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('ru');
dayjs.tz.setDefault(MOSCOW_TZ);

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
    <ConfigProvider locale={ruRU} theme={themeFor(isMobile)}>
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
