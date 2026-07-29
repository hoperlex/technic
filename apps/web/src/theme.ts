import type { ThemeConfig } from 'antd';

export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 6,
    fontSize: 14,
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      headerHeight: 56,
    },
  },
};

/**
 * Мобильная тема: те же цвета и скругления, но управляющие элементы под палец (40 px против 32)
 * и шрифт 16 px — поле мельче Safari увеличивает при фокусе, и обратно страница не возвращается.
 * Собирается один раз: пересоздание объекта на каждый рендер сбрасывало бы кэш стилей antd.
 */
const mobileTheme: ThemeConfig = {
  ...theme,
  token: { ...theme.token, fontSize: 16, controlHeight: 40 },
};

/** Десктоп получает ровно тот же объект, что и раньше (ADR 0030): тема — не место для ветвлений. */
export function themeFor(isMobile: boolean): ThemeConfig {
  return isMobile ? mobileTheme : theme;
}

export const MOSCOW_TZ = 'Europe/Moscow';
