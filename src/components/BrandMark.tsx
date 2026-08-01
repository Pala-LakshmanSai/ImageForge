import { useId } from 'react';

export function BrandMark({ size = 28 }: { size?: number }) {
  const gradientId = useId();
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="ImageForge aperture and spark mark"
    >
      <defs>
        <linearGradient id={gradientId} x1="5" y1="4" x2="27" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ff5969" />
          <stop offset="1" stopColor="#8d5cff" />
        </linearGradient>
      </defs>
      <path
        d="M9 3.75h9.25L25.5 11v12.25a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8.75a5 5 0 0 1 5-5Z"
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path d="m18.25 3.75.05 5.7c0 .9.72 1.62 1.62 1.62h5.58" fill="none" stroke="#ff7784" strokeWidth="2.2" />
      <path
        d="M9.25 17.7c0-3.17 2.57-5.74 5.75-5.74 2.2 0 4.1 1.23 5.07 3.04l-3.1.02-2.04 3.5-1.55-2.69-3.85 2.23"
        fill="none"
        stroke="#f7f4ef"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m22.55 18.1.68 1.58 1.58.68-1.58.68-.68 1.58-.68-1.58-1.58-.68 1.58-.68.68-1.58Z" fill="#ff4b62" />
    </svg>
  );
}
