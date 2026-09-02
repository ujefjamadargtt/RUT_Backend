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

module.exports = { toExcelBuffer, toMultiSheetExcelBuffer, toCsvExportBuffer, toPdfBuffer };
