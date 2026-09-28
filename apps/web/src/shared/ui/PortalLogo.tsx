/** Логотип «АВТО»: синий круг с заглавной «А». Вектор — чёткий в любом размере. */
export function PortalLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      <circle cx="32" cy="32" r="32" fill="#1677ff" />
      <path
        d="M22 46 L32 20 L42 46 M25 38 H39"
        fill="none"
        stroke="#fff"
        strokeWidth="7.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
