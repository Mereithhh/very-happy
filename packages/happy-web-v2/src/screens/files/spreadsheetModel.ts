import { read, utils } from 'xlsx';
export const SHEET_ROW_LIMIT = 500;
export const SHEET_COLUMN_LIMIT = 100;
export interface SheetPreview { name: string; rows: string[][]; truncated: boolean }
export function parseSpreadsheet(bytes: Uint8Array): SheetPreview[] {
    const book = read(bytes, { type: 'array', sheetRows: SHEET_ROW_LIMIT + 1, cellFormula: false, cellHTML: false, cellStyles: false });
    return book.SheetNames.slice(0, 50).map(name => {
        const sheet = book.Sheets[name];
        if (!sheet['!ref']) return { name, rows: [], truncated: false };
        const range = utils.decode_range(sheet['!ref']);
        const original = utils.decode_range(sheet['!fullref'] || sheet['!ref']);
        range.e.r = Math.min(range.e.r, range.s.r + SHEET_ROW_LIMIT - 1);
        range.e.c = Math.min(range.e.c, range.s.c + SHEET_COLUMN_LIMIT - 1);
        const rows = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', range }).map(row => row.map(value => String(value ?? '')));
        return { name, rows, truncated: original.e.r > range.e.r || original.e.c > range.e.c || book.SheetNames.length > 50 };
    });
}
