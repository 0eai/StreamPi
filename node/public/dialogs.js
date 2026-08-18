/**
 * Confirm / prompt / toast for the node dashboard.
 *
 * The main web client got the same thing as React providers (web_client/src/components/ui/), but
 * this dashboard is hand-rolled vanilla JS served straight off disk with no build step and no
 * framework, so it needs its own — deliberately small, and deliberately the same shapes so the two
 * behave alike:
 *
 *   await Dialogs.confirm({ title, message, confirmLabel, danger })  -> boolean
 *   await Dialogs.prompt({ title, label, value, placeholder })       -> string | null
 *   Toast.error(msg) / Toast.success(msg) / Toast.info(msg)
 *
 * Promise-based for the same reason: every call site was written around synchronous
 * confirm()/prompt(), so `if (!await Dialogs.confirm(...)) return` keeps the existing control flow
 * intact instead of turning each handler inside-out.
 *
 * NOTE: this file is a service-worker shell asset. Adding or changing it means bumping CACHE_NAME in
 * sw.js, or clients with a warm cache keep the old copy.
 */
(function () {
    const TOAST_MS = 5000;

    // One container, created on first use rather than at load: this file is loaded on every page
    // view, and most never raise a notice.
    let toastHost = null;
    const ensureToastHost = () => {
        if (!toastHost) {
            toastHost = document.createElement('div');
            toastHost.className = 'toast-host';
            document.body.appendChild(toastHost);
        }
        return toastHost;
    };

    const pushToast = (tone, message) => {
        if (!message) return;
        const el = document.createElement('div');
        el.className = `toast toast-${tone}`;
        el.setAttribute('role', tone === 'error' ? 'alert' : 'status');

        const text = document.createElement('span');
        text.textContent = String(message);
        el.appendChild(text);

        const close = document.createElement('button');
        close.className = 'toast-close';
        close.setAttribute('aria-label', 'Dismiss');
        close.textContent = '×';
        const remove = () => el.remove();
        close.addEventListener('click', remove);
        el.appendChild(close);

        ensureToastHost().appendChild(el);
        setTimeout(remove, TOAST_MS);
    };

    /**
     * Builds a modal and resolves once the user answers. `cancelValue` is what dismissing produces —
     * false for a confirm, null for a prompt — matching what the native versions returned so callers'
     * existing falsy checks keep working.
     */
    const openModal = ({ title, body, buttons, cancelValue, focusSelector }) => new Promise((resolve) => {
        const previouslyFocused = document.activeElement;
        const overlay = document.createElement('div');
        overlay.className = 'dlg-overlay';

        const panel = document.createElement('div');
        panel.className = 'dlg-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        if (title) panel.setAttribute('aria-label', title);

        if (title) {
            const h = document.createElement('h3');
            h.className = 'dlg-title';
            h.textContent = title;
            panel.appendChild(h);
        }
        if (body) panel.appendChild(body);

        const row = document.createElement('div');
        row.className = 'dlg-actions';
        panel.appendChild(row);

        let settled = false;
        const settle = (value) => {
            if (settled) return;               // Escape and a click can both fire for one dismissal.
            settled = true;
            document.removeEventListener('keydown', onKeyDown);
            overlay.remove();
            previouslyFocused?.focus?.();
            resolve(value);
        };

        const onKeyDown = (e) => {
            if (e.key === 'Escape') settle(cancelValue);
        };
        document.addEventListener('keydown', onKeyDown);

        // Clicking the backdrop dismisses, but only the backdrop itself — not a click that started
        // inside the panel and happened to end up bubbling here.
        overlay.addEventListener('click', (e) => { if (e.target === overlay) settle(cancelValue); });

        buttons.forEach((b) => {
            const btn = document.createElement('button');
            btn.className = b.className;
            btn.textContent = b.label;
            btn.addEventListener('click', () => settle(b.value()));
            row.appendChild(btn);
        });

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        // Focus the safe choice (the first button, always Cancel) unless a field asked for it, so a
        // stray Enter on a destructive prompt does nothing.
        (focusSelector ? panel.querySelector(focusSelector) : row.firstElementChild)?.focus();
    });

    const confirm = (arg) => {
        const spec = typeof arg === 'string' ? { message: arg } : (arg || {});
        const body = document.createElement('p');
        body.className = 'dlg-message';
        body.textContent = spec.message || '';
        return openModal({
            title: spec.title || 'Are you sure?',
            body: spec.message ? body : null,
            cancelValue: false,
            buttons: [
                { label: spec.cancelLabel || 'Cancel', className: 'btn-ghost', value: () => false },
                { label: spec.confirmLabel || 'Confirm', className: spec.danger ? 'btn-danger' : 'btn-primary', value: () => true },
            ],
        });
    };

    const prompt = (arg) => {
        const spec = typeof arg === 'string' ? { label: arg } : (arg || {});
        const wrap = document.createElement('div');

        if (spec.message) {
            const p = document.createElement('p');
            p.className = 'dlg-message';
            p.textContent = spec.message;
            wrap.appendChild(p);
        }
        if (spec.label) {
            const lab = document.createElement('label');
            lab.className = 'dlg-label';
            lab.textContent = spec.label;
            wrap.appendChild(lab);
        }
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'dlg-input';
        input.value = spec.value || '';
        if (spec.placeholder) input.placeholder = spec.placeholder;
        wrap.appendChild(input);

        const promise = openModal({
            title: spec.title || spec.label || 'Enter a value',
            body: wrap,
            cancelValue: null,
            focusSelector: '.dlg-input',
            buttons: [
                { label: 'Cancel', className: 'btn-ghost', value: () => null },
                { label: spec.confirmLabel || 'Save', className: 'btn-primary', value: () => input.value.trim() || null },
            ],
        });

        // Enter submits, which native prompt did for free.
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            wrap.closest('.dlg-panel')?.querySelector('.dlg-actions')?.lastElementChild?.click();
        });

        return promise;
    };

    window.Dialogs = { confirm, prompt };
    window.Toast = {
        error: (m) => pushToast('error', m),
        success: (m) => pushToast('success', m),
        info: (m) => pushToast('info', m),
    };
})();
