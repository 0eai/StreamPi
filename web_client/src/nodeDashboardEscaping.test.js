/**
 * The node dashboard's HTML escaping (node/public/app.js).
 *
 * Lives here for the same reason as nodeDashboardDialogs.test.js: this is the repo's only jsdom
 * harness, and the dashboard has no build step. The file is read as text and the one function under
 * test is extracted from it — app.js as a whole cannot be evaluated in isolation, since on load it
 * immediately reaches for DOM nodes and a service worker.
 *
 * What this guards is not cosmetic. That page renders filenames with innerHTML, and any user who can
 * put a file on the node chooses that string — isSafeFilename, which guards the write, is a
 * path-traversal check that accepts `<img src=x onerror=...>.mp4` because for its purpose that name is
 * fine. The page holds the node's API key in localStorage, so an unescaped filename is a route from
 * "can upload a file" to "owns the node".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const findUp = (rel) => {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
        const candidate = path.join(dir, rel);
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
    }
    throw new Error(`could not locate ${rel} from ${process.cwd()}`);
};

const SRC = fs.readFileSync(findUp('node/public/app.js'), 'utf8');

// Pull `function esc(...) { ... }` out and evaluate just that.
const escSource = /function esc\(value\) \{[\s\S]*?\n\}/.exec(SRC);
if (!escSource) throw new Error('esc() not found in node/public/app.js');
// eslint-disable-next-line no-new-func
const esc = new Function(`${escSource[0]}; return esc;`)();

describe('the dashboard escapes what it renders', () => {
    it('neutralises a script-bearing filename', () => {
        const out = esc('<img src=x onerror=alert(1)>.mp4');
        expect(out).not.toContain('<img');
        expect(out).toContain('&lt;img');
    });

    it('neutralises a filename that tries to break out of an attribute', () => {
        // Several of these interpolations land inside title="..." and value="...", where escaping
        // only angle brackets would leave the attribute breakable.
        const out = esc('x" onmouseover="alert(1)".mp4');
        expect(out).not.toContain('"');
        expect(out).toContain('&quot;');
    });

    it('escapes single quotes too, for single-quoted attributes', () => {
        expect(esc("x' onfocus='alert(1)")).not.toContain("'");
    });

    it('escapes ampersands first, so an escape cannot be re-formed', () => {
        // &lt; must not come out of &amp;lt; — ordering matters, and getting it wrong reintroduces
        // the very tag being escaped.
        expect(esc('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
    });

    it('leaves an ordinary filename readable', () => {
        expect(esc('California - Oct 1 – 10, 2023 Trip.mp4')).toBe('California - Oct 1 – 10, 2023 Trip.mp4');
    });

    it('renders null and undefined as empty rather than the words', () => {
        expect(esc(undefined)).toBe('');
        expect(esc(null)).toBe('');
    });
});

describe('no attacker-influenced value is interpolated raw', () => {
    /**
     * A source-level check, because the risk is a *future* template rather than today's. Each of these
     * is a value that arrives from outside the node and is rendered into HTML.
     */
    const mustBeEscaped = ['f.name', 'j.filename', 'h.filename', 'h.status', 'f.locationId', 'loc.path', 'loc.id'];

    for (const expr of mustBeEscaped) {
        it(`escapes \${${expr}}`, () => {
            const raw = new RegExp(`\\$\\{${expr.replace('.', '\\.')}\\}`);
            expect(SRC).not.toMatch(raw);
            expect(SRC).toContain(`esc(${expr})`);
        });
    }
});
