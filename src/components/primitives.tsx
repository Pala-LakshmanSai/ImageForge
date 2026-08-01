import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function Button({
  children,
  icon: Icon,
  tone = 'secondary',
  compact = false,
  pending = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  icon?: LucideIcon;
  tone?: 'primary' | 'secondary' | 'quiet' | 'danger';
  compact?: boolean;
  pending?: boolean;
}) {
  return (
    <button
      className={`button button--${tone} ${compact ? 'button--compact' : ''} ${className}`}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending ? <span className="button-spinner" aria-hidden="true" /> : Icon ? <Icon size={16} strokeWidth={1.9} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({
  label,
  icon: Icon,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function StatusDot({ tone = 'neutral', pulse = false }: { tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; pulse?: boolean }) {
  return <span className={`status-dot status-dot--${tone} ${pulse ? 'status-dot--pulse' : ''}`} aria-hidden="true" />;
}

export function PhaseBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }) {
  return (
    <span className={`phase-badge phase-badge--${tone}`}>
      <StatusDot tone={tone} pulse={tone === 'success' || tone === 'warning'} />
      {children}
    </span>
  );
}

export function RingProgress({ value, label }: { value: number; label: string }) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className="ring-progress" style={{ '--ring-value': `${clamped * 3.6}deg` } as React.CSSProperties}>
      <div className="ring-progress__inner">
        <strong>{clamped}%</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

export function LinearProgress({ value, label }: { value: number; label: string }) {
  return (
    <div className="linear-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Metric({ label, value, detail, tone }: { label: string; value: ReactNode; detail: string; tone?: 'success' | 'warning' }) {
  return (
    <div className={`metric ${tone ? `metric--${tone}` : ''}`}>
      <span className="metric__label">{label}</span>
      <strong className="metric__value">{value}</strong>
      <span className="metric__detail">{detail}</span>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, copy, action }: { icon: LucideIcon; title: string; copy: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Icon size={24} strokeWidth={1.6} /></span>
      <h3>{title}</h3>
      <p>{copy}</p>
      {action}
    </div>
  );
}
