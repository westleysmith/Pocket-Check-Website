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
                el.value = (el.type === 'number' || el.type === 'range')
                    ? (initial * scale)
                    : initial;
            }
            el.addEventListener('input', () => {
                if (el.type === 'number' || el.type === 'range') {
                    const parsed = parseFloat(el.value);
                    state[key] = (isNaN(parsed) ? 0 : parsed) / scale;
                } else {
                    state[key] = el.value;
                }
                enforceAgeConstraints();
                saveState();
            });
        });
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
                <td><input type="number" class="cell-input" value="${stage.start_age}" min="14" max="90" step="1" data-idx="${i}" data-field="start_age"></td>
                <td><input type="text"   class="cell-input cell-title" value="${escapeHtml(stage.title)}" placeholder="e.g. Senior Engineer" data-idx="${i}" data-field="title"></td>
                <td><input type="number" class="cell-input cell-money" value="${stage.salary}" min="0" step="1000" data-idx="${i}" data-field="salary"></td>
                <td><input type="number" class="cell-input cell-pct" value="${(stage.contribution_pct * 100).toFixed(0)}" min="0" max="90" step="1" data-idx="${i}" data-field="contribution_pct"></td>
                <td><input type="number" class="cell-input cell-pct" value="${(stage.employer_match_pct * 100).toFixed(1)}" min="0" max="15" step="0.5" data-idx="${i}" data-field="employer_match_pct"></td>
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
        return inputs;
    }

    // -------------------------------------------------------------------
    // Results rendering
    // -------------------------------------------------------------------
    function brandPlotLayout() {
        const isDark = window.matchMedia
            && window.matchMedia('(prefers-color-scheme: dark)').matches;
        return {
            font: { color: isDark ? '#e8eef5' : '#1a1a2e' },
            plot_bgcolor: 'rgba(0,0,0,0)',
            paper_bgcolor: 'rgba(0,0,0,0)',
            grid: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
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
        const traces = [
            {
                x: result.ages, y: result.p90,
                mode: 'lines', line: { width: 0 },
                name: '90th pct', showlegend: false,
                hoverinfo: 'skip',
            },
            {
                x: result.ages, y: result.p10,
                mode: 'lines', line: { width: 0 }, fill: 'tonexty',
                fillcolor: 'rgba(46,204,113,0.22)',
                name: '10-90% range',
                hovertemplate: 'Age %{x}<br>10th: $%{y:,.0f}<extra></extra>',
            },
            {
                x: result.ages, y: result.p50,
                mode: 'lines',
                line: { width: 3, color: '#27ae60' },
                name: 'Median',
                hovertemplate: 'Age %{x}<br>Median: $%{y:,.0f}<extra></extra>',
            },
            {
                x: result.ages, y: result.cumulativeContributions,
                mode: 'lines',
                line: { width: 2.5, color: '#f1c40f', dash: 'dot' },
                name: 'Total contributed',
                hovertemplate: 'Age %{x}<br>Contributed: $%{y:,.0f}<extra></extra>',
            },
        ];
        const fig = {
            height: 460,
            hovermode: 'x unified',
            xaxis: { title: 'Age', gridcolor: layout.grid },
            yaxis: {
                title: { text: "Portfolio (today's $)", standoff: 12 },
                gridcolor: layout.grid,
                tickformat: '$.2s',
                tickprefix: '',
            },
            plot_bgcolor: layout.plot_bgcolor,
            paper_bgcolor: layout.paper_bgcolor,
            font: layout.font,
            margin: { l: 90, r: 20, t: 30, b: 60 },
            legend: { orientation: 'h', y: -0.2 },
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
        Plotly.newPlot('chart-trajectory', traces, fig, { displayModeBar: false, responsive: true });
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
        Plotly.newPlot('chart-salary', [{
            x: workingAges, y: workingSalaries,
            mode: 'lines+markers',
            line: { color: '#27ae60', width: 3 },
            marker: { color: '#2ecc71', size: 8 },
            hovertemplate: 'Age %{x}<br>Salary: $%{y:,.0f}<extra></extra>',
        }], {
            height: 300,
            xaxis: { title: 'Age', gridcolor: layout.grid },
            yaxis: {
                title: { text: "Salary (today's $)", standoff: 12 },
                gridcolor: layout.grid,
                tickformat: '$.2s',
            },
            plot_bgcolor: layout.plot_bgcolor,
            paper_bgcolor: layout.paper_bgcolor,
            font: layout.font,
            margin: { l: 90, r: 20, t: 20, b: 50 },
            showlegend: false,
        }, { displayModeBar: false, responsive: true });
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
        enforceAgeConstraints();
        renderRiskProfile();
        renderCareerTable();
        document.getElementById('run-btn').addEventListener('click', onRun);
        document.getElementById('add-stage-btn').addEventListener('click', addCareerStage);
        document.getElementById('reset-btn').addEventListener('click', resetToDefaults);
    });
})();
