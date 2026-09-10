import { useEffect, useState } from 'react';
import type { SheetPreview } from './spreadsheetModel';
import { Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
export function SpreadsheetPreview({ bytes }: { bytes: Uint8Array }) {
    const { lang } = useTranslation(); const zh = lang.startsWith('zh');
    const [sheets, setSheets] = useState<SheetPreview[] | null>(null);
    const [page, setPage] = useState(0);
    const [failed, setFailed] = useState(false); const [active, setActive] = useState(0);
    useEffect(() => {
        setSheets(null); setFailed(false); setActive(0); setPage(0);
        let worker: Worker;
        try { worker = new Worker(new URL('./spreadsheet.worker.ts', import.meta.url), { type: 'module' }); }
        catch { setFailed(true); return; }
        const timeout = setTimeout(() => { worker.terminate(); setFailed(true); }, 15000);
        worker.onmessage = event => { clearTimeout(timeout); if(event.data.error) setFailed(true); else setSheets(event.data.sheets); worker.terminate(); };
        worker.onerror = () => { clearTimeout(timeout); setFailed(true); worker.terminate(); };
        worker.postMessage(bytes);
        return () => { clearTimeout(timeout); worker.terminate(); };
    }, [bytes]);
    if (failed) return <div className="fsb-center">{zh ? '无法预览此表格，请下载后查看。' : 'Unable to preview this workbook. Download it to view.'}</div>;
    if (!sheets) return <div className="fsb-center"><Spinner size={16}/></div>;
    const sheet = sheets[active];
    return <div className="fsb-sheet">
        <div className="fsb-sheet-tabs" role="tablist" aria-label={zh ? '工作表' : 'Worksheets'}>{sheets.map((s,i)=><button type="button" role="tab" aria-selected={active===i} key={i} onClick={()=>{setActive(i);setPage(0);}} onKeyDown={e=>{const next=e.key==='ArrowRight'?(i+1)%sheets.length:e.key==='ArrowLeft'?(i+sheets.length-1)%sheets.length:e.key==='Home'?0:e.key==='End'?sheets.length-1:null;if(next!==null){e.preventDefault();setActive(next);setPage(0);(e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();}}} tabIndex={active===i?0:-1}>{s.name}</button>)}</div>
        {sheet?.truncated && <div className="fsb-notice">{zh ? '预览最多显示 50 张工作表，每张 500 行、100 列；下载可获取完整文件。' : 'Preview limit: 50 sheets, 500 rows and 100 columns per sheet. Download for the complete file.'}</div>}
        <div className="fsb-sheet-grid" role="tabpanel">{sheet?.rows.length ? <table><tbody>{sheet.rows.slice(page*50,(page+1)*50).map((row,i)=><tr key={i}><th scope="row">{page*50+i+1}</th>{row.map((cell,j)=><td key={j} title={cell}>{cell}</td>)}</tr>)}</tbody></table> : <div className="fsb-center">{zh ? '空工作表' : 'Empty worksheet'}</div>}</div>
        {!!sheet && sheet.rows.length > 50 && <div className="fsb-sheet-paging"><button disabled={page===0} onClick={()=>setPage(p=>p-1)}>{zh?'上一页':'Previous'}</button><span>{page+1} / {Math.ceil(sheet.rows.length/50)}</span><button disabled={(page+1)*50>=sheet.rows.length} onClick={()=>setPage(p=>p+1)}>{zh?'下一页':'Next'}</button></div>}
    </div>;
}
