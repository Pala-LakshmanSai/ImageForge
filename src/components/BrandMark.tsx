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
      aria-label="ImageForge forged aperture mark"
    >
      <defs>
        <linearGradient id={gradientId} x1="4" y1="3" x2="29" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ff5969" />
          <stop offset="0.45" stopColor="#ff3f72" />
          <stop offset="0.72" stopColor="#9a55ff" />
          <stop offset="1" stopColor="#8d5cff" />
        </linearGradient>
        <radialGradient id={`${gradientId}-core`} cx="0" cy="0" r="1" gradientTransform="translate(14 14) rotate(45) scale(8)" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8deaff" stopOpacity=".95" />
          <stop offset="1" stopColor="#2f6fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#0c122b" stroke="#d8e4ff" strokeOpacity=".16" strokeWidth=".7" />
      <circle cx="16" cy="16" r="10.2" fill="none" stroke={`url(#${gradientId})`} strokeWidth="2.35" />
      <circle cx="16" cy="16" r="8.6" fill="#080d22" stroke="#f7f4ef" strokeOpacity=".13" strokeWidth=".35" />
      <g fill="#f7f4ef" fillOpacity=".95">
        <path d="M16 8.6c-2.25 0-4.06 1.81-4.06 4.06 0 1.34.65 2.53 1.66 3.25L16 11.72l2.4 4.19a4.02 4.02 0 0 0 1.66-3.25c0-2.25-1.81-4.06-4.06-4.06Z" />
        <path d="M16 8.6c-2.25 0-4.06 1.81-4.06 4.06 0 1.34.65 2.53 1.66 3.25L16 11.72l2.4 4.19a4.02 4.02 0 0 0 1.66-3.25c0-2.25-1.81-4.06-4.06-4.06Z" transform="rotate(60 16 16)" />
        <path d="M16 8.6c-2.25 0-4.06 1.81-4.06 4.06 0 1.34.65 2.53 1.66 3.25L16 11.72l2.4 4.19a4.02 4.02 0 0 0 1.66-3.25c0-2.25-1.81-4.06-4.06-4.06Z" transform="rotate(120 16 16)" />
        <path d="M16 8.6c-2.25 0-4.06 1.81-4.06 4.06 0 1.34.65 2.53 1.66 3.25L16 11.72l2.4 4.19a4.02 4.02 0 0 0 1.66-3.25c0-2.25-1.81-4.06-4.06-4.06Z" transform="rotate(180 16 16)" />
        <path d="M16 8.6c-2.25 0-4.06 1.81-4.06 4.06 0 1.34.65 2.53 1.66 3.25L16 11.72l2.4 4.19a4.02 4.02 0 0 0 1.66-3.25c0-2.25-1.81-4.06-4.06-4.06Z" transform="rotate(240 16 16)" />
        <path d="M16 8.6c-2.25 0-4.06 1.81-4.06 4.06 0 1.34.65 2.53 1.66 3.25L16 11.72l2.4 4.19a4.02 4.02 0 0 0 1.66-3.25c0-2.25-1.81-4.06-4.06-4.06Z" transform="rotate(300 16 16)" />
      </g>
      <circle cx="16" cy="16" r="2.8" fill="#080d22" stroke="#f7f4ef" strokeOpacity=".84" strokeWidth=".55" />
      <circle cx="15.5" cy="15.5" r="1.45" fill={`url(#${gradientId}-core)`} />
      <path d="m25.1 5.3.48 1.18 1.18.48-1.18.48-.48 1.18-.48-1.18-1.18-.48 1.18-.48.48-1.18Z" fill="#77e9ff" />
    </svg>
  );
}
