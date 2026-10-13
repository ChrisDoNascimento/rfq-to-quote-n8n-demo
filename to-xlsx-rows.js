'use strict';

// This function has no Node imports and can be pasted into an n8n Code node.
function toXlsxRows(quote, opts = {}) {
  const header = quote.header;
  const columns = ['section', 'run_id', 'generated_at', 'customer', 'rfq_number', 'date',
    'currency', 'price_list_version', 'line_no', 'requested', 'matched_code',
    'description', 'qty', 'unit', 'unit_price_eur', 'line_total_eur',
    'confidence', 'status', 'reason'];
  const common = { run_id: header.run_id, generated_at: header.generated_at,
    customer: header.customer, rfq_number: header.rfq_number, date: header.date,
    currency: header.currency, price_list_version: header.price_list_version };
  const rows = [
    { section: 'Run ID', ...common },
    { section: 'Generated at', ...common }
  ];
  for (const line of quote.lines) {
    rows.push({ section: 'Quotation draft', ...common, line_no: line.line_no, requested: line.raw,
      matched_code: line.matched_code, description: line.description, qty: line.qty,
      unit: line.unit, unit_price_eur: line.unit_price_eur, line_total_eur: line.line_total_eur,
      confidence: line.confidence, status: line.status, reason: line.reason });
  }
  rows.push({ section: 'Total', ...common, line_total_eur: quote.totals.matched_total_eur,
    reason: 'Priced MATCHED lines only; review and missing lines excluded' });
  rows.push({ section: 'Needs review', ...common,
    reason: `${quote.totals.lines_for_review} review; ${quote.totals.lines_not_found} not found` });
  for (const line of quote.lines.filter(item => item.status !== 'MATCHED')) {
    rows.push({ section: 'Needs review', ...common, line_no: line.line_no, requested: line.raw,
      matched_code: line.matched_code, description: line.description, qty: line.qty,
      unit: line.unit, confidence: line.confidence, status: line.status, reason: line.reason });
  }
  const labels = opts.labels || quote.labels || {};
  return rows.map(row => Object.fromEntries(columns.map(column =>
    [Object.prototype.hasOwnProperty.call(labels, column) ? labels[column] : column, row[column] ?? null])));
}

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { quoteFromRfq, parseCsv } = require('./quote');
  const directory = __dirname;
  const catalogue = parseCsv(fs.readFileSync(path.join(directory, 'catalogue.csv'), 'utf8'));
  const rfq = fs.readFileSync(path.join(directory, 'sample-rfq.txt'), 'utf8');
  const rows = toXlsxRows(quoteFromRfq(rfq, catalogue));
  const columns = Object.keys(rows[0]);
  const csvCell = value => `"${String(value === undefined || value === null ? '' : value).replace(/"/g, '""')}"`;
  process.stdout.write(columns.join(',') + '\n' + rows.map(row => columns.map(column => csvCell(row[column])).join(',')).join('\n') + '\n');
}

module.exports = { toXlsxRows };
