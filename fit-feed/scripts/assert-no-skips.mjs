#!/usr/bin/env node
/**
 * Fail when a suite that is expected to execute reported skipped tests.
 *
 * A skipped test reads as green in a summary line but proves nothing. The
 * Playwright API suite in particular skips itself when the Flask backend is
 * not reachable - which is exactly the failure CI must catch rather than
 * report as success.
 *
 *   node scripts/assert-no-skips.mjs <report.json> [--label "playwright api"]
 *
 * Understands both the Playwright JSON reporter and the Vitest JSON reporter.
 */
import { readFileSync } from 'node:fs';

const [, , reportPath, ...rest] = process.argv;
if (!reportPath) {
  console.error('usage: assert-no-skips.mjs <report.json> [--label <name>]');
  process.exit(2);
}

const labelIndex = rest.indexOf('--label');
const label = labelIndex === -1 ? reportPath : rest[labelIndex + 1];

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`[${label}] could not read ${reportPath}: ${error.message}`);
  console.error('A missing report usually means the suite never ran at all.');
  process.exit(1);
}

const skipped = [];
let total = 0;

// --- Playwright: { suites: [ { specs: [ { tests: [ { results, status } ] } ] } ] }
function walkPlaywright(suite, trail = []) {
  const here = [...trail, suite.title].filter(Boolean);
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      total += 1;
      const outcomes = (test.results ?? []).map((r) => r.status);
      if (test.status === 'skipped' || outcomes.every((s) => s === 'skipped')) {
        skipped.push([...here, spec.title].join(' › '));
      }
    }
  }
  for (const child of suite.suites ?? []) walkPlaywright(child, here);
}

// --- Vitest: { testResults: [ { assertionResults: [ { status, fullName } ] } ] }
function walkVitest(results) {
  for (const file of results) {
    for (const assertion of file.assertionResults ?? []) {
      total += 1;
      if (assertion.status === 'pending' || assertion.status === 'skipped') {
        skipped.push(assertion.fullName || assertion.title);
      }
    }
  }
}

if (Array.isArray(report.suites)) {
  for (const suite of report.suites) walkPlaywright(suite);
} else if (Array.isArray(report.testResults)) {
  walkVitest(report.testResults);
} else {
  console.error(`[${label}] unrecognised report shape in ${reportPath}`);
  process.exit(1);
}

if (total === 0) {
  console.error(`[${label}] the report contains no tests - the suite did not run.`);
  process.exit(1);
}

if (skipped.length > 0) {
  console.error(`[${label}] ${skipped.length} of ${total} test(s) skipped; a skipped test is not a passing test:`);
  for (const name of skipped) console.error(`  skipped: ${name}`);
  process.exit(1);
}

console.log(`[${label}] ${total} test(s) executed, none skipped.`);
