import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

const Bomb = () => { throw new Error('boom'); };
const Fine = () => <div>All good</div>;

describe('ErrorBoundary', () => {
    // React logs the caught error to the console by design (componentDidCatch) — silence it
    // so the test output isn't full of expected noise, without hiding a genuinely unexpected one.
    let consoleErrorSpy;
    beforeEach(() => { consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { consoleErrorSpy.mockRestore(); });

    it('renders children normally when nothing throws', () => {
        render(<ErrorBoundary><Fine /></ErrorBoundary>);
        expect(screen.getByText('All good')).toBeInTheDocument();
    });

    it('renders a fallback instead of crashing when a child throws during render', () => {
        render(<ErrorBoundary><Bomb /></ErrorBoundary>);
        expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
        expect(screen.queryByText('All good')).not.toBeInTheDocument();
    });

    it('includes the given label in the fallback message', () => {
        render(<ErrorBoundary label="This section"><Bomb /></ErrorBoundary>);
        expect(screen.getByText('This section hit an unexpected error.')).toBeInTheDocument();
    });

    it('calls onReset and clears the error state when "Try Again" is clicked', () => {
        const onReset = vi.fn();
        const { rerender } = render(<ErrorBoundary onReset={onReset}><Bomb /></ErrorBoundary>);
        expect(screen.getByText('Something went wrong.')).toBeInTheDocument();

        // Swap in non-throwing children first — the boundary still shows the fallback here,
        // since `hasError` only clears via handleReset, not by children changing underneath it.
        rerender(<ErrorBoundary onReset={onReset}><Fine /></ErrorBoundary>);
        expect(screen.getByText('Something went wrong.')).toBeInTheDocument();

        // Clicking "Try Again" clears hasError and re-renders whatever children are current.
        fireEvent.click(screen.getByText('Try Again'));
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(screen.getByText('All good')).toBeInTheDocument();
    });
});
