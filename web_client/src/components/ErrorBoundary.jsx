import React from 'react';

// Class component because React Error Boundaries require componentDidCatch /
// getDerivedStateFromError — no hook-based equivalent exists. Without one anywhere in this
// app, a single malformed field in one API response (a null path/status/filename) would
// white-screen the entire app for every open tab, not just the section that used that field.
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error, info) {
        console.error('Caught by ErrorBoundary:', error, info?.componentStack);
    }

    handleReset = () => {
        this.setState({ hasError: false });
        if (this.props.onReset) this.props.onReset();
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center min-h-[300px] p-8 text-center gap-3">
                    <p className="text-white font-medium">{this.props.label ? `${this.props.label} hit an unexpected error.` : 'Something went wrong.'}</p>
                    <p className="text-gray-400 text-sm max-w-sm">The rest of the app should still work — try again, or reload if the problem persists.</p>
                    <button
                        onClick={this.handleReset}
                        className="mt-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        Try Again
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
