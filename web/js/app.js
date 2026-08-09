import { nui } from '/nui/nui.js';

/* --- Global data-action handlers (shell-level) --- */
document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    const actionSpec = actionEl.dataset.action;
    const [actionPart] = actionSpec.split('@');
    const [action, param] = actionPart.split(':');

    switch (action) {
        case 'toggle-sidebar': {
            const app = document.querySelector('nui-app');
            if (app?.toggleSidebar) app.toggleSidebar(param || 'left');
            break;
        }
        case 'toggle-theme': {
            const current = document.documentElement.style.colorScheme || 'light';
            document.documentElement.style.colorScheme = current === 'dark' ? 'light' : 'dark';
            break;
        }
    }
});

/* --- Shared engine state (used by pages via window.nvoice) --- */
const nvoice = {
    activeEngine: null,
    engines: [],
    version: null,
};
window.nvoice = nvoice;

async function loadStatus() {
    const res = await fetch('/v1/admin/status');
    if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
    const data = await res.json();
    nvoice.activeEngine = data.active_engine;
    nvoice.version = data.version;
}

async function loadEngines() {
    const res = await fetch('/v1/admin/engines');
    if (!res.ok) throw new Error(`engines: HTTP ${res.status}`);
    const data = await res.json();
    nvoice.engines = data.engines || [];
}

/* --- Engine switcher (header) --- */

function engineType(e) {
    if (e.cloud) return 'cloud';
    if (e.gpu) return 'gpu';
    return 'cpu';
}

function setBusy(active) {
    const loader = document.getElementById('engine-busy');
    if (loader) loader.classList.toggle('active', active);
}

async function switchEngine(engineName) {
    if (!engineName || engineName === nvoice.activeEngine) return;

    const switcher = document.getElementById('engine-switcher');
    if (switcher?.disable) switcher.disable();
    setBusy(true);

    try {
        const res = await fetch('/v1/admin/engine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: engineName }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }

        // SSE progress stream — last stage wins; engine is active when stream closes
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = JSON.parse(line.slice(6));
                if (data.stage === 'error') throw new Error(data.message || 'Engine switch failed');
            }
        }

        nvoice.activeEngine = engineName;
        nui.components.banner.show({
            content: `Engine active: ${engineName}`,
            placement: 'bottom', priority: 'info', autoClose: 3000,
        });
    } catch (err) {
        nui.components.banner.show({
            content: `Engine switch failed: ${err.message}`,
            placement: 'bottom', priority: 'danger', autoClose: 6000,
        });
        syncSwitcher();
    } finally {
        setBusy(false);
        if (switcher?.enable) switcher.enable();
    }
}

function syncSwitcher() {
    const switcher = document.getElementById('engine-switcher');
    if (!switcher) return;
    if (switcher.getValue?.() === nvoice.activeEngine) return;
    switcher.setValue?.(nvoice.activeEngine);
}

function initEngineSwitcher() {
    const switcher = document.getElementById('engine-switcher');
    if (!switcher) return;

    customElements.whenDefined('nui-select').then(() => {
        // Remove the "Loading engines..." placeholder BEFORE setItems — nui-select
        // captures placeholder text at setup and re-renders it from the option,
        // so it must be gone before the data load or it lingers on the trigger.
        const placeholderOpt = switcher.querySelector('option[value=""]');
        if (placeholderOpt) placeholderOpt.remove();
        switcher.setItems(nvoice.engines.map(e => ({ label: e.name, value: e.name })));
        // Tag each option (and its rendered dropdown row) with the engine type
        // so CSS can color the indicator dot. setItems rebuilds from the select's
        // children, so this must run after setItems.
        const byName = Object.fromEntries(nvoice.engines.map(e => [e.name, engineType(e)]));
        switcher.querySelectorAll('option').forEach(opt => {
            const type = byName[opt.value];
            if (type) opt.dataset.type = type;
        });
        switcher.querySelectorAll('.nui-select-option').forEach(row => {
            const type = byName[row.dataset.value];
            if (type) row.dataset.type = type;
        });
        syncSwitcher();
    });

    switcher.addEventListener('nui-change', (e) => {
        const values = e.detail?.values || [];
        if (values[0]) switchEngine(values[0]);
    });
}

/* --- Sidebar navigation --- */

const NAV = [
    { label: 'Home', href: '#page=home', icon: 'public' },
    { label: 'Batch', href: '#page=batch', icon: 'volume' },
    { label: 'Archive', href: '#page=archive', icon: 'headphones' },
    { label: 'Realtime', href: '#page=realtime', icon: 'mic' },
    { label: 'Assistant', href: '#page=assistant', icon: 'mic' },
];

function initNav() {
    customElements.whenDefined('nui-link-list').then(() => {
        const sideNav = document.getElementById('main-navigation');
        if (sideNav?.loadData) sideNav.loadData(NAV);
    });
}

/* --- Boot --- */

async function boot() {
    try {
        await Promise.all([loadStatus(), loadEngines()]);
    } catch (err) {
        nui.components.banner.show({
            content: `Server unreachable: ${err.message}`,
            placement: 'bottom', priority: 'danger',
        });
    }
    initEngineSwitcher();
    initNav();
}

boot();

nui.setupRouter({
    container: 'nui-content nui-main',
    navigation: 'nui-sidebar#nav-sidebar',
    basePath: '/pages',
    defaultPage: 'home',
});
