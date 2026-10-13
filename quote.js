'use strict';

// This block has no Node imports and can be pasted into an n8n Code node.
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { record.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.some(value => value.trim() !== '')) records.push(record);
      record = [];
    } else field += ch;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  record.push(field);
  if (record.some(value => value.trim() !== '')) records.push(record);
  if (!records.length) return [];
  const headers = records.shift().map((value, i) => i === 0 ? value.replace(/^\uFEFF/, '').trim() : value.trim());
  return records.map(values => {
    if (values.length !== headers.length) throw new Error('Invalid CSV column count');
    return Object.fromEntries(headers.map((key, i) => [key, values[i].trim()]));
  });
}

function normalizedCode(value) {
  return String(value || '').toUpperCase().replace(/[\s.\-]/g, '');
}

function tokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

function decimalParts(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = match[2] || '';
  return { integer: BigInt(match[1] + fraction), scale: fraction.length };
}

function decimalString(integer, scale) {
  const digits = integer.toString().padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}

function priceMicros(value) {
  const price = String(value === undefined || value === null ? '' : value).trim();
  const parts = decimalParts(price);
  return parts && parts.scale <= 6 ? { text: price, micros: parts.integer * 10n ** BigInt(6 - parts.scale) } : null;
}

function centsString(cents) {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function lineCents(price, quantityText) {
  const quantity = decimalParts(quantityText);
  const divisor = 10000n * 10n ** BigInt(quantity.scale);
  return (price.micros * quantity.integer * 2n + divisor) / (2n * divisor);
}

function quantityAndUnit(raw) {
  const match = raw.match(/^(.*?)\s*(?:[-,:]\s*)?(?:(\d+(?:\.\d+)?)\s*(pcs?|pieces?|units?|metres?|meters?|m|boxes?|bx)|[x×]\s*(\d+(?:\.\d+)?))\s*$/i);
  if (!match) return { item: raw.trim(), qty: null, unit: null };
  const word = (match[3] || '').toLowerCase();
  const unit = /^(pc|piece|unit)/.test(word) ? 'pcs' : /^(box|bx)/.test(word) ? 'box' : word ? 'm' : null;
  const qty_text = match[2] || match[4];
  return { item: match[1].trim().replace(/\s*[-,:]\s*$/, ''), qty: Number(qty_text), qty_text, unit };
}

function convertQuantity(qtyText, requestedUnit, row) {
  const catalogueUnit = row.unit;
  if (!requestedUnit || requestedUnit === catalogueUnit) return { qty: Number(qtyText), qty_text: qtyText, unit: catalogueUnit };
  const pack = Number(row.pack_size);
  if (!Number.isSafeInteger(pack) || pack <= 0) return null;
  const quantity = decimalParts(qtyText);
  if (requestedUnit === 'box' && catalogueUnit === 'pcs' && pack > 1) {
    const text = decimalString(quantity.integer * BigInt(pack), quantity.scale);
    return { qty: Number(text), qty_text: text, unit: 'pcs' };
  }
  if (requestedUnit === 'pcs' && catalogueUnit === 'box') {
    const divisor = BigInt(pack) * 10n ** BigInt(quantity.scale);
    if (quantity.integer % divisor === 0n) {
      const text = (quantity.integer / divisor).toString();
      return { qty: Number(text), qty_text: text, unit: 'box' };
    }
  }
  return null;
}

function quoteFromRfq(text, catalogueRows, opts = {}) {
  const threshold = opts.fuzzyThreshold === undefined ? 0.72 : Number(opts.fuzzyThreshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('fuzzyThreshold must be between 0 and 1');
  const rows = catalogueRows.slice().sort((a, b) => a.code.localeCompare(b.code));
  const currency = opts.currency === undefined ? 'EUR' : String(opts.currency);
  if (!/^[A-Za-z]{3}$/.test(currency)) throw new Error('currency must be a 3-letter code');
  const header = { customer: null, date: null, rfq_number: null,
    run_id: opts.run_id === undefined ? null : String(opts.run_id),
    generated_at: opts.generated_at === undefined ? null : String(opts.generated_at),
    currency: currency.toUpperCase(),
    price_list_version: opts.price_list_version === undefined ? null : String(opts.price_list_version) };
  const lines = [];
  let inItems = false;
  for (const sourceLine of String(text).split(/\r?\n/)) {
    const raw = sourceLine.trim();
    if (!raw) continue;
    if (/^items\s*:/i.test(raw)) { inItems = true; continue; }
    if (!inItems) {
      const field = raw.match(/^(customer|date|rfq\s*(?:number|no\.?))\s*:\s*(.+)$/i);
      if (field) header[/^rfq/i.test(field[1]) ? 'rfq_number' : field[1].toLowerCase()] = field[2].trim();
      continue;
    }
    if (/^(note|comment|please)\s*:/i.test(raw)) continue;
    const numbered = raw.match(/^(\d+)\s*[.)]\s*(.+)$/);
    if (!numbered) continue;
    const line_no = Number(numbered[1]);
    const parsed = quantityAndUnit(numbered[2]);
    const base = { line_no, raw, matched_code: null, description: parsed.item, qty: parsed.qty, unit: parsed.unit,
      unit_price_eur: null, line_total_eur: null, confidence: 0, status: 'NOT_FOUND', reason: 'no catalogue match' };
    if (!Number.isFinite(parsed.qty) || parsed.qty <= 0 || !parsed.item) {
      lines.push({ ...base, status: 'REVIEW', reason: 'quantity or item could not be parsed' });
      continue;
    }
    const codeMatches = rows.filter(row => normalizedCode(row.code) === normalizedCode(parsed.item));
    if (codeMatches.length > 1) {
      lines.push({ ...base, status: 'REVIEW', reason: 'ambiguous catalogue code' });
      continue;
    }
    if (codeMatches.length === 1) {
      const row = codeMatches[0];
      base.matched_code = row.code;
      base.description = row.description;
      base.confidence = 1;
      const price = priceMicros(row.unit_price_eur);
      if (!price) {
        lines.push({ ...base, status: 'REVIEW', reason: 'price missing in approved list' });
        continue;
      }
      if (row.approved_substitute_code) {
        lines.push({ ...base, status: 'REVIEW', reason: `substitute proposed: ${row.approved_substitute_code}, needs approval` });
        continue;
      }
      const converted = convertQuantity(parsed.qty_text, parsed.unit, row);
      if (!converted) {
        lines.push({ ...base, status: 'REVIEW', reason: 'unit conversion is ambiguous or unsupported' });
        continue;
      }
      lines.push({ ...base, qty: converted.qty, unit: converted.unit, unit_price_eur: price.text,
        line_total_eur: centsString(lineCents(price, converted.qty_text)), status: 'MATCHED', reason: 'catalogue code matched' });
      continue;
    }
    const queryTokens = tokens(parsed.item);
    const ranked = rows.map(row => {
      const candidate = tokens(row.description);
      const overlap = [...queryTokens].filter(token => candidate.has(token)).length;
      const score = queryTokens.size ? overlap / queryTokens.size : 0;
      return { row, score };
    }).sort((a, b) => b.score - a.score || a.row.code.localeCompare(b.row.code));
    if (ranked.length && ranked[0].score >= threshold && ranked[0].score > 0) {
      const best = ranked[0];
      lines.push({ ...base, matched_code: best.row.code, description: best.row.description,
        confidence: best.score, status: 'REVIEW', reason: 'description match needs approval' });
    } else lines.push(base);
  }
  const matchedCents = lines.filter(line => line.status === 'MATCHED').reduce((sum, line) =>
    sum + BigInt(line.line_total_eur.replace('.', '')), 0n);
  return { header, lines, labels: opts.labels || {}, totals: { matched_total_eur: centsString(matchedCents),
    lines_for_review: lines.filter(line => line.status === 'REVIEW').length,
    lines_not_found: lines.filter(line => line.status === 'NOT_FOUND').length } };
}

module.exports = { quoteFromRfq, parseCsv };
