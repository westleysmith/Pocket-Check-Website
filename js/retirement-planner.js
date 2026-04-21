/*
 * Retirement Planner - UI logic for retirement-planner.html.
 *
 * State lives in a single object. On input events we mutate state and
 * persist to localStorage. The Monte Carlo run is triggered by the
 * "Run projection" button; results are rendered via Plotly.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'pc_retirement_planner_state_v1';

    // Return outlook: the MEAN real return per asset class. Std dev
    // and stock/bond correlation stay at historical values regardless
    // - only the mean shifts. "Historical" matches the last century of
    // US data; "Forward-looking" is the consensus of current
    // professional forecasts (Vanguard VCMM, Research Affiliates, GMO)
    // given today's valuations; "Cautious" models a permanently
    // lower-return regime.
    const RETURN_OUTLOOK_PRESETS = {
        Optimistic: {
            stocks: 0.090, bonds: 0.030, cash: 0.010,
            description: "What Dave Ramsey famously claims (roughly 12% nominal / 9% real for stocks). Controversial and widely considered unrealistic by professional planners, but if you want to see what the \"good growth stock mutual funds\" pitch produces, here you go.",
        },
        Historical: {
            stocks: 0.068, bonds: 0.020, cash: 0.003,
            description: "20th-century US historical averages. What the last 100 years delivered. A reasonable middle ground, though arguably optimistic given today's valuations.",
        },
        'Forward-looking': {
            stocks: 0.045, bonds: 0.020, cash: 0.003,
            description: "Consensus of professional forward forecasts (Vanguard VCMM, Research Affiliates, GMO) given current market valuations. What most retirement planners use.",
        },
        Cautious: {
            stocks: 0.030, bonds: 0.010, cash: 0.000,
            description: "If forward returns disappoint and the next few decades look more like Japan since 1990 or the US in the 2000s.",
        },
    };

    const RISK_PRESETS = {
        Conservative: {
            now:        { stocks: 0.50, bonds: 0.45, cash: 0.05 },
            retirement: { stocks: 0.30, bonds: 0.65, cash: 0.05 },
            description: 'Lower volatility, bond-heavy. Prioritizes capital preservation over growth.',
        },
        Balanced: {
            now:        { stocks: 0.80, bonds: 0.15, cash: 0.05 },
            retirement: { stocks: 0.55, bonds: 0.40, cash: 0.05 },
            description: 'Industry-standard target-date glide path. A reasonable default for most people.',
        },
        Aggressive: {
            now:        { stocks: 0.95, bonds: 0.04, cash: 0.01 },
            retirement: { stocks: 0.70, bonds: 0.25, cash: 0.05 },
            description: 'Growth-focused. Higher expected return with higher volatility through retirement.',
        },
    };

    const DEFAULT_STATE = {
        current_age: 30,
        retirement_age: 65,
        end_age: 95,
        balance_taxable: 10000,
        balance_tax_deferred: 50000,
        balance_tax_free: 15000,
        annual_retirement_spending: 80000,
        retirement_tax_rate: 0.18,
        social_security_annual: 25000,
        social_security_claim_age: 67,
        risk_profile: 'Balanced',
        career_stages: [
            { start_age: 22, title: 'Entry level', salary: 60000, contribution_pct: 0.10, employer_match_pct: 0.04 },
            { start_age: 27, title: 'Mid level',   salary: 95000, contribution_pct: 0.15, employer_match_pct: 0.05 },
            { start_age: 35, title: 'Senior',      salary: 140000, contribution_pct: 0.20, employer_match_pct: 0.05 },
        ],
        num_simulations: 10000,
        // ---- Advanced mode fields (Phase 2) ----
        advanced_mode: false,
        filing_status: 'single',     // 'single' | 'mfj'
        state_tax_rate: 0,           // 0-0.15 as a fraction
        fee_pct: 0.0005,             // default 0.05% (low-cost index fund)
        ss_pia_annual: 0,            // 0 = use basic social_security_annual as-is
        return_outlook: 'Historical',// key into RETURN_OUTLOOK_PRESETS
    };

    let state = loadState();

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return deepClone(DEFAULT_STATE);
            const saved = JSON.parse(raw);
            return Object.assign({}, deepClone(DEFAULT_STATE), saved);
        } catch (e) {
            return deepClone(DEFAULT_STATE);
        }
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            /* quota or private mode; ignore */
        }
    }

    function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

    function fmtMoney(n) {
        const sign = n < 0 ? '-' : '';
        const abs = Math.abs(Math.round(n));
        return sign + '$' + abs.toLocaleString('en-US');
    }

    function fmtPct(n) {
        return (n * 100).toFixed(1) + '%';
    }

    function fmtAlloc(a) {
        return `${Math.round(a.stocks * 100)}% stocks / `
             + `${Math.round(a.bonds * 100)}% bonds / `
             + `${Math.round(a.cash * 100)}% cash`;
    }

    // -------------------------------------------------------------------
    // Input bindings: every element with data-bind is two-way bound to
    // state. Number inputs parse via parseFloat; percent inputs are stored
    // as 0-1 but displayed as 0-100 via data-scale="100".
    // -------------------------------------------------------------------
    function bindSimpleInputs() {
        document.querySelectorAll('[data-bind]').forEach((el) => {
            const key = el.dataset.bind;
            const scale = parseFloat(el.dataset.scale || '1');
            const initial = state[key];
            if (initial !== undefined && initial !== null) {
                if (el.type === 'number' || el.type === 'range') {
                    el.value = initial * scale;
                } else if (el.tagName === 'SELECT') {
                    el.value = initial;
                } else {
                    el.value = initial;
                }
            }
            const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
            el.addEventListener(evt, () => {
                if (el.type === 'number' || el.type === 'range') {
                    const parsed = parseFloat(el.value);
                    state[key] = (isNaN(parsed) ? 0 : parsed) / scale;
                } else {
                    state[key] = el.value;
                }
                enforceAgeConstraints();
                updateSsBenefitPreview();
                saveState();
            });
        });
    }

    function renderReturnOutlook() {
        const container = document.getElementById('outlook-buttons');
        const descEl = document.getElementById('outlook-description');
        if (!container) return;
        container.innerHTML = '';
        Object.keys(RETURN_OUTLOOK_PRESETS).forEach((name) => {
            const preset = RETURN_OUTLOOK_PRESETS[name];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'risk-btn' + (state.return_outlook === name ? ' active' : '');
            btn.innerHTML = `<span class="outlook-name">${name}</span>`
                + `<span class="outlook-nums">${(preset.stocks * 100).toFixed(1)}% / ${(preset.bonds * 100).toFixed(1)}% / ${(preset.cash * 100).toFixed(1)}%</span>`;
            btn.addEventListener('click', () => {
                state.return_outlook = name;
                renderReturnOutlook();
                saveState();
            });
            container.appendChild(btn);
        });
        if (descEl) {
            descEl.textContent = RETURN_OUTLOOK_PRESETS[state.return_outlook].description;
        }
    }

    function bindAdvancedToggle() {
        const toggle = document.getElementById('advanced-toggle');
        const section = document.getElementById('advanced-section');
        if (!toggle || !section) return;
        toggle.checked = !!state.advanced_mode;
        section.hidden = !state.advanced_mode;
        toggle.addEventListener('change', () => {
            state.advanced_mode = toggle.checked;
            section.hidden = !state.advanced_mode;
            if (!state.advanced_mode) {
                // Toggling OFF: wipe advanced-only fields so none of them
                // leak into the next Run. Also resets the Return outlook
                // back to Historical so that next time Advanced opens
                // the user starts at the neutral default.
                resetAdvancedFields();
            }
            saveState();
        });
    }

    function resetAdvancedFields() {
        state.filing_status   = 'single';
        state.state_tax_rate  = 0;
        state.fee_pct         = 0.0005;
        state.ss_pia_annual   = 0;
        state.return_outlook  = 'Historical';
        // Sync any input elements inside the advanced section so their
        // values match the reset state the next time the section opens.
        document.querySelectorAll('#advanced-section [data-bind]').forEach((el) => {
            const key = el.dataset.bind;
            const scale = parseFloat(el.dataset.scale || '1');
            const value = state[key];
            if (value === undefined || value === null) return;
            if (el.type === 'number' || el.type === 'range') {
                el.value = value * scale;
            } else {
                el.value = value;
            }
        });
        renderReturnOutlook();
        updateSsBenefitPreview();
    }

    // Live preview of the SS benefit applied given the current PIA and
    // claim age, so the user can see "claim at 62 = $17,500" vs
    // "claim at 70 = $31,000" before running the sim.
    function updateSsBenefitPreview() {
        const el = document.getElementById('ss-benefit-preview');
        if (!el) return;
        const pia = parseFloat(state.ss_pia_annual) || 0;
        if (pia <= 0 || !state.advanced_mode) {
            el.textContent = 'Your benefit at full retirement age (67). Claiming earlier reduces it, waiting until 70 increases it. Leave 0 to use the basic "Social Security (annual)" input as-is.';
            return;
        }
        const mult = (window.RetirementSim && window.RetirementSim.ssBenefitMultiplier)
            ? window.RetirementSim.ssBenefitMultiplier(state.social_security_claim_age)
            : 1;
        const effective = Math.round(pia * mult);
        el.textContent =
            `At claim age ${state.social_security_claim_age}, this translates to `
            + `about ${fmtMoney(effective)} per year (`
            + `${Math.round(mult * 100)}% of your PIA at FRA).`;
    }

    function enforceAgeConstraints() {
        // Retirement age must be > current age; end age must be > retirement age.
        const curEl = document.querySelector('[data-bind="current_age"]');
        const retEl = document.querySelector('[data-bind="retirement_age"]');
        const endEl = document.querySelector('[data-bind="end_age"]');
        if (!curEl || !retEl || !endEl) return;
        retEl.min = Math.max(parseInt(curEl.value, 10) + 1, 17);
        endEl.min = Math.max(parseInt(retEl.value, 10) + 1, 18);
        if (parseFloat(retEl.value) <= parseFloat(curEl.value)) {
            retEl.value = parseFloat(curEl.value) + 1;
            state.retirement_age = parseFloat(retEl.value);
        }
        if (parseFloat(endEl.value) <= parseFloat(retEl.value)) {
            endEl.value = parseFloat(retEl.value) + 1;
            state.end_age = parseFloat(endEl.value);
        }
    }

    // -------------------------------------------------------------------
    // Risk profile buttons
    // -------------------------------------------------------------------
    function renderRiskProfile() {
        const container = document.getElementById('risk-buttons');
        container.innerHTML = '';
        Object.keys(RISK_PRESETS).forEach((name) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'risk-btn' + (state.risk_profile === name ? ' active' : '');
            btn.textContent = name;
            btn.addEventListener('click', () => {
                state.risk_profile = name;
                applyRiskProfile();
                renderRiskProfile();
                saveState();
            });
            container.appendChild(btn);
        });
        const preset = RISK_PRESETS[state.risk_profile];
        document.getElementById('risk-description').textContent = preset.description;
        document.getElementById('risk-now').textContent =
            'Now: ' + fmtAlloc(preset.now);
        document.getElementById('risk-retirement').textContent =
            'At retirement: ' + fmtAlloc(preset.retirement);
    }

    function applyRiskProfile() {
        const preset = RISK_PRESETS[state.risk_profile];
        state.allocation_now = deepClone(preset.now);
        state.allocation_at_retirement = deepClone(preset.retirement);
    }

    // -------------------------------------------------------------------
    // Career stages table
    // -------------------------------------------------------------------
    function renderCareerTable() {
        const tbody = document.querySelector('#career-table tbody');
        tbody.innerHTML = '';
        state.career_stages.forEach((stage, i) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td data-label="Age"><input type="number" class="cell-input" value="${stage.start_age}" min="14" max="90" step="1" data-idx="${i}" data-field="start_age"></td>
                <td data-label="Title"><input type="text" class="cell-input cell-title" value="${escapeHtml(stage.title)}" placeholder="e.g. Senior Engineer" data-idx="${i}" data-field="title"></td>
                <td data-label="Salary"><span class="cell-group"><span class="cell-prefix">$</span><input type="number" class="cell-input cell-money" value="${stage.salary}" min="0" step="1000" data-idx="${i}" data-field="salary"></span></td>
                <td data-label="Contribution %"><span class="cell-group"><input type="number" class="cell-input cell-pct" value="${(stage.contribution_pct * 100).toFixed(0)}" min="0" max="90" step="1" data-idx="${i}" data-field="contribution_pct"><span class="cell-suffix">%</span></span></td>
                <td data-label="Employer match %"><span class="cell-group"><input type="number" class="cell-input cell-pct" value="${(stage.employer_match_pct * 100).toFixed(1)}" min="0" max="15" step="0.5" data-idx="${i}" data-field="employer_match_pct"><span class="cell-suffix">%</span></span></td>
                <td class="row-actions">
                    <button type="button" class="icon-btn" data-action="delete" data-idx="${i}" title="Delete stage">✕</button>
                </td>`;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.cell-input').forEach((el) => {
            el.addEventListener('input', () => {
                const idx = parseInt(el.dataset.idx, 10);
                const field = el.dataset.field;
                const stage = state.career_stages[idx];
                if (field === 'title') {
                    stage.title = el.value;
                } else if (field === 'contribution_pct' || field === 'employer_match_pct') {
                    stage[field] = (parseFloat(el.value) || 0) / 100;
                } else {
                    stage[field] = parseFloat(el.value) || 0;
                }
                saveState();
            });
        });

        tbody.querySelectorAll('[data-action="delete"]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx, 10);
                state.career_stages.splice(idx, 1);
                saveState();
                renderCareerTable();
            });
        });
    }

    function addCareerStage() {
        const lastAge = state.career_stages.length
            ? state.career_stages[state.career_stages.length - 1].start_age
            : 22;
        state.career_stages.push({
            start_age: lastAge + 5,
            title: '',
            salary: 60000,
            contribution_pct: 0.15,
            employer_match_pct: 0.05,
        });
        saveState();
        renderCareerTable();
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[c]);
    }

    // -------------------------------------------------------------------
    // Sort + validate inputs before running
    // -------------------------------------------------------------------
    function prepareInputs() {
        const sorted = state.career_stages.slice().sort((a, b) => a.start_age - b.start_age);
        const inputs = deepClone(state);
        inputs.career_stages = sorted;
        applyRiskProfile();
        inputs.allocation_now = deepClone(state.allocation_now);
        inputs.allocation_at_retirement = deepClone(state.allocation_at_retirement);
        // Return outlook only takes effect when advanced mode is on;
        // basic mode uses the engine's default (Historical) means.
        if (state.advanced_mode) {
            const outlook = RETURN_OUTLOOK_PRESETS[state.return_outlook]
                || RETURN_OUTLOOK_PRESETS.Historical;
            inputs.return_means = {
                stocks: outlook.stocks,
                bonds:  outlook.bonds,
                cash:   outlook.cash,
            };
        }
        return inputs;
    }

    // -------------------------------------------------------------------
    // Results rendering
    // -------------------------------------------------------------------
    function brandPlotLayout() {
        const isDark = window.matchMedia
            && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isNarrow = window.matchMedia
            && window.matchMedia('(max-width: 640px)').matches;
        return {
            font: { color: isDark ? '#e8eef5' : '#1a1a2e' },
            plot_bgcolor: 'rgba(0,0,0,0)',
            paper_bgcolor: 'rgba(0,0,0,0)',
            grid: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
            hoverlabel: {
                bgcolor: isDark ? '#142538' : '#ffffff',
                bordercolor: isDark ? '#1f3449' : '#e5e7eb',
                font: { color: isDark ? '#e8eef5' : '#1a1a2e', size: 13 },
            },
            isNarrow,
            isDark,
        };
    }

    function renderMetrics(result) {
        document.getElementById('metric-success').textContent = fmtPct(result.successRate);
        document.getElementById('metric-median').textContent = fmtMoney(result.finalP50);
        document.getElementById('metric-p10').textContent = fmtMoney(result.finalP10);
        document.getElementById('metric-p90').textContent = fmtMoney(result.finalP90);
    }

    function renderTrajectory(result, retirementAge) {
        const layout = brandPlotLayout();
        // Order here controls the order rows appear in Plotly's unified
        // hover tooltip. Chosen top-to-bottom: 90th pct, Median, 10th
        // pct, Total contributed. The fill between 10th and 90th still
        // happens because Plotly uses trace order for fills; 10th is
        // drawn after 90th and fills back to its previous trace.
        // Trace ordering matters for two things:
        //   (1) Unified hover lists rows in this order.
        //   (2) fill: 'tonexty' on p10 fills back to the IMMEDIATELY
        //       previous trace; putting p10 right after p90 creates
        //       the full 10-90 band.
        const traces = [
            {
                x: result.ages, y: result.p90,
                mode: 'lines', line: { width: 0 },
                name: '90th pct', showlegend: false,
                hovertemplate: '90th pct: <b>$%{y:,.0f}</b><extra></extra>',
            },
            {
                x: result.ages, y: result.p10,
                mode: 'lines', line: { width: 0 }, fill: 'tonexty',
                fillcolor: 'rgba(46,204,113,0.22)',
                name: '10th pct',
                showlegend: false,
                hovertemplate: '10th pct: <b>$%{y:,.0f}</b><extra></extra>',
            },
            {
                x: result.ages, y: result.p50,
                mode: 'lines',
                line: { width: 3, color: '#27ae60' },
                name: 'Median',
                hovertemplate: 'Median: <b>$%{y:,.0f}</b><extra></extra>',
            },
            {
                x: result.ages, y: result.cumulativeContributions,
                mode: 'lines',
                line: { width: 2.5, color: '#f1c40f', dash: 'dot' },
                name: 'Total contributed',
                hovertemplate: 'Contributed: <b>$%{y:,.0f}</b><extra></extra>',
            },
            {
                // Proxy legend entry for the 10-90 fill band. Must come
                // last so it doesn't participate in fill sequencing.
                x: [null], y: [null],
                mode: 'lines',
                line: { width: 10, color: 'rgba(46,204,113,0.35)' },
                name: '10-90% range',
                hoverinfo: 'skip',
            },
        ];
        const leftMargin = layout.isNarrow ? 48 : 90;
        const rightMargin = layout.isNarrow ? 12 : 20;
        const fig = {
            height: layout.isNarrow ? 380 : 460,
            hovermode: 'x unified',
            xaxis: { title: 'Age', gridcolor: layout.grid },
            yaxis: {
                title: layout.isNarrow ? '' : { text: "Portfolio (today's $)", standoff: 12 },
                gridcolor: layout.grid,
                tickformat: '$.2s',
                tickprefix: '',
            },
            plot_bgcolor: layout.plot_bgcolor,
            paper_bgcolor: layout.paper_bgcolor,
            font: layout.font,
            hoverlabel: layout.hoverlabel,
            dragmode: false,
            margin: { l: leftMargin, r: rightMargin, t: 30, b: 60 },
            legend: { orientation: 'h', y: layout.isNarrow ? -0.25 : -0.2 },
            shapes: [{
                type: 'line', x0: retirementAge, x1: retirementAge,
                y0: 0, y1: 1, yref: 'paper',
                line: { color: layout.font.color, dash: 'dash', width: 1 },
            }],
            annotations: [{
                x: retirementAge, y: 1, yref: 'paper',
                text: 'Retirement', showarrow: false,
                yshift: 12, font: { color: layout.font.color, size: 12 },
            }],
        };
        Plotly.newPlot('chart-trajectory', traces, fig, {
            displayModeBar: false,
            responsive: true,
            scrollZoom: false,
            doubleClick: false,
            showTips: false,
            displaylogo: false,
            staticPlot: false,
        }).then((gd) => {
            attachAgeHeaderRewriter(gd);
            attachResponsiveResize(gd);
            bindTouchHover(gd);
        });
    }

    // Plotly's unified hover x-header is always a bare number (its
    // hoverformat accepts only d3 format strings, no text prefix). We
    // rewrite it to "AGE: 62" in the DOM whenever the hoverlayer
    // changes. Using a MutationObserver so we catch every hover state,
    // including touch interactions where plotly_hover events don't fire
    // reliably.
    //
    // In unified-hover mode the box is rendered as a legend-like group:
    // `.hoverlayer .legend .legendtitletext` holds the x-value header.
    // Mobile touch-to-hover: when the user touches / drags horizontally
    // across the chart, compute the age (x-axis data value) under their
    // finger and trigger Plotly's unified hover there. Calling
    // preventDefault on the touch events stops the browser from doing
    // native pinch-zoom or rubber-band scrolling on the SVG. Vertical
    // swipes still pass through (touch-action: pan-y in CSS) so the
    // page can scroll normally.
    function bindTouchHover(gd) {
        if (!gd) return;
        function computeXval(clientX) {
            const rect = gd.getBoundingClientRect();
            const xaxis = gd._fullLayout && gd._fullLayout.xaxis;
            if (!xaxis) return null;
            const rel = clientX - rect.left - xaxis._offset;
            if (rel < 0 || rel > xaxis._length) return null;
            return xaxis.p2c(rel);
        }
        function handle(e) {
            if (!e.touches || e.touches.length === 0) return;
            const xval = computeXval(e.touches[0].clientX);
            if (xval === null) return;
            window.Plotly.Fx.hover(gd, { xval: xval }, 'xy');
            e.preventDefault();
        }
        gd.addEventListener('touchstart', handle, { passive: false });
        gd.addEventListener('touchmove',  handle, { passive: false });
    }

    // After Plotly renders, explicitly resize once the next frame paints
    // so the SVG fits the container. Also resizes on window resize /
    // orientation change so rotating a phone doesn't leave the chart
    // wider than the viewport.
    function attachResponsiveResize(gd) {
        if (!gd) return;
        const doResize = () => {
            if (gd && gd.offsetParent !== null && window.Plotly) {
                window.Plotly.Plots.resize(gd);
            }
        };
        requestAnimationFrame(doResize);
        // Register a single shared resize listener (idempotent by key)
        if (!window.__pcResizeBound) {
            window.__pcResizeBound = true;
            const all = ['chart-trajectory', 'chart-salary'];
            let pending = false;
            window.addEventListener('resize', () => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    all.forEach((id) => {
                        const el = document.getElementById(id);
                        if (el && el.data && window.Plotly) {
                            window.Plotly.Plots.resize(el);
                        }
                    });
                });
            });
        }
    }

    function attachAgeHeaderRewriter(gd) {
        if (!gd) return;
        const hoverLayer = gd.querySelector('.hoverlayer');
        if (!hoverLayer) return;
        const rewrite = () => {
            const headers = hoverLayer.querySelectorAll('.legendtitletext');
            headers.forEach((h) => {
                const raw = (h.textContent || '').trim();
                if (!raw || raw.startsWith('AGE')) return;
                if (/^-?\d{1,3}$/.test(raw)) {
                    h.textContent = 'AGE: ' + raw;
                }
            });
        };
        const observer = new MutationObserver(rewrite);
        observer.observe(hoverLayer, {
            childList: true, subtree: true, characterData: true,
        });
        rewrite();
    }

    function renderSalaryChart(result) {
        const workingAges = [];
        const workingSalaries = [];
        for (let i = 0; i < result.ages.length; i++) {
            if (result.salaryByAge[i] > 0) {
                workingAges.push(result.ages[i]);
                workingSalaries.push(result.salaryByAge[i]);
            }
        }
        if (workingAges.length === 0) {
            document.getElementById('chart-salary').innerHTML =
                '<p class="caption">No working years projected from current age.</p>';
            return;
        }
        const layout = brandPlotLayout();
        const salLeftMargin = layout.isNarrow ? 48 : 90;
        const salRightMargin = layout.isNarrow ? 12 : 20;
        Plotly.newPlot('chart-salary', [{
            x: workingAges, y: workingSalaries,
            mode: 'lines+markers',
            line: { color: '#27ae60', width: 3 },
            marker: { color: '#2ecc71', size: 8 },
            name: 'Salary',
            hovertemplate: '$%{y:,.0f}<extra></extra>',
        }], {
            height: layout.isNarrow ? 260 : 300,
            xaxis: { title: 'Age', gridcolor: layout.grid },
            yaxis: {
                title: layout.isNarrow ? '' : { text: "Salary (today's $)", standoff: 12 },
                gridcolor: layout.grid,
                tickformat: '$.2s',
            },
            plot_bgcolor: layout.plot_bgcolor,
            paper_bgcolor: layout.paper_bgcolor,
            font: layout.font,
            hoverlabel: layout.hoverlabel,
            dragmode: false,
            margin: { l: salLeftMargin, r: salRightMargin, t: 20, b: 50 },
            showlegend: false,
            hovermode: 'x unified',
        }, {
            displayModeBar: false,
            responsive: true,
            scrollZoom: false,
            doubleClick: false,
            showTips: false,
            displaylogo: false,
        }).then((gd) => {
            attachAgeHeaderRewriter(gd);
            attachResponsiveResize(gd);
            bindTouchHover(gd);
        });
    }

    function onRun() {
        const runBtn = document.getElementById('run-btn');
        const runLabel = runBtn.textContent;
        runBtn.disabled = true;
        runBtn.textContent = 'Running...';

        // Allow the button state to paint before the sync sim blocks the thread.
        setTimeout(() => {
            try {
                const inputs = prepareInputs();
                const t0 = performance.now();
                const result = window.RetirementSim.runSimulation(inputs);
                const dt = performance.now() - t0;
                renderMetrics(result);
                renderTrajectory(result, inputs.retirement_age);
                renderSalaryChart(result);
                document.getElementById('results').hidden = false;
                document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
                document.getElementById('run-timing').textContent =
                    `Ran ${inputs.num_simulations.toLocaleString()} simulations in ${dt.toFixed(0)} ms`;
            } catch (e) {
                console.error(e);
                alert('Simulation failed: ' + (e.message || e));
            } finally {
                runBtn.disabled = false;
                runBtn.textContent = runLabel;
            }
        }, 20);
    }

    function resetToDefaults() {
        if (!confirm('Reset all inputs to defaults? This clears any saved scenario.')) return;
        state = deepClone(DEFAULT_STATE);
        applyRiskProfile();
        saveState();
        // Refresh every bound element
        document.querySelectorAll('[data-bind]').forEach((el) => {
            const key = el.dataset.bind;
            const scale = parseFloat(el.dataset.scale || '1');
            el.value = (el.type === 'number' || el.type === 'range')
                ? (state[key] * scale)
                : state[key];
        });
        renderRiskProfile();
        renderCareerTable();
    }

    // -------------------------------------------------------------------
    // Wire up
    // -------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', () => {
        applyRiskProfile();
        bindSimpleInputs();
        bindAdvancedToggle();
        enforceAgeConstraints();
        renderRiskProfile();
        renderReturnOutlook();
        renderCareerTable();
        updateSsBenefitPreview();
        document.getElementById('run-btn').addEventListener('click', onRun);
        document.getElementById('add-stage-btn').addEventListener('click', addCareerStage);
        document.getElementById('reset-btn').addEventListener('click', resetToDefaults);
    });
})();
