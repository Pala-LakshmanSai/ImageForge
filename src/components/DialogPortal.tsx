import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function DialogPortal({
  children,
  backdropClassName,
  surfaceClassName,
  labelledBy,
  describedBy,
  role = 'dialog',
  onRequestClose,
  closeOnBackdrop = true,
}: {
  children: ReactNode;
  backdropClassName: string;
  surfaceClassName: string;
  labelledBy: string;
  describedBy?: string;
  role?: 'dialog' | 'alertdialog';
  onRequestClose?: () => void;
  closeOnBackdrop?: boolean;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.querySelector<HTMLElement>('.app-shell');
    const previousOverflow = document.body.style.overflow;
    const previouslyInert = appRoot?.hasAttribute('inert') ?? false;
    const previousAriaHidden = appRoot ? appRoot.getAttribute('aria-hidden') : null;

    const surface = surfaceRef.current;
    const preferred = surface?.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
    const first = surface?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (preferred ?? first ?? surface)?.focus();
    document.body.style.overflow = 'hidden';
    appRoot?.setAttribute('inert', '');
    appRoot?.setAttribute('aria-hidden', 'true');

    function onKeyDown(event: KeyboardEvent) {
      const surface = surfaceRef.current;
      if (!surface) return;
      if (event.key === 'Escape' && closeRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        surface.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!surface.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (appRoot) {
        if (!previouslyInert) appRoot.removeAttribute('inert');
        if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden');
        else appRoot.setAttribute('aria-hidden', previousAriaHidden);
      }
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div
      className={backdropClassName}
      role="presentation"
      onMouseDown={() => {
        if (closeOnBackdrop) closeRef.current?.();
      }}
    >
      <section
        ref={surfaceRef}
        className={surfaceClassName}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
