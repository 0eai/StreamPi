import React from 'react';
import { Smartphone, Terminal, Download, ArrowLeft, Github, ExternalLink } from 'lucide-react';
import { SERVER_URL } from '../utils/api';
import Card from './ui/Card';

// A standalone, unauthenticated page (mounted directly in main.jsx, before the login gate —
// see the window.location.pathname check there) so someone without an account yet can still
// get the Android TV app or the worker-node setup script. Both /api/apk and
// /api/worker-script are already public server-side; this just gives them a page to land on
// instead of requiring a raw API URL.
const DownloadsPage = () => (
    <div className="min-h-screen bg-bg text-text flex items-center justify-center flex-col gap-6 p-4">
        <div className="flex items-center gap-3">
            <img src="/logo.png" alt="StreamPi" className="h-10 w-auto object-contain" />
            <h1 className="text-2xl font-bold">Downloads</h1>
        </div>

        <Card className="w-full max-w-md p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4 p-4 rounded-lg border border-border bg-surface-2/50">
                <div className="flex items-center gap-4">
                    <div className="w-11 h-11 bg-info/10 rounded-lg flex items-center justify-center text-info shrink-0">
                        <Smartphone className="w-6 h-6" />
                    </div>
                    <div>
                        <h3 className="font-bold">Android TV App</h3>
                        {/* No version number here on purpose. It used to read "v1.0.apk", hardcoded,
                            and stayed there while the app shipped v1.1 (versionCode 16) — a version
                            string nothing updates is worse than none, because it looks authoritative.
                            The real version lives in StreamPiTV/version.properties, and the APK is
                            replaced in place by deploy-apk.sh, so there is nothing here to sync to. */}
                        <p className="text-sm text-muted">Sideload onto Android TV or Fire TV</p>
                    </div>
                </div>
                <a
                    href={`${SERVER_URL}/api/apk`}
                    className="bg-info hover:brightness-110 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all shrink-0"
                >
                    <Download className="w-4 h-4" /> Get
                </a>
            </div>

            <div className="flex items-center justify-between gap-4 p-4 rounded-lg border border-border bg-surface-2/50">
                <div className="flex items-center gap-4">
                    <div className="w-11 h-11 bg-accent-soft rounded-lg flex items-center justify-center text-accent shrink-0">
                        <Terminal className="w-6 h-6" />
                    </div>
                    <div>
                        <h3 className="font-bold">Worker Node Script</h3>
                        <p className="text-sm text-muted">Set up a new transcoder/NAS node</p>
                    </div>
                </div>
                <a
                    href={`${SERVER_URL}/api/worker-script`}
                    className="bg-accent hover:brightness-110 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all shrink-0"
                >
                    <Download className="w-4 h-4" /> Get
                </a>
            </div>

            <div className="flex items-center justify-between gap-4 p-4 rounded-lg border border-border bg-surface-2/50">
                <div className="flex items-center gap-4">
                    <div className="w-11 h-11 bg-surface-2 rounded-lg flex items-center justify-center text-text shrink-0">
                        <Github className="w-6 h-6" />
                    </div>
                    <div>
                        <h3 className="font-bold">Source Code</h3>
                        <p className="text-sm text-muted">StreamPi on GitHub</p>
                    </div>
                </div>
                <a
                    href="https://github.com/0eai/StreamPi.git"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-surface-2 hover:brightness-110 text-text px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all shrink-0 border border-border"
                >
                    <ExternalLink className="w-4 h-4" /> Visit
                </a>
            </div>
        </Card>

        <a href="/" className="text-sm text-muted hover:text-text flex items-center gap-2 transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to StreamPi
        </a>
    </div>
);

export default DownloadsPage;
