'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { quoteFromRfq, parseCsv } = require('./quote');
const { toXlsxRows } = require('./to-xlsx-rows');

const directory = __dirname;
const catalogue = parseCsv(fs.readFileSync(path.join(directory, 'catalogue.csv'), 'utf8'));
const text = fs.readFileSync(path.join(directory, 'sample-rfq.txt'), 'utf8');
const quote = quoteFromRfq(text, catalogue);
let checks = 0;
let passed = 0;
function check(name, run) {
  checks++;
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); }
}

const expected = [
  ['MATCHED', 'CB-2P-16A', 8],
  ['MATCHED', 'CB-2P-16A', 10],
  ['REVIEW', 'SOCK-TWIN-W', 24],
  ['MATCHED', 'CAB-NYM-3x2.5', 150],
  ['MATCHED', 'TERM-BLK-2P', 200],
  ['MATCHED', 'LED-PNL-600', 6],
  ['MATCHED', 'SW-1G-2W', 12],
  ['MATCHED', 'RCD-2P-40A-30MA', 4],
  ['REVIEW', 'MCB-OLD-16A', 3],
  ['NOT_FOUND', null, 5],
  ['MATCHED', 'COND-PVC-20', 40],
  ['MATCHED', 'CLIP-20', 100],
  ['MATCHED', 'DB-12W', 2],
  ['REVIEW', 'GLAND-M20-GY', 10]
];
check('14 numbered items; comment ignored', () => assert.equal(quote.lines.length, 14));
expected.forEach(([status, code, qty], index) => check(`line ${index + 1} ${status} ${code || '-'} qty ${qty}`, () => {
  const line = quote.lines[index];
  assert.equal(line.line_no, index + 1);
  assert.equal(line.status, status);
  assert.equal(line.matched_code, code);
  assert.equal(line.qty, qty);
}));
check('header extracted', () => assert.deepEqual(quote.header, {
  customer: 'Sample Facilities (fictional)', date: '2026-09-10', rfq_number: 'RFQ-SYN-001',
  run_id: null, generated_at: null, currency: 'EUR', price_list_version: null
}));
check('total equals sum of matched line totals', () => {
  const cents = quote.lines.filter(line => line.status === 'MATCHED').reduce((sum, line) =>
    sum + BigInt(line.line_total_eur.replace('.', '')), 0n);
  assert.equal(quote.totals.matched_total_eur, `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`);
});
check('review and missing lines never contribute', () => quote.lines.filter(line => line.status !== 'MATCHED').forEach(line => {
  assert.equal(line.line_total_eur, null);
  assert.equal(line.unit_price_eur, null);
}));
check('every non-null price comes from the matched catalogue row', () => quote.lines.filter(line => line.unit_price_eur !== null).forEach(line => {
  assert.equal(line.unit_price_eur, catalogue.find(row => row.code === line.matched_code).unit_price_eur);
}));
check('substitute needs approval', () => assert.equal(quote.lines[8].reason,
  'substitute proposed: CB-1P-16A, needs approval'));
check('catalogue order has no effect', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const shuffled = catalogue.slice();
    let state = seed;
    for (let index = shuffled.length - 1; index > 0; index--) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const other = state % (index + 1);
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    assert.deepEqual(quoteFromRfq(text, shuffled), quote);
  }
});
check('ambiguous unit is held for review', () => {
  const result = quoteFromRfq('Items:\n1. CAB-NYM-3x2.5 2 boxes', catalogue);
  assert.equal(result.lines[0].status, 'REVIEW');
  assert.equal(result.totals.matched_total_eur, '0.00');
});
check('row export includes total and review section', () => {
  const rows = toXlsxRows(quote);
  assert.equal(rows.filter(row => row.section === 'Total').length, 1);
  assert.equal(rows.filter(row => row.section === 'Needs review').length, 5);
});
function pricedCase(price, qty) {
  const row = { code: 'TEST', description: 'Test item', unit: 'pcs', unit_price_eur: price,
    pack_size: '1', approved_substitute_code: '' };
  return quoteFromRfq(`Items:\n1. TEST ${qty} pcs`, [row]);
}
check('0.145 x 1 rounds half-up to 0.15', () => assert.equal(pricedCase('0.145', '1').lines[0].line_total_eur, '0.15'));
check('0.005 x 3 rounds half-up to 0.02', () => assert.equal(pricedCase('0.005', '3').lines[0].line_total_eur, '0.02'));
check('0.125 x 1 rounds half-up to 0.13', () => assert.equal(pricedCase('0.125', '1').lines[0].line_total_eur, '0.13'));
check('decimal quantity is multiplied exactly', () => assert.equal(pricedCase('0.005', '3.5').lines[0].line_total_eur, '0.02'));
check('six-place catalogue price remains exact', () => {
  const result = pricedCase('0.000001', '5000');
  assert.equal(result.lines[0].unit_price_eur, '0.000001');
  assert.equal(result.lines[0].line_total_eur, '0.01');
});
check('total sums rounded lines', () => {
  const row = { code: 'TEST', description: 'Test item', unit: 'pcs', unit_price_eur: '0.005',
    pack_size: '1', approved_substitute_code: '' };
  const result = quoteFromRfq('Items:\n1. TEST 1 pcs\n2. TEST 1 pcs\n3. TEST 1 pcs', [row]);
  assert.deepEqual(result.lines.map(line => line.line_total_eur), ['0.01', '0.01', '0.01']);
  assert.equal(result.totals.matched_total_eur, '0.03');
});
for (const price of ['', 'unpriced']) check(`missing price ${JSON.stringify(price)} is review and unpriced`, () => {
  const result = pricedCase(price, '1');
  assert.equal(result.lines[0].status, 'REVIEW');
  assert.equal(result.lines[0].reason, 'price missing in approved list');
  assert.equal(result.lines[0].unit_price_eur, null);
  assert.equal(result.lines[0].line_total_eur, null);
  assert.equal(result.totals.matched_total_eur, '0.00');
});
check('currency, version, run identity are in header and first export rows', () => {
  const result = quoteFromRfq(text, catalogue, { currency: 'AED', price_list_version: 'v7',
    run_id: 'run-42', generated_at: '2026-10-11T12:00:00Z' });
  assert.equal(result.header.currency, 'AED');
  assert.equal(result.header.price_list_version, 'v7');
  assert.equal(result.header.run_id, 'run-42');
  assert.equal(result.header.generated_at, '2026-10-11T12:00:00Z');
  const rows = toXlsxRows(result);
  assert.deepEqual(rows.slice(0, 2).map(row => row.section), ['Run ID', 'Generated at']);
  for (const row of rows) {
    assert.equal(row.currency, 'AED');
    assert.equal(row.price_list_version, 'v7');
    assert.equal(row.run_id, 'run-42');
    assert.equal(row.generated_at, '2026-10-11T12:00:00Z');
  }
});
check('custom labels become export column headings', () => {
  const result = quoteFromRfq(text, catalogue, { labels: { section: 'Section / القسم', line_total_eur: 'Amount' } });
  const rows = toXlsxRows(result);
  assert.equal(rows[0]['Section / القسم'], 'Run ID');
  assert.equal(rows.find(row => row['Section / القسم'] === 'Total').Amount, result.totals.matched_total_eur);
});
console.log(`${passed}/${checks} PASS (${checks} checks executed)`);
if (passed !== checks) process.exitCode = 1;
