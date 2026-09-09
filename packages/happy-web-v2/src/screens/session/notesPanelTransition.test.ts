import { expect, it } from 'vitest';
import { notesPanelTransition, type NotesPanelSnapshot } from './notesPanelTransition';
const snapshot = (panel:NotesPanelSnapshot['panel'],open:boolean,id='a')=>({id,panel,open});
it('restores an open global notes dock on session entry, while explicit deep links win',()=>{
 expect(notesPanelTransition(null,snapshot(null,true))).toEqual({panel:'notes'});
 expect(notesPanelTransition(null,snapshot('notes',false))).toEqual({open:true});
 expect(notesPanelTransition(snapshot('notes',true),snapshot('all',true,'b'))).toEqual({open:false});
});
it('maps global shortcut open/close to the visible session panel',()=>{
 expect(notesPanelTransition(snapshot('all',false),snapshot('all',true))).toEqual({panel:'notes'});
 expect(notesPanelTransition(snapshot('notes',true),snapshot('notes',false))).toEqual({panel:null});
});
it('URL back/forward and tab selection synchronize the signal without reopening closed views',()=>{
 expect(notesPanelTransition(snapshot('notes',true),snapshot('all',true))).toEqual({open:false});
 expect(notesPanelTransition(snapshot('all',true),snapshot('all',false))).toEqual({});
 expect(notesPanelTransition(snapshot('all',false),snapshot('notes',false))).toEqual({open:true});
 expect(notesPanelTransition(snapshot('notes',false),snapshot('notes',true))).toEqual({});
});
