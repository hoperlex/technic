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
 *
 * Здесь же — ширина раскрытых списков на весь портал (ADR 0136). Правило одно: список не уже
 * поля, дальше растёт по содержимому, но не шире 90 % ширины окна; что не влезло — многоточие.
 * Раньше это прописывали полю поимённо, и из 186 списков портала правило имели два.
 *
 * Почему здесь, а не обёрткой над `Select`: флаг antd читает из контекста провайдера, а вложенные
 * провайдеры (тема кабинета водителя, тема истории заявки) его наследуют — значит одно место
 * покрывает и `AutoSelect`, и `AutoComplete`, и списки внутри antd. Потолок задан стилем, а не
 * классом, намеренно: контекстные `styles` сливаются с локальными, и точечное переопределение
 * остаётся возможным.
 *
 * Цена решения названа в ADR: `popupMatchSelectWidth={false}` выключает виртуализацию списка —
 * ширину по содержимому виртуальный список дать не может в принципе, он рисует пункты в
 * контейнере фиксированной ширины. Замер на производственной сборке (1000 пунктов, CPU ×4):
 * открытие 159 мс, ввод символа в поиске 98 мс — в пределах порогов, которые задавались до
 * замера. Ветвления по `isMobile` нет: на телефоне поле во всю ширину, и правило даёт там ровно
 * прежнее поведение — нижняя граница в CSS сильнее верхней.
 */
function Root() {
  const isMobile = useIsMobile();
  useMobileRootClass(isMobile);

  return (
    <ConfigProvider
      locale={ruRU}
      theme={themeFor(isMobile)}
      form={{ validateMessages: FORM_VALIDATE_MESSAGES }}
      popupMatchSelectWidth={false}
      select={{ styles: { popup: { root: { maxWidth: '90vw' } } } }}
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
