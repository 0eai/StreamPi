import React from 'react';

// The shell every dashboard stat card, node-detail card, and download-link card
// independently re-declared (bg-[#1a1a1a] p-* rounded-xl border border-gray-800).
const Card = ({ className = '', children, ...props }) => (
    <div className={`bg-surface border border-border rounded-lg p-5 ${className}`} {...props}>
        {children}
    </div>
);

export default Card;
