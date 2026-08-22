import type { HTMLAttributes, ReactNode } from 'react';

type GlassPanelProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  accent?: boolean;
};

export function GlassPanel({ children, className = '', accent = false, ...props }: GlassPanelProps) {
  const classes = ['glass-panel', accent ? 'glass-panel--accent' : '', className].filter(Boolean).join(' ');
  return <section className={classes} {...props}>{children}</section>;
}
