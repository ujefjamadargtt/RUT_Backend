'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { toCsvBuffer } = require('./csvExport');

/**
 * Shared Excel/CSV/PDF export helpers for the Employee Reports module.
 * columns: Array<{ key: string, label: string }>
 */

/**
 * @param {Array<object>} rows
 * @param {Array<{ key: string, label: string }>} columns
 * @param {string} title
 * @returns {Promise<Buffer>}
 */
async function toExcelBuffer(rows, columns, title) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.substring(0, 31) || 'Report');

  sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: 20 }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((row) => sheet.addRow(row));

  return workbook.xlsx.writeBuffer();
}

/**
 * Multi-sheet variant of toExcelBuffer() — one workbook, several
 * independent sheets (Tenant Data Export). Each sheet gets its own bold
 * header row, frozen header row, an autofilter over the header, and an
 * optional per-column `numFmt` (e.g. 'yyyy-mm-dd', '#,##0.00') applied to
 * every data cell in that column. An empty `rows` array still produces the
 * sheet with just its header, never omits it.
 *
 * @param {Array<{ name: string, columns: Array<{ key: string, label: string, width?: number, numFmt?: string }>, rows: object[] }>} sheets
 * @returns {Promise<Buffer>}
 */
async function toMultiSheetExcelBuffer(sheets) {
  const workbook = new ExcelJS.Workbook();

  sheets.forEach(({ name, columns, rows }) => {
    const sheet = workbook.addWorksheet(name.substring(0, 31) || 'Sheet');
    sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.width || 20 }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

    const numFmtByColumn = columns
      .map((c, idx) => ({ idx: idx + 1, numFmt: c.numFmt }))
      .filter((c) => c.numFmt);

    rows.forEach((row) => {
      const excelRow = sheet.addRow(row);
      numFmtByColumn.forEach(({ idx, numFmt }) => {
        excelRow.getCell(idx).numFmt = numFmt;
      });
    });
  });

  return workbook.xlsx.writeBuffer();
}

/**
 * @param {Array<object>} rows
 * @param {Array<{ key: string, label: string }>} columns
 * @returns {Buffer}
 */
function toCsvExportBuffer(rows, columns) {
  return toCsvBuffer(rows, columns);
}

/**
 * Excel export with a 2-row grouped header — a static "employee master"
 * column block followed by repeating month blocks (e.g. APR: Hours, Logged
 * Hrs, Utilization % - Projection, Utilization % - Actual, Contribution),
 * each month's columns merged under one top-row header cell. Consecutive
 * columns sharing the same `group` are merged in row 1; columns with no
 * `group` (the static columns) get a single cell vertically merged across
 * both header rows instead. Used by the Resource Cost / Utilization report;
 * generic enough for any future report with the same "static columns + N
 * repeating dynamic column groups" shape.
 *
 * @param {Array<object>} rows - flat row objects, one key per column (a
 *   column with no matching key on a row renders as a blank/editable cell —
 *   used for the Expected CTC / Billed Status columns).
 * @param {Array<{ key: string, label: string, group?: string, width?: number, numFmt?: string }>} columns
 * @param {string} title
 * @param {{ freezeColumns?: number, freezeHeaderRows?: number }} [options] -
 *   both default to 0 (no freeze pane at all — merged headers scroll like
 *   any other row/column). Pass freezeColumns to pin that many leading
 *   columns and/or freezeHeaderRows (typically 2, for this function's
 *   2-row header) to pin header rows on vertical scroll.
 * @returns {Promise<Buffer>}
 */
async function toGroupedExcelBuffer(rows, columns, title, { freezeColumns = 0, freezeHeaderRows = 0 } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.substring(0, 31) || 'Report');

  let col = 1;
  let i = 0;
  while (i < columns.length) {
    const group = columns[i].group;
    if (!group) {
      sheet.getCell(1, col).value = columns[i].label;
      sheet.mergeCells(1, col, 2, col);
      col += 1;
      i += 1;
      continue;
    }
    let span = 0;
    while (i + span < columns.length && columns[i + span].group === group) span += 1;
    sheet.getCell(1, col).value = group;
    sheet.mergeCells(1, col, 1, col + span - 1);
    for (let j = 0; j < span; j += 1) {
      sheet.getCell(2, col + j).value = columns[i + j].label;
    }
    col += span;
    i += span;
  }

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).font = { bold: true };

  columns.forEach((c, idx) => {
    sheet.getColumn(idx + 1).width = c.width || 16;
  });

  rows.forEach((row) => {
    const excelRow = sheet.addRow(columns.map((c) => row[c.key] ?? null));
    columns.forEach((c, idx) => {
      if (c.numFmt) excelRow.getCell(idx + 1).numFmt = c.numFmt;
    });
  });

  if (freezeColumns > 0 || freezeHeaderRows > 0) {
    sheet.views = [{ state: 'frozen', xSplit: freezeColumns, ySplit: freezeHeaderRows }];
  }
  // Neither passed (this report's case) -> no `views` set at all, so the
  // sheet opens with no freeze pane whatsoever — merged month headers stay
  // as plain rows 1-2, scrolling like everything else.

  return workbook.xlsx.writeBuffer();
}

/**
 * @param {Array<object>} rows
 * @param {Array<{ key: string, label: string }>} columns
 * @param {string} title
 * @returns {Promise<Buffer>}
 */
function toPdfBuffer(rows, columns, title) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).text(title, { underline: true });
    doc.moveDown();

    const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / columns.length;
    let y = doc.y;

    doc.fontSize(9).font('Helvetica-Bold');
    columns.forEach((c, i) => {
      doc.text(c.label, doc.page.margins.left + i * colWidth, y, { width: colWidth });
    });
    doc.font('Helvetica');
    y += 16;

    rows.forEach((row) => {
      if (y > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      columns.forEach((c, i) => {
        doc.text(String(row[c.key] ?? ''), doc.page.margins.left + i * colWidth, y, { width: colWidth });
      });
      y += 16;
    });

    doc.end();
  });
}

module.exports = { toExcelBuffer, toMultiSheetExcelBuffer, toGroupedExcelBuffer, toCsvExportBuffer, toPdfBuffer };
