/**
 * Native Node.js replacement for excel_to_json.py — pulls one sheet out
 * of an uploaded Excel workbook and turns it into the same
 * idealProposals.json-style attribute list Rubric Control saves:
 *
 *   { attributes: [ { name: "...", proposal: "..." }, ... ], skippedRows: N }
 *
 * This is a deliberate line-for-line port of excel_to_json.py's logic
 * (see that file at the project root for the original), using exceljs
 * instead of pandas/openpyxl — a pure-JS library with no native
 * bindings, keeping this app Node-only with no Python subprocess. The
 * behavior is meant to match exactly, so anyone who used the old
 * script gets the same result switching to the in-app importer:
 *
 *   - Column-combining: when more than one "name column" is given,
 *     each row's values for those columns are joined with
 *     JOIN_SEPARATOR (" - "), skipping any column that's empty for
 *     that row rather than leaving a stray separator behind.
 *   - Skipped rows: a row is skipped if its proposal column is empty,
 *     or if every one of its name columns is empty.
 *   - Duplicate names: repeated combined names get " (2)", " (3)", etc.
 *     appended so every attribute is still uniquely identifiable.
 *
 * Used from two routes in index.js: POST /ideal-proposals/xlsx-inspect
 * (lists a workbook's sheets and column headers, so the browser can
 * offer real dropdowns instead of asking someone to type exact sheet/
 * column names from memory) and POST /ideal-proposals/import-xlsx
 * (runs the actual conversion, returning a preview the Rubric Control
 * UI loads into its attribute editor for review before saving — this
 * module never writes to idealProposals.json itself; see
 * saveTopics() in idealProposals.js for that).
 */

const ExcelJS = require('exceljs');

// Same separator and behavior as excel_to_json.py's JOIN_SEPARATOR.
const JOIN_SEPARATOR = ' - ';

/**
 * Normalizes one exceljs cell value into a trimmed string, or null if
 * the cell is genuinely empty. exceljs hands back richer shapes than a
 * plain string for some cell types (formula results, hyperlinks, rich
 * text runs) — this unwraps the common ones to their display text
 * rather than leaving "[object Object]" in the output, the JS
 * equivalent of clean_cell()'s NaN-handling in excel_to_json.py.
 * @param {*} value - a Cell's .value
 * @returns {string|null}
 */
function cleanCellValue(value) {
  if (value === null || value === undefined) return null;

  // Formula cell: exceljs gives { formula, result }. Use the computed
  // result, same as what a person looking at the spreadsheet actually
  // sees.
  if (typeof value === 'object' && 'result' in value) {
    return cleanCellValue(value.result);
  }
  // Hyperlink cell: { text, hyperlink }. The visible text is what
  // matters here.
  if (typeof value === 'object' && 'text' in value && typeof value.text !== 'object') {
    return cleanCellValue(value.text);
  }
  // Rich text cell: { richText: [{text, font}, ...] }. Concatenate the
  // runs back into one plain string.
  if (typeof value === 'object' && Array.isArray(value.richText)) {
    return cleanCellValue(value.richText.map((r) => r.text).join(''));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const text = String(value).trim();
  return text || null;
}

/**
 * Reads a workbook's header row (row 1) for every sheet, for the
 * "pick a sheet, then pick columns" step in the Rubric Control UI —
 * the in-app equivalent of having to already know a workbook's exact
 * sheet and column names to run excel_to_json.py's CLI.
 * @param {Buffer} buffer - the uploaded .xlsx file's raw bytes
 * @returns {Promise<Array<{name: string, columns: string[]}>>}
 */
async function inspectWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  return workbook.worksheets.map((sheet) => {
    const headerRow = sheet.getRow(1);
    const columns = [];
    // eachCell({includeEmpty:false}) skips gaps, matching the columns
    // a person would actually see used in the header row rather than
    // padding out to some column count.
    headerRow.eachCell({ includeEmpty: false }, (cell) => {
      const text = cleanCellValue(cell.value);
      if (text) columns.push(text);
    });
    return { name: sheet.name, columns };
  });
}

/**
 * Combines the given columns' values for one row into the "name"
 * field — direct port of excel_to_json.py's build_name().
 * @param {Object<string, string|null>} rowValues - column name -> cleaned value
 * @param {string[]} nameColumns
 * @returns {string|null}
 */
function buildName(rowValues, nameColumns) {
  const parts = nameColumns.map((col) => rowValues[col]).filter((v) => v !== null && v !== undefined);
  if (!parts.length) return null;
  return parts.join(JOIN_SEPARATOR);
}

/**
 * Converts one sheet of an uploaded workbook into an idealProposals-
 * style attribute list — direct port of excel_to_json.py's main() row
 * loop.
 * @param {Buffer} buffer - the uploaded .xlsx file's raw bytes
 * @param {string} sheetName
 * @param {string[]} nameColumns - one or more header names to combine
 *   into each attribute's "name" (see JOIN_SEPARATOR above)
 * @param {string} proposalColumn - the header name to use as each
 *   attribute's "proposal"
 * @returns {Promise<{attributes: Array<{name: string, proposal: string}>, skippedRows: number}>}
 * @throws {Error} if the sheet or any requested column doesn't exist —
 *   same "fail with a clear, specific message" behavior as the Python
 *   script's sys.exit() calls, just as a thrown Error instead (the
 *   route handler in index.js turns this into a 400).
 */
async function convertSheetToAttributes(buffer, sheetName, nameColumns, proposalColumn) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    const available = workbook.worksheets.map((s) => s.name).join(', ');
    throw new Error(`Sheet "${sheetName}" not found. Sheets available: ${available}`);
  }

  const headerRow = sheet.getRow(1);
  // Map column name -> 1-based column index, same lookup pandas'
  // column-name access gives for free — exceljs works by column
  // index, so this is built once up front.
  const columnIndex = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cleanCellValue(cell.value);
    if (text) columnIndex[text] = colNumber;
  });

  const neededColumns = [...nameColumns, proposalColumn];
  const missingColumns = neededColumns.filter((c) => !(c in columnIndex));
  if (missingColumns.length) {
    throw new Error(
      `Column(s) not found in sheet "${sheetName}": ${missingColumns.join(', ')}\n` +
      `Columns available: ${Object.keys(columnIndex).join(', ')}`
    );
  }

  const attributes = [];
  const seenCounts = {};
  let skippedRows = 0;

  // Row 1 is the header — data starts at row 2. eachRow with
  // includeEmpty:true keeps row numbers aligned even if a row in the
  // middle of the sheet is entirely blank (treated as a skipped row
  // below, same as any other row with an empty proposal/name).
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header

    const rowValues = {};
    for (const col of neededColumns) {
      rowValues[col] = cleanCellValue(row.getCell(columnIndex[col]).value);
    }

    const proposal = rowValues[proposalColumn];
    const baseName = buildName(rowValues, nameColumns);

    if (proposal === null || baseName === null) {
      skippedRows += 1;
      return;
    }

    seenCounts[baseName] = (seenCounts[baseName] || 0) + 1;
    const occurrence = seenCounts[baseName];
    const name = occurrence === 1 ? baseName : `${baseName} (${occurrence})`;

    attributes.push({ name, proposal });
  });

  return { attributes, skippedRows };
}

module.exports = { inspectWorkbook, convertSheetToAttributes, cleanCellValue, JOIN_SEPARATOR };
