/*
 * Retirement Tracker Monte Carlo engine (vanilla JS port).
 *
 * All figures are real (today's) dollars. Returns are sampled from a
 * bivariate normal for stocks/bonds (Cholesky-factored) with an
 * independent cash return. This matches simulation.py from the
 * Retirement-Tracker repo.
 *
 * Public surface: runSimulation(inputs) -> result
 */
(function (global) {
    'use strict';

    const RETURN_MODEL = {
        stockMean:     0.068,
        stockStd:      0.170,
        bondMean:      0.020,
        bondStd:       0.060,
        cashMean:      0.003,
        cashStd:       0.010,
        stockBondCorr: 0.10,
    };

    // Standard-normal sample via Box-Muller.
    function randn() {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    function normalizeAllocation(a) {
        const total = a.stocks + a.bonds + a.cash;
        if (total <= 0) return { stocks: 0.6, bonds: 0.3, cash: 0.1 };
        return {
            stocks: a.stocks / total,
            bonds: a.bonds / total,
            cash: a.cash / total,
        };
    }

    // Linear glide path from current allocation to retirement allocation.
    function interpolateAllocation(start, end, age, startAge, endAge) {
        if (endAge <= startAge) return normalizeAllocation(end);
        const t = Math.max(0, Math.min(1, (age - startAge) / (endAge - startAge)));
        return normalizeAllocation({
            stocks: start.stocks + (end.stocks - start.stocks) * t,
            bonds:  start.bonds  + (end.bonds  - start.bonds)  * t,
            cash:   start.cash   + (end.cash   - start.cash)   * t,
        });
    }

    // Return salary at `age` given a list of career stages. Salary is flat
    // within a stage; the active stage is the one whose start_age is the
    // most recent value <= age.
    function salaryAt(age, stages) {
        if (!stages || !stages.length) return { salary: 0, stage: null };
        const sorted = stages.slice().sort((a, b) => a.start_age - b.start_age);
        let active = null;
        for (const s of sorted) {
            if (age >= s.start_age) active = s;
            else break;
        }
        return { salary: active ? active.salary : 0, stage: active };
    }

    // Draw one year of (stock, bond, cash) returns for N sims into
    // pre-allocated Float64Arrays, using a Cholesky decomposition of the
    // 2x2 stock/bond covariance matrix.
    function sampleAssetReturns(n, outStocks, outBonds, outCash, model) {
        const sS = model.stockStd;
        const sB = model.bondStd;
        const corr = model.stockBondCorr;
        const L11 = sS;
        const L21 = corr * sB;
        const L22 = sB * Math.sqrt(Math.max(0, 1 - corr * corr));
        for (let i = 0; i < n; i++) {
            const z1 = randn();
            const z2 = randn();
            outStocks[i] = model.stockMean + L11 * z1;
            outBonds[i]  = model.bondMean  + L21 * z1 + L22 * z2;
            outCash[i]   = model.cashMean  + randn() * model.cashStd;
        }
    }

    function percentile(sortedArr, q) {
        if (sortedArr.length === 0) return 0;
        const idx = Math.max(0, Math.min(sortedArr.length - 1,
            Math.floor(sortedArr.length * q)));
        return sortedArr[idx];
    }

    function runSimulation(inputs) {
        const nSims = inputs.num_simulations || 10000;

        const ages = [];
        for (let a = inputs.current_age; a <= inputs.end_age; a++) ages.push(a);
        const nYears = ages.length;

        const taxable      = new Float64Array(nSims).fill(inputs.balance_taxable);
        const taxDeferred  = new Float64Array(nSims).fill(inputs.balance_tax_deferred);
        const taxFree      = new Float64Array(nSims).fill(inputs.balance_tax_free);

        // Per-year, per-sim totals: shape (nYears, nSims)
        const totalByYear = new Array(nYears);
        for (let i = 0; i < nYears; i++) totalByYear[i] = new Float64Array(nSims);

        const salaryByAge        = new Float64Array(nYears);
        const contributionsByAge = new Float64Array(nYears);
        const depleted           = new Uint8Array(nSims);

        const stockR = new Float64Array(nSims);
        const bondR  = new Float64Array(nSims);
        const cashR  = new Float64Array(nSims);

        for (let i = 0; i < nYears; i++) {
            const age = ages[i];
            const alloc = interpolateAllocation(
                inputs.allocation_now,
                inputs.allocation_at_retirement,
                age, inputs.current_age, inputs.retirement_age
            );
            sampleAssetReturns(nSims, stockR, bondR, cashR, RETURN_MODEL);

            // Apply returns
            for (let s = 0; s < nSims; s++) {
                const r = alloc.stocks * stockR[s]
                        + alloc.bonds  * bondR[s]
                        + alloc.cash   * cashR[s];
                const growth = 1 + r;
                taxable[s]     *= growth;
                taxDeferred[s] *= growth;
                taxFree[s]     *= growth;
            }

            // Contributions while working
            if (age < inputs.retirement_age) {
                const { salary, stage } = salaryAt(age, inputs.career_stages);
                salaryByAge[i] = salary;
                if (stage && salary > 0) {
                    const employee = salary * stage.contribution_pct;
                    const match    = salary * stage.employer_match_pct;
                    // 70% of employee savings to tax-deferred, 30% taxable; match to tax-deferred.
                    const toTaxDef  = employee * 0.70 + match;
                    const toTaxable = employee * 0.30;
                    for (let s = 0; s < nSims; s++) {
                        taxDeferred[s] += toTaxDef;
                        taxable[s]     += toTaxable;
                    }
                    contributionsByAge[i] = employee + match;
                }
            }

            // Withdrawals in retirement (tax-aware order)
            if (age >= inputs.retirement_age) {
                const ss = age >= inputs.social_security_claim_age
                    ? inputs.social_security_annual
                    : 0;
                const need = Math.max(0, inputs.annual_retirement_spending - ss);
                const taxRate = inputs.retirement_tax_rate;
                const taxFactor = taxRate < 0.999 ? 1 / (1 - taxRate) : 1e9;

                for (let s = 0; s < nSims; s++) {
                    let remaining = need;

                    // Taxable first
                    let take = Math.min(taxable[s], remaining);
                    taxable[s] -= take;
                    remaining  -= take;

                    // Tax-deferred: gross up for taxes
                    const grossNeeded = remaining * taxFactor;
                    take = Math.min(taxDeferred[s], grossNeeded);
                    taxDeferred[s] -= take;
                    remaining      -= take * (1 - taxRate);

                    // Tax-free last
                    take = Math.min(taxFree[s], remaining);
                    taxFree[s] -= take;
                    remaining  -= take;

                    if (remaining > 1) depleted[s] = 1;
                }
            }

            // Clamp + record totals for this year
            const row = totalByYear[i];
            for (let s = 0; s < nSims; s++) {
                if (taxable[s]     < 0) taxable[s]     = 0;
                if (taxDeferred[s] < 0) taxDeferred[s] = 0;
                if (taxFree[s]     < 0) taxFree[s]     = 0;
                row[s] = taxable[s] + taxDeferred[s] + taxFree[s];
            }
        }

        // Per-year percentiles
        const p10 = new Float64Array(nYears);
        const p50 = new Float64Array(nYears);
        const p90 = new Float64Array(nYears);
        for (let i = 0; i < nYears; i++) {
            const sorted = Array.from(totalByYear[i]).sort((a, b) => a - b);
            p10[i] = percentile(sorted, 0.10);
            p50[i] = percentile(sorted, 0.50);
            p90[i] = percentile(sorted, 0.90);
        }

        // Final balance distribution
        const finalBalances = Array.from(totalByYear[nYears - 1]);
        const sortedFinal = finalBalances.slice().sort((a, b) => a - b);
        const finalP10 = percentile(sortedFinal, 0.10);
        const finalP50 = percentile(sortedFinal, 0.50);
        const finalP90 = percentile(sortedFinal, 0.90);

        let successCount = 0;
        for (let s = 0; s < nSims; s++) if (depleted[s] === 0) successCount++;
        const successRate = successCount / nSims;

        // Cumulative contributions (deterministic: same across all sims)
        const startingBalance = inputs.balance_taxable
                              + inputs.balance_tax_deferred
                              + inputs.balance_tax_free;
        const cumulativeContributions = new Float64Array(nYears);
        let running = startingBalance;
        for (let i = 0; i < nYears; i++) {
            running += contributionsByAge[i];
            cumulativeContributions[i] = running;
        }

        return {
            ages,
            p10: Array.from(p10),
            p50: Array.from(p50),
            p90: Array.from(p90),
            salaryByAge: Array.from(salaryByAge),
            cumulativeContributions: Array.from(cumulativeContributions),
            successRate,
            finalP10, finalP50, finalP90,
            finalBalances,
        };
    }

    // Export
    global.RetirementSim = {
        runSimulation,
        RETURN_MODEL,
    };
})(typeof window !== 'undefined' ? window : globalThis);
