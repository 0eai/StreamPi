import React from 'react';

// One button, four variants — replaces the hand-rolled classNames that had drifted
// across the app (bg-white primary here, bg-red-600 primary there, hover:bg-red-700
// in one modal and hover:bg-red-500 in another). `danger` deliberately stays quiet
// (same visual weight as `ghost`) until hover/focus, so a destructive action never
// competes with whichever button on the screen is actually the primary one.
const VARIANTS = {
    primary: 'bg-accent text-white hover:bg-accent-hover rounded-md px-4 py-2.5 text-sm font-medium',
    ghost: 'bg-transparent text-text border border-border hover:bg-surface-2 rounded-md px-4 py-2.5 text-sm font-medium',
    danger: 'bg-transparent text-muted border border-border hover:border-danger hover:text-danger rounded-md px-4 py-2.5 text-sm font-medium',
    icon: 'bg-transparent text-muted hover:bg-surface-2 hover:text-text rounded-full p-2',
    // Plain underlined text — register/mode-switch toggles, "use password instead" links.
    // Not boxed like the other variants, so it stays out of the button hierarchy entirely.
    link: 'bg-transparent text-muted hover:text-text underline text-sm p-0',
};

const Button = ({ variant = 'ghost', className = '', children, ...props }) => (
    <button
        className={`inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none ${VARIANTS[variant]} ${className}`}
        {...props}
    >
        {children}
    </button>
);

export default Button;
