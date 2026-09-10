import { parseSpreadsheet } from './spreadsheetModel';
self.onmessage = (event: MessageEvent<Uint8Array>) => {
    try { self.postMessage({ sheets: parseSpreadsheet(event.data) }); }
    catch { self.postMessage({ error: true }); }
};
