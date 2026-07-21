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

export const MOSCOW_TZ = 'Europe/Moscow';
