import React from 'react';

// One shade per meaning, replacing status/role/type badges that each hand-picked
// their own color+opacity per file (bg-{color}-{600-900}/{opacity}, text-{color}).
const TONES = {
    neutral: 'bg-surface-2 text-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-info/10 text-info',
    danger: 'bg-danger/10 text-danger',
};

const Badge = ({ tone = 'neutral', className = '', children }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium uppercase tracking-wide ${TONES[tone]} ${className}`}>
        {children}
    </span>
);

export default Badge;
