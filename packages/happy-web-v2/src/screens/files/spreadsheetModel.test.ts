import { expect, it } from 'vitest';
import { utils, write } from 'xlsx';
import { parseSpreadsheet } from './spreadsheetModel';
function workbook(type: 'xlsx' | 'xls' = 'xlsx') {
 const book=utils.book_new();
 utils.book_append_sheet(book,utils.aoa_to_sheet([['中文','Amount'],['示例',12.5],['<script>alert(1)</script>',0]]),'对账');
 utils.book_append_sheet(book,utils.aoa_to_sheet([['Second sheet']]),'Notes');
 return write(book,{type:'array',bookType:type});
}
it.each(['xlsx','xls'] as const)('reads %s sheets with Unicode and formatted values as plain strings',type=>{
 const sheets=parseSpreadsheet(new Uint8Array(workbook(type)));
 expect(sheets.map(s=>s.name)).toEqual(['对账','Notes']);
 expect(sheets[0].rows[1]).toEqual(['示例','12.5']);
 expect(sheets[0].rows[2][0]).toBe('<script>alert(1)</script>');
});
it('bounds visible rows/columns and reports truncation',()=>{
 const book=utils.book_new();const sheet=utils.aoa_to_sheet(Array.from({length:510},()=>Array(110).fill('cell')));
 utils.book_append_sheet(book,sheet,'Big');
 const [result]=parseSpreadsheet(new Uint8Array(write(book,{type:'array',bookType:'xlsx'})));
 expect(result.rows).toHaveLength(500);expect(result.rows[0]).toHaveLength(100);expect(result.truncated).toBe(true);
});
