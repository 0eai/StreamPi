import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

// Every dependency for this already lived in package.json — the config file itself was
// missing, so `npm run lint` silently did nothing and a "used but not imported" bug
// (useEffect, formatBytes) shipped straight to production undetected.
export default [
    { ignores: ['dist'] },
    {
        files: ['**/*.{js,jsx}'],
        languageOptions: {
            ecmaVersion: 'latest',
            globals: { ...globals.browser, ...globals.es2021 },
            parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
        },
        plugins: {
            'react-hooks': reactHooks,
            'react-refresh': reactRefresh,
        },
        rules: {
            ...js.configs.recommended.rules,
            // rules-of-hooks (calling hooks conditionally, etc.) stays an error — a real bug
            // class. exhaustive-deps stays a warning — useful, but noisy as a hard failure.
            // The v7 React-Compiler-readiness rules (purity/set-state-in-effect/refs) are left
            // off: they flag long-standing, deliberate patterns throughout this whole app
            // (fetch-on-mount via useEffect, Date.now() in render) as errors — a real
            // architectural conversation, not something to silently start failing lint over.
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', args: 'none' }],
            'react-refresh/only-export-components': 'off',
        },
    },
];
