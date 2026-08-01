import { useId } from 'react';

const PALETTES = [
  ['#d88b6c', '#4d4d68', '#11182b', '#f5cda2'],
  ['#a8b4b8', '#40546b', '#101c2a', '#e6d6bf'],
  ['#d7a56a', '#75535b', '#172038', '#f5ddaa'],
  ['#8ba5a8', '#334c58', '#121b27', '#e5c5a4'],
  ['#b79c9d', '#5c566a', '#121628', '#f3d0b1'],
  ['#a2a989', '#4e5c4d', '#111b20', '#e7c895'],
];

export function SimulatedImage({ seed, prompt, compact = false }: { seed: number; prompt: string; compact?: boolean }) {
  const gradientId = useId();
  const glowId = useId();
  const palette = PALETTES[Math.abs(seed) % PALETTES.length];
  const variant = Math.abs(seed) % 4;

  return (
    <svg
      className="simulated-image"
      viewBox="0 0 640 360"
      role="img"
      aria-label={`Simulated preview: ${prompt}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor={palette[0]} />
          <stop offset="0.56" stopColor={palette[1]} />
          <stop offset="1" stopColor={palette[2]} />
        </linearGradient>
        <radialGradient id={glowId} cx="55%" cy="25%" r="58%">
          <stop stopColor={palette[3]} stopOpacity=".82" />
          <stop offset="1" stopColor={palette[3]} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="640" height="360" fill={`url(#${gradientId})`} />
      <rect width="640" height="360" fill={`url(#${glowId})`} />
      {variant === 0 ? (
        <>
          <path d="M0 245 106 167l75 53 92-103 91 93 91-74 185 105v119H0Z" fill="#111622" opacity=".83" />
          <path d="m0 268 145-67 98 69 115-81 108 42 174-63v192H0Z" fill="#0a0f19" opacity=".67" />
          <circle cx="432" cy="105" r="28" fill={palette[3]} opacity=".72" />
          <path d="M318 235v55m-13-35 13-13 14 13m-14 11-18 26m18-26 19 26" stroke="#efe7dc" strokeWidth="5" strokeLinecap="round" opacity=".82" />
        </>
      ) : variant === 1 ? (
        <>
          <path d="M68 93h356v217H68z" fill="#101523" opacity=".78" />
          <path d="M101 125h98v138h-98zm126 0h164v58H227zm0 80h74v58h-74zm96 0h68v58h-68z" fill={palette[3]} opacity=".17" />
          <path d="M424 164h111v146H424z" fill="#0a0d16" opacity=".8" />
          <circle cx="339" cy="165" r="20" fill="#ead5c0" opacity=".77" />
          <path d="M339 185c-28 13-31 45-31 78h67c0-36-9-67-36-78Z" fill="#171e2a" />
          <path d="m309 216-45 20m107-23 43 24" stroke="#dfc8b2" strokeWidth="8" strokeLinecap="round" opacity=".7" />
        </>
      ) : variant === 2 ? (
        <>
          <path d="M0 217c86-22 120 22 200-4 105-34 148 6 215-4 77-12 133-49 225-33v184H0Z" fill="#111b2b" opacity=".75" />
          <path d="M0 252c115-34 155 18 249 0 112-21 222 14 391-24v132H0Z" fill="#0b1422" opacity=".82" />
          <path d="m407 236 76-15 44 29-85 11Z" fill="#b44943" />
          <path d="m459 224 4-60 6 59" stroke="#d9d1c5" strokeWidth="3" />
          <path d="m463 166 46 37-43 4Z" fill="#e7ded0" opacity=".64" />
          <path d="M0 281c106-18 132 13 224-3 108-19 259 20 416-12" fill="none" stroke="#d3dfdf" strokeOpacity=".3" strokeWidth="4" />
        </>
      ) : (
        <>
          <path d="M0 202 640 137v223H0Z" fill="#151b26" opacity=".74" />
          <path d="M0 279 640 218v142H0Z" fill="#0b1019" opacity=".8" />
          <path d="M92 142h202v128H92z" fill="#101521" opacity=".78" />
          <path d="M112 164h69v84h-69zm89 0h73v84h-73z" fill={palette[3]} opacity=".25" />
          <path d="M451 190v84m-20-56 20-24 21 24m-21 21-29 38m29-38 31 36" stroke="#eee7dc" strokeWidth="6" strokeLinecap="round" opacity=".76" />
          <circle cx="451" cy="174" r="16" fill="#d8baa6" opacity=".82" />
        </>
      )}
      <rect width="640" height="360" fill="#080b14" opacity={compact ? '.05' : '.1'} />
      {!compact && (
        <>
          <path d="M0 324h640v36H0z" fill="#070a12" opacity=".5" />
          <text x="20" y="346" fill="#f7f4ef" opacity=".8" fontFamily="ui-monospace, monospace" fontSize="12" letterSpacing="1.5">
            SIMULATED FRAME · 1280 × 720 · SEED {seed}
          </text>
        </>
      )}
    </svg>
  );
}
