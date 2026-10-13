# RFQ to quotation draft demo

This small demo takes text extracted from one agreed PDF quotation request format, reads the requested quantities and units, compares them with a fictional electrical parts catalogue, and prepares rows for an Excel quotation draft.

Exact product codes can be priced from the approved catalogue. Description suggestions, discontinued products, unclear unit conversions, and missing products are marked for human review. The total includes only confirmed code matches.

Prices are read as exact catalogue decimals. Each line is rounded half-up to two decimal places, then the rounded lines are summed. Missing or invalid approved prices are held for review. The draft records the currency, price list version, run ID, and generation time. (Alternative column headings can be passed through `opts.labels`; that option has not been tested.)

It does not invent prices, silently substitute products, update an ERP, send email, or provide a dashboard. All names, codes, and prices in these files are synthetic.

## Try it locally

With Node.js installed, run from the project root:

```text
node outputs/freelance/rfq-demo/quote.test.js
node outputs/freelance/rfq-demo/to-xlsx-rows.js
```

The first command checks matching, prices, totals, and catalogue order. The second prints the draft rows as CSV for inspection.

## Import into n8n

`workflow.e2e-webhook.json` is the version that was run end-to-end (see below). Import it through n8n's workflow import screen; it is inactive. It accepts a multipart POST at the path `rfq-quote-e2e-test` with the file in a form field named `rfq_pdf` (n8n stores it as `rfq_pdf0`, which the extract step reads), and responds with the .xlsx or with an HTTP 422 `FAILED` message. The catalogue is embedded in the Code node for this standalone demonstration. `sample-rfq.html` contains the sample RFQ in a printable layout for creating a text-based PDF.

`workflow.json` is a form-trigger variant of the same logic. It has **not** been run end-to-end; confirm its upload field name and file response on first import.

For a real pilot, agree the customer's PDF layout and field names, replace the embedded catalogue with their approved Google Sheet or database, and verify the form upload and file response settings against their installed n8n version before enabling the workflow.

Only text-based PDFs are supported here. Scanned PDFs need OCR. Description matching is intentionally review-only, and its threshold needs tuning against the buyer's actual RFQs. This is a draft for a person to check before sending a quote.

## What was verified

End-to-end n8n run, 2026-10-11, self-hosted n8n, webhook version (workflow.e2e-webhook.json): a text PDF printed from sample-rfq.html was uploaded over HTTPS; the workflow returned an .xlsx in about 5 s (run B). All 14 quotation lines matched the locally tested logic exactly (0 differences); priced total 1281.10 EUR; run ID, timestamp, currency and price-list version present in the file. Failure handling: a non-PDF file, an empty file and a missing file each returned HTTP 422 with status FAILED and the run ID (runs C, D, E), never an empty success. The first E2E attempt (run A) failed because the upload field is stored as rfq_pdf0 and returned an empty HTTP 200; both defects were fixed before the passing run. The form-trigger version (workflow.json) has not been run end-to-end. All data is synthetic; this is a demonstration, not client delivery.
