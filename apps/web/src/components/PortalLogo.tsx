/** Логотип «Портал»: синий круг с заглавной «П» (вариант A). Вектор — чёткий в любом размере. */
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
        d="M22 46 V24 a3 3 0 0 1 3-3 h14 a3 3 0 0 1 3 3 V46"
        fill="none"
        stroke="#fff"
        strokeWidth="7.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
