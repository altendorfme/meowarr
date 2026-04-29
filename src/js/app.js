(function () {
    'use strict';

    function readJSON(id, fallback) {
        const el = document.getElementById(id);
        if (!el) return fallback;
        const txt = el.tagName === 'TEMPLATE'
            ? (el.content && el.content.textContent) || ''
            : el.textContent || '';
        try { return JSON.parse(txt); } catch { return fallback; }
    }

    const I18N = readJSON('i18n-data', {});
    function t(key) { return (key in I18N) ? I18N[key] : key; }
    function tFmt(key, params) {
        let s = t(key);
        if (params) {
            for (const k in params) s = s.replace('{' + k + '}', params[k]);
        }
        return s;
    }

    function findSubmitButton(form, submitter) {
        if (submitter && (submitter.type === 'submit' || submitter.tagName === 'BUTTON')) return submitter;
        return form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    }

    function applyLoading(btn) {
        if (!btn || btn.dataset.submitting === '1') return;
        btn.dataset.submitting = '1';
        const label = btn.querySelector('.btn-label');
        const loading = btn.querySelector('.btn-loading');
        if (label && loading) {
            label.classList.add('d-none');
            loading.classList.remove('d-none');
        } else {
            const txt = (btn.textContent || '').trim();
            const spinner = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
            btn.innerHTML = txt ? spinner + ' <span class="ms-1">' + txt + '</span>' : spinner;
        }
        btn.disabled = true;
    }

    document.addEventListener('submit', function (e) {
        const form = e.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (e.defaultPrevented) return;
        if (form.hasAttribute('data-job')) return;
        const msg = form.getAttribute('data-confirm');
        if (msg && !confirm(msg)) { e.preventDefault(); return; }
        if (form.dataset.noLoading === '1') return;
        const btn = findSubmitButton(form, e.submitter);
        if (!btn || btn.disabled) return;
        applyLoading(btn);
    });

    const JobBanner = (function () {
        const el = document.getElementById('job-banner');
        if (!el) return { update: () => {}, isBusy: () => false, getCurrent: () => null };
        let i18n = {};
        try { i18n = JSON.parse(el.dataset.i18n || '{}'); } catch { i18n = {}; }
        const labelEl = el.querySelector('[data-job-banner-label]');
        const statusEl = el.querySelector('[data-job-banner-status]');
        const currentEl = el.querySelector('[data-job-banner-current]');
        const doneEl = el.querySelector('[data-job-banner-done]');
        const totalEl = el.querySelector('[data-job-banner-total]');
        const barEl = el.querySelector('[data-job-banner-bar]');
        const cancelBtn = el.querySelector('[data-job-banner-cancel]');
        const cancelLabelEl = el.querySelector('[data-job-banner-cancel-label]');
        const subEl = el.querySelector('[data-job-banner-substep]');
        const spinnerEl = el.querySelector('[data-job-banner-spinner]');

        let pollTimer = null;
        let current = null;
        let lastStatus = null;
        const listeners = new Set();

        if (cancelLabelEl) cancelLabelEl.textContent = i18n.cancel || 'Cancel';

        cancelBtn.addEventListener('click', function () {
            if (!current || !current.cancellable) return;
            if (!confirm(i18n.confirmCancel || 'Cancel?')) return;
            cancelBtn.disabled = true;
            fetch('/api/jobs/' + current.id + '/cancel', {
                method: 'POST',
                headers: { 'Accept': 'application/json' },
                credentials: 'same-origin',
            }).catch(function () {}).finally(function () {
                cancelBtn.disabled = false;
                refresh();
            });
        });

        function stepLabel(step) {
            if (!step) return '';
            const key = 'step' + step.charAt(0).toUpperCase() + step.slice(1);
            return i18n[key] || step;
        }

        function statusLabel(status) {
            if (status === 'running') return i18n.running || 'Running';
            if (status === 'cancelling') return i18n.cancelling || 'Cancelling…';
            if (status === 'done') return i18n.done || 'Done';
            if (status === 'failed') return i18n.failed || 'Failed';
            if (status === 'cancelled') return i18n.cancelled || 'Cancelled';
            return status || '';
        }

        function applyState(state) {
            const newCurrent = state && state.current;
            const previous = current;
            current = newCurrent;

            if (!newCurrent) {
                if (previous && (previous.status === 'running' || previous.status === 'cancelling') && state.history && state.history[0]) {
                    showFinal(state.history[0]);
                } else if (!previous) {
                    el.classList.add('d-none');
                }
                lastStatus = null;
            } else {
                renderActive(newCurrent);
                lastStatus = newCurrent.status;
            }
            applyButtonsState();
            for (const fn of listeners) {
                try { fn(newCurrent, state); } catch (_) { /* noop */ }
            }
        }

        function renderActive(job) {
            el.classList.remove('d-none', 'app-job-banner-done', 'app-job-banner-failed');
            labelEl.textContent = job.label || job.type || '';
            statusEl.textContent = statusLabel(job.status);
            const counters = job.counters || {};
            const sub = (counters.subDone || 0) + ' / ' + (counters.subTotal || '…');
            const step = stepLabel(job.progress && job.progress.step);
            const cur = (job.progress && job.progress.current) || '';
            const parts = [];
            if (step) parts.push(step);
            if (cur) parts.push(cur);
            currentEl.textContent = parts.join(': ');
            doneEl.textContent = (job.progress && job.progress.done) || 0;
            totalEl.textContent = (job.progress && job.progress.total) || '…';
            const total = (job.progress && job.progress.total) || 0;
            const done = (job.progress && job.progress.done) || 0;
            const pct = total ? Math.round((done / total) * 100) : (job.status === 'running' ? 5 : 0);
            barEl.style.width = pct + '%';
            barEl.classList.add('progress-bar-animated');
            cancelBtn.classList.toggle('d-none', !job.cancellable || job.status === 'cancelling');
            cancelBtn.disabled = job.status === 'cancelling';
            if (spinnerEl) spinnerEl.classList.add('app-spin');
            if (subEl) {
                if (counters.subTotal) {
                    subEl.classList.remove('d-none');
                    subEl.textContent = sub + (step ? ' · ' + step : '');
                } else {
                    subEl.classList.add('d-none');
                }
            }
        }

        function showFinal(job) {
            el.classList.remove('d-none');
            el.classList.toggle('app-job-banner-failed', job.status === 'failed');
            el.classList.toggle('app-job-banner-done', job.status === 'done');
            labelEl.textContent = job.label || job.type || '';
            statusEl.textContent = statusLabel(job.status);
            const counters = job.counters || {};
            const summary = job.summary || {};
            const summaryBits = [];
            if (typeof summary.ok === 'number') summaryBits.push('✓ ' + summary.ok);
            if (typeof summary.failed === 'number' && summary.failed) summaryBits.push('✗ ' + summary.failed);
            currentEl.textContent = summaryBits.join(' · ') || (job.error || '');
            doneEl.textContent = (job.progress && job.progress.done) || (counters.subDone || 0);
            totalEl.textContent = (job.progress && job.progress.total) || (counters.subTotal || '');
            const total = (job.progress && job.progress.total) || 0;
            const done = (job.progress && job.progress.done) || 0;
            const pct = total ? Math.round((done / total) * 100) : 100;
            barEl.style.width = pct + '%';
            barEl.classList.remove('progress-bar-animated');
            cancelBtn.classList.add('d-none');
            if (spinnerEl) spinnerEl.classList.remove('app-spin');
            if (subEl) subEl.classList.add('d-none');
            setTimeout(function () {
                if (!current) el.classList.add('d-none');
            }, 6000);
        }

        function applyButtonsState() {
            const busy = !!current && (current.status === 'running' || current.status === 'cancelling');
            const buttons = document.querySelectorAll('[data-job-action]');
            buttons.forEach(function (btn) {
                if (busy) {
                    if (!btn.dataset.jobActionPrevTitle) btn.dataset.jobActionPrevTitle = btn.title || '';
                    btn.disabled = true;
                    btn.classList.add('disabled');
                    btn.title = i18n.busyTooltip || 'Job already running';
                } else {
                    btn.disabled = false;
                    btn.classList.remove('disabled');
                    if (btn.dataset.jobActionPrevTitle !== undefined) {
                        btn.title = btn.dataset.jobActionPrevTitle;
                        delete btn.dataset.jobActionPrevTitle;
                    }
                }
            });
        }

        async function refresh() {
            try {
                const r = await fetch('/api/jobs/current', {
                    cache: 'no-store',
                    credentials: 'same-origin',
                    headers: { 'Accept': 'application/json' },
                });
                if (!r.ok) return;
                const state = await r.json();
                applyState(state);
            } catch (_) { /* noop */ }
        }

        function startPolling(intervalMs) {
            stopPolling();
            const interval = intervalMs || 1500;
            pollTimer = setInterval(refresh, interval);
        }
        function stopPolling() {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }

        function isBusy() {
            return !!current && (current.status === 'running' || current.status === 'cancelling');
        }

        function getCurrent() { return current; }

        function onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        }

        refresh();
        startPolling(1500);
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) startPolling(5000);
            else { refresh(); startPolling(1500); }
        });

        return { refresh, isBusy, getCurrent, onChange, i18n };
    })();

    function setupJobForms() {
        document.addEventListener('submit', async function (e) {
            const form = e.target;
            if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-job')) return;
            if (e.defaultPrevented) return;
            e.preventDefault();
            const msg = form.getAttribute('data-confirm');
            if (msg && !confirm(msg)) return;
            if (JobBanner.isBusy()) {
                alert((JobBanner.i18n && JobBanner.i18n.busyTooltip) || 'Job already running');
                return;
            }
            try {
                const r = await fetch(form.action, {
                    method: form.method || 'POST',
                    headers: { 'Accept': 'application/json' },
                    credentials: 'same-origin',
                });
                if (r.status === 409) {
                    JobBanner.refresh();
                    return;
                }
                if (!r.ok) {
                    JobBanner.refresh();
                    return;
                }
                JobBanner.refresh();
            } catch (_) {
                JobBanner.refresh();
            }
        });
    }

    async function startClientJob(opts) {
        try {
            const r = await fetch('/api/jobs/client/start', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(opts || {}),
            });
            if (r.status === 409) return { ok: false, busy: true };
            if (!r.ok) return { ok: false };
            const data = await r.json();
            return { ok: true, job: data.job };
        } catch { return { ok: false }; }
    }
    async function heartbeatClientJob(id, payload) {
        try {
            const r = await fetch('/api/jobs/client/' + id + '/heartbeat', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(payload || {}),
            });
            if (!r.ok) return { ok: false };
            return await r.json();
        } catch { return { ok: false }; }
    }
    async function finishClientJob(id, payload) {
        try {
            await fetch('/api/jobs/client/' + id + '/finish', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(payload || {}),
            });
        } catch { /* noop */ }
    }

    function bindRulesEditor(opts) {
        const container = document.getElementById(opts.containerId);
        const tplRule = document.getElementById(opts.tplRuleId);
        const emptyHint = document.getElementById(opts.emptyHintId);
        if (!container || !tplRule) return null;

        function syncEmpty() {
            if (!emptyHint) return;
            emptyHint.style.display = container.querySelector('[data-rule]') ? 'none' : '';
        }

        function addRule(rule) {
            const node = tplRule.content.firstElementChild.cloneNode(true);
            node.querySelector('[data-field="field"]').value = (rule && rule.field) || opts.defaultField || 'display_name';
            node.querySelector('[data-field="operator"]').value = (rule && rule.operator) || 'contains';
            node.querySelector('[data-field="value"]').value = (rule && rule.value) || '';
            container.appendChild(node);
            syncEmpty();
            return node;
        }

        container.addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-action="delete-rule"]');
            if (!btn) return;
            btn.closest('[data-rule]').remove();
            syncEmpty();
        });

        return { addRule, syncEmpty };
    }

    function bindGroupedEditor(opts) {
        const container = document.getElementById(opts.containerId);
        const emptyHint = document.getElementById(opts.emptyHintId);
        const tplGroup = document.getElementById(opts.tplGroupId);
        const tplRule = document.getElementById(opts.tplRuleId);
        if (!container || !tplGroup || !tplRule) return null;

        function addRule(rulesEl, rule) {
            const node = tplRule.content.firstElementChild.cloneNode(true);
            node.querySelector('[data-field="field"]').value = (rule && rule.field) || opts.defaultField || 'display_name';
            node.querySelector('[data-field="operator"]').value = (rule && rule.operator) || 'contains';
            node.querySelector('[data-field="value"]').value = (rule && rule.value) || '';
            rulesEl.appendChild(node);
        }

        function renumber() {
            const items = container.querySelectorAll('[data-' + opts.itemAttr + ']');
            items.forEach(function (g, i) {
                const pos = g.querySelector('.' + opts.posClass);
                if (pos) pos.textContent = '#' + (i + 1);
            });
            if (emptyHint) emptyHint.style.display = items.length === 0 ? '' : 'none';
        }

        function addItem(data) {
            const node = tplGroup.content.firstElementChild.cloneNode(true);
            if (typeof opts.fillItem === 'function') opts.fillItem(node, data || {});
            const rulesEl = node.querySelector('[data-rules]');
            const rules = (data && data.rules) || [];
            if (rules.length === 0) addRule(rulesEl);
            else rules.forEach(function (r) { addRule(rulesEl, r); });
            container.appendChild(node);
            if (typeof opts.afterAdd === 'function') opts.afterAdd(node);
            renumber();
            return node;
        }

        container.addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const itemEl = btn.closest('[data-' + opts.itemAttr + ']');
            if (action === 'add-rule') {
                addRule(itemEl.querySelector('[data-rules]'));
            } else if (action === 'delete-rule') {
                btn.closest('[data-rule]').remove();
            } else if (action === opts.deleteItemAction) {
                if (confirm(opts.confirmDelete || t('confirmDelete'))) { itemEl.remove(); renumber(); }
            } else if (action === 'up') {
                const prev = itemEl.previousElementSibling;
                if (prev && prev.matches('[data-' + opts.itemAttr + ']')) { container.insertBefore(itemEl, prev); renumber(); }
            } else if (action === 'down') {
                const next = itemEl.nextElementSibling;
                if (next && next.matches('[data-' + opts.itemAttr + ']')) { container.insertBefore(next, itemEl); renumber(); }
            }
        });

        if (typeof opts.onChange === 'function') container.addEventListener('change', opts.onChange);
        if (typeof opts.onInput === 'function') container.addEventListener('input', opts.onInput);

        return { addItem, renumber };
    }

    function setupReplacementsEditor() {
        const container = document.getElementById('replacements-container');
        const tpl = document.getElementById('tpl-replacement');
        const emptyHint = document.getElementById('replacements-empty-hint');
        if (!container || !tpl) return;

        function syncEmpty() {
            if (!emptyHint) return;
            emptyHint.style.display = container.querySelector('[data-replacement]') ? 'none' : '';
        }

        function addReplacement(data) {
            const node = tpl.content.firstElementChild.cloneNode(true);
            node.querySelector('[data-field="field"]').value = (data && data.field) || 'display_name';
            node.querySelector('[data-field="find"]').value = (data && data.find) || '';
            node.querySelector('[data-field="replace"]').value = (data && data.replace) || '';
            const cb = node.querySelector('[data-field="is_regex"]');
            cb.checked = !!(data && data.is_regex);
            const cbId = 'rgx-' + Math.random().toString(36).slice(2, 8);
            cb.id = cbId;
            const lbl = node.querySelector('[data-regex-label]');
            if (lbl) lbl.setAttribute('for', cbId);
            container.appendChild(node);
            syncEmpty();
            return node;
        }

        container.addEventListener('click', function (e) {
            const btn = e.target.closest('button[data-action="delete-replacement"]');
            if (!btn) return;
            if (!confirm(t('confirmDeleteReplacement'))) return;
            btn.closest('[data-replacement]').remove();
            syncEmpty();
        });

        const addBtn = document.getElementById('add-replacement');
        if (addBtn) addBtn.addEventListener('click', function () { addReplacement(); });

        const form = document.getElementById('list-form');
        if (form) {
            form.addEventListener('submit', function () {
                const payload = [];
                container.querySelectorAll('[data-replacement]').forEach(function (r) {
                    const find = r.querySelector('[data-field="find"]').value;
                    if (!find) return;
                    payload.push({
                        field: r.querySelector('[data-field="field"]').value,
                        find,
                        replace: r.querySelector('[data-field="replace"]').value,
                        is_regex: r.querySelector('[data-field="is_regex"]').checked ? 1 : 0,
                    });
                });
                document.getElementById('replacements_json').value = JSON.stringify(payload);
            });
        }

        const initial = readJSON('initial-replacements', []);
        initial.forEach(function (data) { addReplacement(data); });
        syncEmpty();
    }

    function setupListEditor() {
        setupReplacementsEditor();
        function syncIncludeFields(groupEl) {
            const action = groupEl.querySelector('[data-field="action"]').value;
            const nameWrap = groupEl.querySelector('[data-group-name-wrap]');
            const qualityWrap = groupEl.querySelector('[data-quality-wrap]');
            const nameInput = nameWrap.querySelector('[data-field="group_name"]');
            const qualityInput = qualityWrap.querySelector('[data-field="append_quality"]');
            const include = action === 'include';
            nameWrap.style.display = include ? '' : 'none';
            qualityWrap.style.display = include ? '' : 'none';
            nameInput.disabled = !include;
            qualityInput.disabled = !include;
            if (!include) { nameInput.value = ''; qualityInput.checked = false; }
        }

        const editor = bindGroupedEditor({
            containerId: 'groups-container',
            emptyHintId: 'empty-hint',
            tplGroupId: 'tpl-group',
            tplRuleId: 'tpl-rule',
            itemAttr: 'group',
            posClass: 'group-pos',
            deleteItemAction: 'delete-group',
            confirmDelete: t('confirmDeleteGroup'),
            fillItem: function (node, data) {
                node.querySelector('[data-field="action"]').value = data.action || 'include';
                node.querySelector('[data-field="combinator"]').value = data.combinator || 'OR';
                node.querySelector('[data-field="group_name"]').value = data.group_name || '';
                const aq = node.querySelector('[data-field="append_quality"]');
                aq.checked = !!data.append_quality;
                const aqId = 'aq-' + Math.random().toString(36).slice(2, 8);
                aq.id = aqId;
                const lbl = node.querySelector('[data-quality-label]');
                if (lbl) lbl.setAttribute('for', aqId);
            },
            afterAdd: function (node) { syncIncludeFields(node); },
            onChange: function (e) {
                if (e.target.matches('[data-field="action"]')) syncIncludeFields(e.target.closest('[data-group]'));
            },
        });
        if (!editor) return;

        const addBtn = document.getElementById('add-group');
        if (addBtn) addBtn.addEventListener('click', function () { editor.addItem(); });

        const form = document.getElementById('list-form');
        if (form) {
            form.addEventListener('submit', function () {
                const payload = [];
                document.querySelectorAll('#groups-container [data-group]').forEach(function (g) {
                    const rules = [];
                    g.querySelectorAll('[data-rule]').forEach(function (r) {
                        const value = r.querySelector('[data-field="value"]').value.trim();
                        if (!value) return;
                        rules.push({
                            field: r.querySelector('[data-field="field"]').value,
                            operator: r.querySelector('[data-field="operator"]').value,
                            value,
                        });
                    });
                    const action = g.querySelector('[data-field="action"]').value;
                    const groupNameInput = g.querySelector('[data-field="group_name"]');
                    const qualityInput = g.querySelector('[data-field="append_quality"]');
                    const groupName = (action === 'include' && groupNameInput) ? groupNameInput.value.trim() : '';
                    const appendQuality = (action === 'include' && qualityInput && qualityInput.checked) ? 1 : 0;
                    payload.push({
                        action,
                        combinator: g.querySelector('[data-field="combinator"]').value,
                        group_name: groupName,
                        append_quality: appendQuality,
                        rules,
                    });
                });
                document.getElementById('groups_json').value = JSON.stringify(payload);
            });
        }

        const initial = readJSON('initial-state', []);
        initial.forEach(function (data) { editor.addItem(data); });
        if (initial.length === 0 && document.getElementById('empty-hint')) {
            document.getElementById('empty-hint').style.display = '';
        }
    }

    function setupEpgPriorities() {
        const root = document.querySelector('[data-page="epg-priorities"]');
        const epgId = root ? root.dataset.epgId : null;
        const datalist = document.getElementById('epg-channels-datalist');
        let datalistTimer = null;
        function loadDatalist(q) {
            if (!datalist || !epgId) return;
            clearTimeout(datalistTimer);
            datalistTimer = setTimeout(function () {
                fetch('/epgs/' + epgId + '/priorities/channels.json?q=' + encodeURIComponent(q || ''))
                    .then(function (r) { return r.ok ? r.json() : []; })
                    .then(function (rows) {
                        datalist.innerHTML = '';
                        for (let i = 0; i < rows.length; i++) {
                            const r = rows[i];
                            const opt = document.createElement('option');
                            opt.value = r.tvg_id;
                            opt.label = r.display_name ? (r.tvg_id + ' - ' + r.display_name) : r.tvg_id;
                            datalist.appendChild(opt);
                        }
                    })
                    .catch(function () { });
            }, 200);
        }

        const editor = bindGroupedEditor({
            containerId: 'priorities-container',
            emptyHintId: 'empty-hint',
            tplGroupId: 'tpl-priority',
            tplRuleId: 'tpl-rule',
            itemAttr: 'priority',
            posClass: 'pri-pos',
            deleteItemAction: 'delete-priority',
            confirmDelete: t('confirmDeletePriority'),
            fillItem: function (node, data) {
                node.querySelector('[data-field="tvg_id"]').value = data.tvg_id || '';
                node.querySelector('[data-field="display_name"]').value = data.display_name || '';
                node.querySelector('[data-field="combinator"]').value = data.combinator || 'AND';
            },
            onInput: function (e) {
                if (e.target.matches('[data-field="tvg_id"]')) loadDatalist(e.target.value);
            },
        });
        if (!editor) return;

        loadDatalist('');

        const addBtn = document.getElementById('add-priority');
        if (addBtn) addBtn.addEventListener('click', function () { editor.addItem(); });

        const form = document.getElementById('pri-form');
        if (form) {
            form.addEventListener('submit', function () {
                const payload = [];
                document.querySelectorAll('#priorities-container [data-priority]').forEach(function (p) {
                    const rules = [];
                    p.querySelectorAll('[data-rule]').forEach(function (r) {
                        const value = r.querySelector('[data-field="value"]').value.trim();
                        if (!value) return;
                        rules.push({
                            field: r.querySelector('[data-field="field"]').value,
                            operator: r.querySelector('[data-field="operator"]').value,
                            value,
                        });
                    });
                    payload.push({
                        tvg_id: p.querySelector('[data-field="tvg_id"]').value.trim(),
                        display_name: p.querySelector('[data-field="display_name"]').value.trim(),
                        combinator: p.querySelector('[data-field="combinator"]').value,
                        rules,
                    });
                });
                document.getElementById('priorities_json').value = JSON.stringify(payload);
            });
        }

        const initial = readJSON('initial-state', []);
        initial.forEach(function (data) { editor.addItem(data); });
        if (initial.length === 0 && document.getElementById('empty-hint')) {
            document.getElementById('empty-hint').style.display = '';
        }
    }

    function setupImageEditor() {
        const rulesEditor = bindRulesEditor({
            containerId: 'rules-container',
            tplRuleId: 'tpl-rule',
            emptyHintId: 'empty-hint',
            defaultField: 'display_name',
        });
        if (!rulesEditor) return;

        const addBtn = document.getElementById('add-rule');
        if (addBtn) addBtn.addEventListener('click', function () { rulesEditor.addRule(); });

        function bindPreview(inputId, imgId, emptyId) {
            const inp = document.getElementById(inputId);
            const img = document.getElementById(imgId);
            const empty = document.getElementById(emptyId);
            if (!inp || !img || !empty) return;
            inp.addEventListener('input', function () {
                const v = inp.value.trim();
                if (v) { img.src = v; img.style.display = ''; empty.style.display = 'none'; }
                else { img.style.display = 'none'; empty.style.display = ''; }
            });
        }
        bindPreview('source_url', 'preview-source', 'preview-source-empty');
        bindPreview('target_url', 'preview-target', 'preview-target-empty');

        const form = document.getElementById('image-form');
        if (form) {
            form.addEventListener('submit', function () {
                const payload = [];
                document.querySelectorAll('#rules-container [data-rule]').forEach(function (r) {
                    const value = r.querySelector('[data-field="value"]').value.trim();
                    if (!value) return;
                    payload.push({
                        field: r.querySelector('[data-field="field"]').value,
                        operator: r.querySelector('[data-field="operator"]').value,
                        value,
                    });
                });
                document.getElementById('rules_json').value = JSON.stringify(payload);
            });
        }

        const initial = readJSON('initial-rules', []);
        initial.forEach(function (r) { rulesEditor.addRule(r); });
    }

    async function runConcurrentClientJob(opts) {
        if (JobBanner.isBusy()) return;
        let urls = [];
        try {
            const r = await fetch(opts.urlsEndpoint);
            const data = await r.json();
            urls = Array.isArray(data.urls) ? data.urls : [];
        } catch {
            alert(t('testFailLoad'));
            return;
        }
        if (urls.length === 0) { alert(t('testNone')); return; }

        const start = await startClientJob({
            type: opts.jobType,
            label: t('testJobLabel'),
            total: urls.length,
        });
        if (!start.ok) { JobBanner.refresh(); return; }
        const jobId = start.job.id;

        let cancelled = false;
        const offChange = JobBanner.onChange(function (cur) {
            if (!cur || cur.id !== jobId) return;
            if (cur.status === 'cancelling') cancelled = true;
        });

        let done = 0, broken = 0, ok = 0, idx = 0;
        const concurrency = opts.concurrency || 6;
        async function worker() {
            while (idx < urls.length && !cancelled) {
                const url = urls[idx++];
                const isBroken = !!(await opts.checkOne(url));
                if (opts.onResult) opts.onResult(url, isBroken);
                done++;
                if (isBroken) broken++; else ok++;
                if (done % 5 === 0 || done === urls.length) {
                    const hb = await heartbeatClientJob(jobId, {
                        done, total: urls.length,
                        current: url, step: opts.step,
                        counters: { ok, broken },
                    });
                    if (hb && hb.cancelRequested) cancelled = true;
                }
            }
        }
        const workers = [];
        for (let i = 0; i < Math.min(concurrency, urls.length); i++) workers.push(worker());
        await Promise.all(workers);

        offChange();
        if (opts.afterDone) await opts.afterDone();
        await finishClientJob(jobId, {
            done, total: urls.length,
            cancelled,
            summary: { ok, failed: broken },
            counters: { ok, broken },
        });
        JobBanner.refresh();
    }

    function setupImagesTester() {
        const btn = document.getElementById('test-btn');
        if (!btn) return;

        function checkOne(url) {
            return new Promise(function (resolve) {
                const img = new Image();
                let settled = false;
                const finish = function (broken) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    fetch('/images/check', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url, broken: broken ? 1 : 0 }),
                    }).catch(function () { }).finally(function () { resolve(broken); });
                };
                img.onload = function () { finish(img.naturalWidth === 0 || img.naturalHeight === 0); };
                img.onerror = function () { finish(true); };
                const timer = setTimeout(function () { finish(true); }, 2000);
                img.referrerPolicy = 'no-referrer';
                img.src = url;
            });
        }

        function updateBadge(url, broken) {
            document.querySelectorAll('.js-image-card').forEach(function (card) {
                if (card.dataset.url !== url) return;
                const wrap = card.querySelector('.js-status-badge');
                if (wrap) wrap.innerHTML = broken
                    ? '<span class="badge bg-danger"><i class="bi bi-exclamation-triangle"></i> ' + t('broken') + '</span>'
                    : '<span class="badge bg-success-subtle text-success-emphasis"><i class="bi bi-check2-circle"></i> ' + t('ok') + '</span>';
                const inner = card.querySelector('.border');
                if (inner) inner.classList.toggle('border-danger', broken);
                const img = card.querySelector('.js-test-img');
                if (img) img.style.opacity = broken ? '.3' : '';
            });
        }

        btn.addEventListener('click', function () {
            return runConcurrentClientJob({
                urlsEndpoint: '/images/check/all.json',
                jobType: 'test-images',
                step: 'checkImages',
                concurrency: 6,
                checkOne,
                onResult: updateBadge,
            });
        });
    }

    function setupListChannelsPage() {
        const data = readJSON('i18n-data', {}) || {};
        const listId = data.listId;
        if (!listId) return;
        setupListUrlTester(listId, data.listName || '');
        setupToggleBroken(listId);
    }

    function postCheck(listId, url, broken) {
        return fetch('/lists/' + listId + '/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, broken: broken ? 1 : 0 }),
        }).catch(function () { });
    }

    function postRewrite(listId) {
        return fetch('/lists/' + listId + '/check/rewrite', { method: 'POST' }).catch(function () { });
    }

    function isMixedContent(url) {
        return location.protocol === 'https:' && /^http:\/\//i.test(url);
    }

    function checkUrl(url, timeoutMs) {
        return new Promise(function (resolve) {
            const ctrl = new AbortController();
            let settled = false;
            const finish = function (broken) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ctrl.abort(); } catch (_) { }
                resolve(broken);
            };
            const timer = setTimeout(function () { finish(true); }, timeoutMs || 6000);
            if (isMixedContent(url)) {
                fetch('/proxy/check?url=' + encodeURIComponent(url), { signal: ctrl.signal, cache: 'no-store' })
                    .then(function (r) { return r.json(); })
                    .then(function (d) { finish(!!(d && d.broken)); })
                    .catch(function () { finish(true); });
                return;
            }
            fetch(url, { method: 'GET', mode: 'no-cors', signal: ctrl.signal, redirect: 'follow', cache: 'no-store' })
                .then(function () { finish(false); })
                .catch(function () { finish(true); });
        });
    }

    function updateRowStatus(row, broken) {
        if (!row) return;
        row.classList.toggle('table-danger', !!broken);
        const cell = row.querySelector('.js-status-cell');
        if (cell) {
            cell.innerHTML = broken
                ? '<span class="badge bg-danger" title="' + t('broken') + '"><i class="bi bi-exclamation-triangle"></i></span>'
                : '<span class="badge bg-success-subtle text-success-emphasis" title="' + t('live') + '"><i class="bi bi-check2-circle"></i></span>';
        }
        const toggle = row.querySelector('.js-toggle-broken');
        if (toggle) {
            toggle.classList.toggle('btn-outline-danger', !broken);
            toggle.classList.toggle('btn-outline-success', !!broken);
            toggle.title = broken ? t('reactivate') : t('markBroken');
            toggle.innerHTML = broken
                ? '<i class="bi bi-arrow-counterclockwise"></i>'
                : '<i class="bi bi-x-circle"></i>';
        }
    }

    function setupListUrlTester(listId) {
        const btn = document.getElementById('url-test-btn');
        if (!btn) return;

        btn.addEventListener('click', function () {
            const rowsByUrl = new Map();
            document.querySelectorAll('.js-channel-row').forEach(function (r) {
                const u = r.dataset.url;
                if (!u) return;
                if (!rowsByUrl.has(u)) rowsByUrl.set(u, []);
                rowsByUrl.get(u).push(r);
            });

            return runConcurrentClientJob({
                urlsEndpoint: '/lists/' + listId + '/check/all.json',
                jobType: 'test-list-urls:' + listId,
                step: 'checkUrls',
                concurrency: 8,
                checkOne: async function (url) {
                    const isBroken = await checkUrl(url, 6000);
                    await postCheck(listId, url, isBroken ? 1 : 0);
                    return isBroken;
                },
                onResult: function (url, isBroken) {
                    (rowsByUrl.get(url) || []).forEach(function (r) { updateRowStatus(r, isBroken); });
                },
                afterDone: function () { return postRewrite(listId); },
            });
        });
    }

    function setupToggleBroken(listId) {
        document.addEventListener('click', async function (e) {
            const btn = e.target.closest('.js-toggle-broken');
            if (!btn) return;
            const row = btn.closest('.js-channel-row');
            if (!row) return;
            const url = row.dataset.url;
            if (!url) return;
            const isBroken = row.classList.contains('table-danger');
            const newBroken = isBroken ? 0 : 1;
            btn.disabled = true;
            await postCheck(listId, url, newBroken);
            updateRowStatus(row, !!newBroken);
            btn.disabled = false;
            postRewrite(listId);
        });
    }

    function setupCopyUrlCells() {
        const cells = document.querySelectorAll('.js-copy-url');
        if (!cells.length) return;

        function copy(el) {
            const value = el.value != null ? el.value : el.textContent;
            const fallback = function () {
                try {
                    el.removeAttribute('readonly');
                    el.select();
                    document.execCommand('copy');
                    el.setAttribute('readonly', '');
                } catch (_) { }
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(value).catch(fallback);
            } else {
                fallback();
            }
            el.classList.add('is-copied');
            clearTimeout(el._copyTimer);
            el._copyTimer = setTimeout(function () { el.classList.remove('is-copied'); }, 800);
        }

        cells.forEach(function (el) {
            el.addEventListener('focus', function () { el.select(); copy(el); });
            el.addEventListener('click', function () { el.select(); copy(el); });
        });
    }

    function setupSubmitOnChange() {
        document.addEventListener('change', function (e) {
            const el = e.target;
            if (!el || !el.matches || !el.matches('[data-submit-on-change]')) return;
            const form = el.form || el.closest('form');
            if (form) form.submit();
        });
    }

    function setupImageErrorHandlers() {
        function bind(el) {
            if (el.dataset.onerrorBound === '1') return;
            el.dataset.onerrorBound = '1';
            el.addEventListener('error', function () {
                if (el.hasAttribute('data-onerror-fade')) el.style.opacity = '.2';
                if (el.hasAttribute('data-onerror-broken')) el.classList.add('is-broken');
            });
        }
        document.querySelectorAll('[data-onerror-fade], [data-onerror-broken]').forEach(bind);
        const mo = new MutationObserver(function (mutations) {
            for (const m of mutations) {
                m.addedNodes && m.addedNodes.forEach(function (n) {
                    if (n.nodeType !== 1) return;
                    if (n.matches && (n.matches('[data-onerror-fade]') || n.matches('[data-onerror-broken]'))) bind(n);
                    if (n.querySelectorAll) n.querySelectorAll('[data-onerror-fade], [data-onerror-broken]').forEach(bind);
                });
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    document.addEventListener('DOMContentLoaded', function () {
        const page = document.body.dataset.page;
        if (page === 'list-edit') setupListEditor();
        else if (page === 'epg-priorities') setupEpgPriorities();
        else if (page === 'image-edit') setupImageEditor();
        else if (page === 'images') setupImagesTester();
        else if (page === 'list-channels') setupListChannelsPage();
        setupJobForms();
        setupCopyUrlCells();
        setupSubmitOnChange();
        setupImageErrorHandlers();
    });
})();
