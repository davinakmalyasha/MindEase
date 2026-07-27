"use client";

import { Component, ReactNode } from "react";
import Link from "next/link";

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false };

    static getDerivedStateFromError(): State {
        return { hasError: true };
    }

    componentDidCatch(error: Error) {
        console.error("[ErrorBoundary]", error);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-[60vh] flex flex-col items-center justify-center p-8 text-center">
                    <div className="w-20 h-20 rounded-full bg-rose-50 flex items-center justify-center mb-6 text-3xl">😕</div>
                    <h1 className="text-2xl font-extrabold text-gray-900 mb-2">Something went wrong</h1>
                    <p className="text-gray-500 mb-6 max-w-sm">
                        An unexpected error occurred. Try refreshing the page, or head back to safety.
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={() => this.setState({ hasError: false })}
                            className="px-6 py-3 bg-indigo-600 text-white rounded-2xl font-bold hover:bg-indigo-700 transition-all"
                        >
                            Try again
                        </button>
                        <Link
                            href="/"
                            className="px-6 py-3 bg-gray-100 text-gray-700 rounded-2xl font-bold hover:bg-gray-200 transition-all"
                        >
                            Back to Home
                        </Link>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
