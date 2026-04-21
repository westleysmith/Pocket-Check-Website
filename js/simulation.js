/*
 * Retirement Tracker Monte Carlo engine (vanilla JS).
 *
 * All figures are real (today's) dollars.
 *
 * ---- Math correctness fixes (Phase 1, always on) ----
 *   - Returns are LOGNORMAL (growth = exp(log-return)) so portfolio
 *     values can never go below zero and compounding matches the
 *     target arithmetic mean with realistic volatility drag.
 *   - Stock returns use Student-t (df=6) to give fat tails that better
 *     match historical equity drawdowns. Bonds and cash stay Gaussian.
 *   - Stock and bond samples are correlated via the given corr value.
 *
 * ---- Advanced features (opt-in via inputs.advanced_mode) ----
 *   - Federal tax brackets (2026 projected) + standard deduction +
 *     filing status (single / mfj), instead of a single flat rate.
 *   - State tax rate.
 *   - Portfolio expense ratio (fee drag) applied each year.
 *   - Social Security benefit adjusted for claim age vs FRA=67.
 *
 * Public surface: window.RetirementSim.runSimulation(inputs)
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
        stockTDof:     6,  // Student-t degrees of freedom for fat tails
    };

    // Standard-normal sample via Box-Muller.
    function randn() {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    // Student-t sample with df degrees of freedom, rescaled to unit variance.
    // t(df) ~ Z / sqrt(chi2(df)/df); Var[t] = df/(df-2) for df>2, so we
    // divide by sqrt(df/(df-2)) to get a unit-variance fat-tailed sample
    // that can be used as a drop-in replacement for randn() wherever fat
    // tails are wanted.
    function randt(df) {
        const z = randn();
        let chi2 = 0;
        for (let i = 0; i < df; i++) {
            const zi = randn();
            chi2 += zi * zi;
        }
        const t = z / Math.sqrt(chi2 / df);
        const scale = 1 / Math.sqrt(df / (df - 2));
        return t * scale;
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

    function interpolateAllocation(start, end, age, startAge, endAge) {
        if (endAge <= startAge) return normalizeAllocation(end);
        const t = Math.max(0, Math.min(1, (age - startAge) / (endAge - startAge)));
        return normalizeAllocation({
            stocks: start.stocks + (end.stocks - start.stocks) * t,
            bonds:  start.bonds  + (end.bonds  - start.bonds)  * t,
            cash:   start.cash   + (end.cash   - start.cash)   * t,
        });
    }

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

    // Draw one year of (stock, bond, cash) LOG-returns for N sims into
    // pre-allocated Float64Arrays. Stock-bond correlation is preserved
    // even though the stock shock is Student-t: we take the correlated
    // Gaussian pair (z1, z2) as usual, but then REPLACE z1 with a
    // Student-t sample, mixing it in for the bond via the correlation
    // weight to keep the rank ordering.
    //
    // The "- sigma^2/2" term is Jensen's correction: a normal log-return
    // with mean (mu - sigma^2/2) gives E[exp(log_r)] = exp(mu), i.e. the
    // target arithmetic mean.
    function sampleAssetReturns(n, outStocks, outBonds, outCash, model, feePct) {
        const sS = model.stockStd;
        const sB = model.bondStd;
        const sC = model.cashStd;
        const corr = model.stockBondCorr;
        const df = model.stockTDof;
        const stockDrift = model.stockMean - 0.5 * sS * sS - feePct;
        const bondDrift  = model.bondMean  - 0.5 * sB * sB - feePct;
        const cashDrift  = model.cashMean  - 0.5 * sC * sC;
        const bondCorrW  = Math.sqrt(Math.max(0, 1 - corr * corr));

        for (let i = 0; i < n; i++) {
            // Stock shock: Student-t with fat tails
            const eS = randt(df);
            // Independent Gaussian shock for bond's uncorrelated part
            const eB = randn();
            // Correlate bond to stock via its correlation weight
            const bondShock = corr * eS + bondCorrW * eB;

            outStocks[i] = stockDrift + sS * eS;
            outBonds[i]  = bondDrift  + sB * bondShock;
            outCash[i]   = cashDrift  + sC * randn();
        }
    }

    function percentile(sortedArr, q) {
        if (sortedArr.length === 0) return 0;
        const idx = Math.max(0, Math.min(sortedArr.length - 1,
            Math.floor(sortedArr.length * q)));
        return sortedArr[idx];
    }

    // ---- 2026 (projected) federal tax brackets and standard deductions.
    // Close enough for planning. Not a substitute for a CPA.
    const TAX_BRACKETS_2026 = {
        single: [
            [12150,    0.10],
            [48525,    0.12],
            [102050,   0.22],
            [193800,   0.24],
            [244500,   0.32],
            [611350,   0.35],
            [Infinity, 0.37],
        ],
        mfj: [
            [24300,    0.10],
            [97050,    0.12],
            [204100,   0.22],
            [387600,   0.24],
            [489000,   0.32],
            [732400,   0.35],
            [Infinity, 0.37],
        ],
    };

    const STANDARD_DEDUCTION_2026 = { single: 15550, mfj: 31100 };

    // Federal tax on `ordinaryIncome` (above standard deduction).
    // Flat simplification: all tax-deferred withdrawals are treated as
    // ordinary income. No LTCG/qualified dividends, no NIIT.
    function federalTax(ordinaryIncome, filingStatus) {
        const brackets = TAX_BRACKETS_2026[filingStatus] || TAX_BRACKETS_2026.single;
        const deduction = STANDARD_DEDUCTION_2026[filingStatus] || STANDARD_DEDUCTION_2026.single;
        const taxable = Math.max(0, ordinaryIncome - deduction);
        if (taxable <= 0) return 0;
        let tax = 0;
        let prevCap = 0;
        for (const [cap, rate] of brackets) {
            if (taxable <= cap) {
                tax += (taxable - prevCap) * rate;
                return tax;
            }
            tax += (cap - prevCap) * rate;
            prevCap = cap;
        }
        return tax;
    }

    // Bracket-correct gross-up: given a target NET amount (after taxes),
    // find the GROSS withdrawal from tax-deferred that nets it. Solved
    // by iterating up to 5 passes which converges for monotone tax.
    function grossUpForBrackets(netNeeded, filingStatus, otherIncome, stateTaxRate) {
        if (netNeeded <= 0) return 0;
        let gross = netNeeded / (1 - stateTaxRate - 0.18); // seed guess
        for (let i = 0; i < 8; i++) {
            const fed = federalTax(otherIncome + gross, filingStatus);
            const state = (otherIncome + gross) * stateTaxRate;
            const net = gross - fed - state + federalTax(otherIncome, filingStatus) + otherIncome * stateTaxRate;
            // net = gross - (extra fed tax from gross) - (extra state tax from gross)
            if (Math.abs(net - netNeeded) < 1) return gross;
            gross += (netNeeded - net);
            if (gross < 0) gross = 0;
        }
        return gross;
    }

    // IRS Uniform Lifetime Table divisors (ages 73 through 100).
    // RMD for the year = prior-year balance / divisor.
    const RMD_DIVISORS = {
        73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0,
        79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8,
        85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2,
        91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5,  95: 8.9,  96: 8.4,
        97: 7.8,  98: 7.3,  99: 6.8,  100: 6.4,
    };
    const RMD_START_AGE = 73;

    // Social Security benefit multiplier given claim age, assuming
    // FRA = 67. 5/9% per month reduction for first 36 months early,
    // 5/12% per month reduction for additional early months, 8%/year
    // (2/3% per month) delayed retirement credit after FRA (cap 70).
    function ssBenefitMultiplier(claimAge) {
        const fra = 67;
        const ca = Math.max(62, Math.min(70, claimAge));
        if (ca === fra) return 1.0;
        if (ca < fra) {
            const monthsEarly = (fra - ca) * 12;
            const first36 = Math.min(36, monthsEarly);
            const beyond36 = Math.max(0, monthsEarly - 36);
            const reduction = first36 * (5 / 9 / 100) + beyond36 * (5 / 12 / 100);
            return Math.max(0.5, 1 - reduction);
        }
        const monthsLate = (ca - fra) * 12;
        return 1 + monthsLate * (2 / 3 / 100);
    }

    function runSimulation(inputs) {
        const nSims = inputs.num_simulations || 10000;
        const advanced = !!inputs.advanced_mode;

        // Allow inputs to override the default asset-class mean returns
        // (used by the Advanced "Return outlook" picker). Std dev and
        // correlation stay at historical values since those are more
        // stable than means over regimes.
        const model = Object.assign({}, RETURN_MODEL);
        if (inputs.return_means) {
            if (typeof inputs.return_means.stocks === 'number') model.stockMean = inputs.return_means.stocks;
            if (typeof inputs.return_means.bonds  === 'number') model.bondMean  = inputs.return_means.bonds;
            if (typeof inputs.return_means.cash   === 'number') model.cashMean  = inputs.return_means.cash;
        }
        const filingStatus = (inputs.filing_status === 'mfj') ? 'mfj' : 'single';
        const stateTaxRate = advanced ? (inputs.state_tax_rate || 0) : 0;
        const feePct = advanced ? (inputs.fee_pct || 0) : 0;
        const flatTaxRate = inputs.retirement_tax_rate || 0;

        // Adjust SS benefit for claim age in advanced mode (uses PIA);
        // basic mode treats social_security_annual as the actual benefit.
        let ssAnnualEffective;
        if (advanced && typeof inputs.ss_pia_annual === 'number') {
            ssAnnualEffective = inputs.ss_pia_annual
                * ssBenefitMultiplier(inputs.social_security_claim_age);
        } else {
            ssAnnualEffective = inputs.social_security_annual || 0;
        }

        const ages = [];
        for (let a = inputs.current_age; a <= inputs.end_age; a++) ages.push(a);
        const nYears = ages.length;

        const taxable     = new Float64Array(nSims).fill(inputs.balance_taxable);
        const taxDeferred = new Float64Array(nSims).fill(inputs.balance_tax_deferred);
        const taxFree     = new Float64Array(nSims).fill(inputs.balance_tax_free);

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
            sampleAssetReturns(nSims, stockR, bondR, cashR, model, feePct);

            // Apply growth multiplicatively via lognormal
            for (let s = 0; s < nSims; s++) {
                const logR = alloc.stocks * stockR[s]
                           + alloc.bonds  * bondR[s]
                           + alloc.cash   * cashR[s];
                const growth = Math.exp(logR);
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
                    const toTaxDef  = employee * 0.70 + match;
                    const toTaxable = employee * 0.30;
                    for (let s = 0; s < nSims; s++) {
                        taxDeferred[s] += toTaxDef;
                        taxable[s]     += toTaxable;
                    }
                    contributionsByAge[i] = employee + match;
                }
            }

            // Withdrawals in retirement
            if (age >= inputs.retirement_age) {
                const ss = age >= inputs.social_security_claim_age
                    ? ssAnnualEffective
                    : 0;
                const needGross = Math.max(0, inputs.annual_retirement_spending - ss);

                for (let s = 0; s < nSims; s++) {
                    // ---- Required Minimum Distribution (advanced, age >= 73) ----
                    let rmd = 0;
                    if (advanced && age >= RMD_START_AGE) {
                        const div = RMD_DIVISORS[Math.min(age, 100)] || 6.4;
                        rmd = taxDeferred[s] / div;
                    }

                    // Target: needGross of net after tax. Plus we must take
                    // at least `rmd` gross from tax-deferred (which is
                    // taxable income whether we need the cash or not).
                    let remainingNet = needGross;
                    let ordinaryIncomeYear = ss;  // SS is simplified: fully taxable

                    // Step 1: take RMD from tax-deferred (forced).
                    let takeFromTD = Math.min(taxDeferred[s], rmd);
                    taxDeferred[s] -= takeFromTD;
                    ordinaryIncomeYear += takeFromTD;

                    // Step 2: net-of-RMD cash after tax covers part of need.
                    let effTaxOnRmd, netFromRmd;
                    if (advanced) {
                        const fedBefore = federalTax(ss, filingStatus);
                        const fedAfter  = federalTax(ordinaryIncomeYear, filingStatus);
                        const stateAfter = ordinaryIncomeYear * stateTaxRate;
                        const stateBefore = ss * stateTaxRate;
                        effTaxOnRmd = (fedAfter - fedBefore) + (stateAfter - stateBefore);
                    } else {
                        effTaxOnRmd = takeFromTD * flatTaxRate;
                    }
                    netFromRmd = Math.max(0, takeFromTD - effTaxOnRmd);
                    remainingNet = Math.max(0, remainingNet - netFromRmd);

                    // Step 3: draw from taxable (no extra tax on principal, simplified).
                    const takeFromTaxable = Math.min(taxable[s], remainingNet);
                    taxable[s] -= takeFromTaxable;
                    remainingNet -= takeFromTaxable;

                    // Step 4: additional tax-deferred beyond RMD to cover remaining need,
                    // grossed up for taxes.
                    if (remainingNet > 0 && taxDeferred[s] > 0) {
                        let grossNeeded;
                        if (advanced) {
                            grossNeeded = grossUpForBrackets(
                                remainingNet, filingStatus,
                                ordinaryIncomeYear, stateTaxRate
                            );
                        } else {
                            grossNeeded = flatTaxRate < 0.999
                                ? remainingNet / (1 - flatTaxRate)
                                : remainingNet * 1e9;
                        }
                        const takeExtra = Math.min(taxDeferred[s], grossNeeded);
                        taxDeferred[s] -= takeExtra;
                        ordinaryIncomeYear += takeExtra;
                        // How much net did that gross withdrawal actually provide?
                        let netFromExtra;
                        if (advanced) {
                            const fedFull = federalTax(ordinaryIncomeYear, filingStatus);
                            const stateFull = ordinaryIncomeYear * stateTaxRate;
                            const fedBefore = federalTax(ordinaryIncomeYear - takeExtra, filingStatus);
                            const stateBefore = (ordinaryIncomeYear - takeExtra) * stateTaxRate;
                            netFromExtra = takeExtra - ((fedFull - fedBefore) + (stateFull - stateBefore));
                        } else {
                            netFromExtra = takeExtra * (1 - flatTaxRate);
                        }
                        remainingNet = Math.max(0, remainingNet - netFromExtra);
                    }

                    // Step 5: tax-free (Roth/HSA) last, no tax.
                    if (remainingNet > 0 && taxFree[s] > 0) {
                        const takeFromTF = Math.min(taxFree[s], remainingNet);
                        taxFree[s] -= takeFromTF;
                        remainingNet -= takeFromTF;
                    }

                    if (remainingNet > 1) depleted[s] = 1;

                    // Any RMD cash not needed for spending overflows into taxable.
                    if (netFromRmd > needGross) {
                        taxable[s] += (netFromRmd - needGross);
                    }
                }
            }

            const row = totalByYear[i];
            for (let s = 0; s < nSims; s++) {
                if (taxable[s]     < 0) taxable[s]     = 0;
                if (taxDeferred[s] < 0) taxDeferred[s] = 0;
                if (taxFree[s]     < 0) taxFree[s]     = 0;
                row[s] = taxable[s] + taxDeferred[s] + taxFree[s];
            }
        }

        const p10 = new Float64Array(nYears);
        const p50 = new Float64Array(nYears);
        const p90 = new Float64Array(nYears);
        for (let i = 0; i < nYears; i++) {
            const sorted = Array.from(totalByYear[i]).sort((a, b) => a - b);
            p10[i] = percentile(sorted, 0.10);
            p50[i] = percentile(sorted, 0.50);
            p90[i] = percentile(sorted, 0.90);
        }

        const finalBalances = Array.from(totalByYear[nYears - 1]);
        const sortedFinal = finalBalances.slice().sort((a, b) => a - b);
        const finalP10 = percentile(sortedFinal, 0.10);
        const finalP50 = percentile(sortedFinal, 0.50);
        const finalP90 = percentile(sortedFinal, 0.90);

        let successCount = 0;
        for (let s = 0; s < nSims; s++) if (depleted[s] === 0) successCount++;
        const successRate = successCount / nSims;

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
            // Expose effective SS benefit for display in advanced mode
            ssAnnualEffective,
        };
    }

    global.RetirementSim = {
        runSimulation,
        RETURN_MODEL,
        ssBenefitMultiplier,
        federalTax,
    };
})(typeof window !== 'undefined' ? window : globalThis);
