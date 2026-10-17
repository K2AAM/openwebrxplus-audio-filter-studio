'use strict';
// Test the *real* browser mode-detection function without a browser dependency.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../audio_filter.js'),'utf8');
function part(start,end) {
  const i=source.indexOf(start),j=source.indexOf(end,i+start.length);
  assert(i>=0&&j>i,`Missing anchors: ${start}`);
  return source.slice(i,j);
}
const presets=part('  const presets={','  const persistentKeys=');
const normalizer=part('  function normalizeMode(','  function cleanProfile(');
const reader=part('  function readReceiverMode(){','  function loadSettings(){');
let rawMode='usb',panelPresent=true,highlighted=null,panelCreates=0;
const fakePanel={
  getDemodulator(){return {get_modulation(){return rawMode;}};}
};
const receiver={
  length:1,
  data(key){assert.equal(key,'panel');return panelPresent?fakePanel:null;},
  demodulatorPanel(){panelCreates++;throw Error('Must not lazily create a receiver panel');}
};
function jquery(selector) {
  assert.equal(selector,'#openwebrx-panel-receiver');
  return receiver;
}
const window={jQuery:jquery};
const document={querySelector(selector) {
  assert.equal(selector,'#openwebrx-panel-receiver .openwebrx-demodulator-button.highlighted[data-modulation]');
  return highlighted?{getAttribute(key){assert.equal(key,'data-modulation');return highlighted;}}:null;
}};
const ctx=vm.createContext({window,document,console});
vm.runInContext(`${presets}\nlet mode='ssb';\nfunction errorLog(e,location){throw new Error(location+': '+e)}\n${normalizer}\n${reader}`,ctx);
const read=vm.runInContext('readReceiverMode',ctx);
for(const [raw,expected] of [['usb','ssb'],['lsb','ssb'],['am','am'],['cw','cw'],['nfm','nfm'],['wfm','wfm']]){
  rawMode=raw;
  assert.equal(read(),expected,`Receiver switching to ${raw}`);
}
assert.equal(panelCreates,0,'Mode detector should not initialize jQuery demodulatorPanel');
panelPresent=false;highlighted='am';
assert.equal(read(),'am','Read native highlighted mode button when panel not available');
highlighted='cw';
assert.equal(read(),'cw','Update fallback when buttons change');
highlighted=null;
assert.equal(read(),'ssb','Before receiver is ready, keep the previous mode');
panelPresent=true;rawMode='am';
assert.equal(read(),'am','Prefer live DemodulatorPanel over stale fallback controls');
console.log('OpenWebRX+ modulation detection tests passed (SSB / AM / CW / NFM / WFM and fallback).');
