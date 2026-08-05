import React from 'react';

// One focus-ring color (accent) — replaces the per-modal arbitrary focus colors that
// had accumulated (red-600 in one form, purple-500 in another, yellow-500, blue-500,
// red-500 + a separate ring utility in a fifth), none of which had anything to do with
// what the field actually was.
const Input = ({ label, className = '', ...props }) => (
    <label className="block">
        {label && (
            <span className="block text-xs uppercase tracking-wider text-muted-2 font-medium mb-2">{label}</span>
        )}
        <input
            className={`w-full bg-surface border border-border rounded-md px-3.5 py-2.5 text-text placeholder:text-muted-2 focus:outline-none focus:border-accent transition-colors ${className}`}
            {...props}
        />
    </label>
);

export default Input;
