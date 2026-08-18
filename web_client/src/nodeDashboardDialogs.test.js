/**
 * Tests for the node dashboard's dialogs.js (node/public/dialogs.js).
 *
 * It lives here, in the web client's suite, because it needs a DOM and this is the repo's only jsdom
 * harness: node/ runs vitest too, but with the default `node` environment and no jsdom dependency,
 * and the dashboard has no build step to add one to. So the file is loaded as text and evaluated —
 * which is also exactly how the browser gets it, via a plain <script> tag.
 *
 * Worth covering despite the indirection: every destructive action on that dashboard now goes through
 * this one file, and a promise that never resolves would look like a dead button.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';

// Repo-relative so this resolves in either checkout.
const SRC = new URL('../../node/public/dialogs.js', import.meta.url);
const load = () => {
    document.body.innerHTML = '';
    delete window.Dialogs;
    delete window.Toast;
    // The IIFE assigns to `window` via `this`, as it does under a <script> tag.
    new Function(fs.readFileSync(SRC, 'utf8')).call(window);
};
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const key = (t, k) => t.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
const btns = () => [...document.querySelectorAll('.dlg-actions > button')];

describe('node dashboard dialogs.js', () => {
    beforeEach(load);

    it('confirm resolves true on the confirm button, false on cancel', async () => {
        let p = window.Dialogs.confirm({ title: 'T', message: 'M', confirmLabel: 'Go' });
        expect(document.querySelector('.dlg-title').textContent).toBe('T');
        click(btns().find((b) => b.textContent === 'Go'));
        expect(await p).toBe(true);
        expect(document.querySelector('.dlg-overlay')).toBeNull();  // cleaned up

        p = window.Dialogs.confirm({ message: 'M' });
        click(btns().find((b) => b.textContent === 'Cancel'));
        expect(await p).toBe(false);
    });

    it('marks the danger action with btn-danger and focuses Cancel, not the destructive button', async () => {
        const p = window.Dialogs.confirm({ message: 'M', confirmLabel: 'Delete', danger: true });
        expect(btns().find((b) => b.textContent === 'Delete').className).toBe('btn-danger');
        expect(document.activeElement.textContent).toBe('Cancel');
        key(document, 'Escape'); await p;
    });

    it('Escape and a backdrop click both cancel', async () => {
        let p = window.Dialogs.confirm({ message: 'M' });
        key(document, 'Escape');
        expect(await p).toBe(false);

        p = window.Dialogs.prompt({ label: 'L' });
        click(document.querySelector('.dlg-overlay'));
        expect(await p).toBeNull();
    });

    it('a click inside the panel does not dismiss', async () => {
        const p = window.Dialogs.confirm({ message: 'M' });
        click(document.querySelector('.dlg-message'));
        expect(document.querySelector('.dlg-overlay')).not.toBeNull();
        key(document, 'Escape'); await p;
    });

    it('prompt returns the typed value, trims it, and nulls an all-blank entry', async () => {
        let p = window.Dialogs.prompt({ label: 'Absolute path' });
        expect(document.activeElement.className).toBe('dlg-input');   // field, not a button
        document.querySelector('.dlg-input').value = '  /mnt/disk2  ';
        click(btns().find((b) => b.textContent === 'Save'));
        expect(await p).toBe('/mnt/disk2');

        p = window.Dialogs.prompt({ label: 'L' });
        document.querySelector('.dlg-input').value = '   ';
        click(btns().find((b) => b.textContent === 'Save'));
        expect(await p).toBeNull();
    });

    it('Enter in the field submits, as native prompt did', async () => {
        const p = window.Dialogs.prompt({ label: 'L', value: 'seed' });
        key(document.querySelector('.dlg-input'), 'Enter');
        expect(await p).toBe('seed');
    });

    it('resolves once when Escape and a button race', async () => {
        const p = window.Dialogs.confirm({ message: 'M' });
        const confirmBtn = btns()[1];     // held before dismissal; detached nodes still fire events
        key(document, 'Escape');
        click(confirmBtn);                // must not re-resolve the already-settled promise
        expect(await p).toBe(false);
        // And the keydown listener is gone, so a later Escape cannot touch a dead dialog.
        expect(document.querySelector('.dlg-overlay')).toBeNull();
    });

    it('toasts stack, carry a tone, auto-dismiss, and close on demand', () => {
        vi.useFakeTimers();
        window.Toast.error('boom'); window.Toast.success('ok'); window.Toast.info('fyi');
        const host = document.querySelector('.toast-host');
        expect(host.children).toHaveLength(3);
        expect(host.firstChild.className).toBe('toast toast-error');
        expect(host.firstChild.getAttribute('role')).toBe('alert');
        expect(host.children[1].getAttribute('role')).toBe('status');

        click(host.firstChild.querySelector('.toast-close'));
        expect(host.children).toHaveLength(2);
        vi.advanceTimersByTime(5000);
        expect(host.children).toHaveLength(0);
        vi.useRealTimers();
    });

    it('renders text, never markup, so a path or error message cannot inject', () => {
        window.Toast.error('<img src=x onerror=alert(1)>');
        const t = document.querySelector('.toast span');
        expect(t.querySelector('img')).toBeNull();
        expect(t.textContent).toBe('<img src=x onerror=alert(1)>');
    });
});
