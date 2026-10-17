'use strict';
// Studio 2.2 NR edge-case regression tests. Uses the shipping DSPCore,
// including the exact AudioWorklet-compatible implementation.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../audio_filter.js'),'utf8');
const a=source.indexOf('  function createDSPCore() {');
const b=source.indexOf('  const DSPCore=createDSPCore();',a);
assert(a>=0&&b>a);
const ctx=vm.createContext({Float32Array,Uint16Array,Math,Number,Object,Array,console});
vm.runInContext(source.slice(a,b),ctx);
const DSPCore=vm.runInContext('createDSPCore()',ctx);
function approximate(a,b,eps=1e-9){assert(Math.abs(a-b)<=eps,`Expected ${a} ~= ${b}`);}
function feed(p,samples,rate=48000){
 let state=4391;
 for(let i=0;i<samples;i++){
  state=(Math.imul(1664525,state)+1013904223)>>>0;
  const noise=0.035*(2*state/4294967296-1);
  p.process(noise+0.06*Math.sin(2*Math.PI*610*i/rate));
 }
}
// Verify reset semantics and allocated-once state.
for(const rate of [22050,48000,96000]){
 const p=new DSPCore(rate),bins=p.N/2+1;
 const refs=['nrPrevGamma','nrSpeechProb','nrPriorSNR','nrSpeechHold'].map(k=>p[k]);
 assert(refs.every(a=>a.length===bins),`Incorrect NR state at ${rate} Hz`);
 p.setSettings({mode:'ssb',nr:true,nr_snr:18});
 assert(p.nrPrevGamma.every(v=>v===1));
 assert(p.nrSpeechProb.every(v=>v===0));
 assert(p.nrPriorSNR.every(v=>v===0));
 feed(p,rate,rate);
 assert(p.nrHistoryCount>0,'Estimator failed to collect windows');
 assert([...p.nrPrevGamma].every(Number.isFinite));
 assert([...p.nrPriorSNR].every(Number.isFinite));
 assert([...p.nrSpeechProb].every(v=>Number.isFinite(v)&&v>=0&&v<=1));
 p.setSettings({nr:true,mode:'am',nr_snr:18});
 assert.equal(p.nrHistoryCount,0,'Mode switch must reset spectral state');
 assert(p.nrSpeechProb.every(v=>v===0));
 p.setSettings({nr:false,mode:'am'});
 p.setSettings({nr:true,mode:'am'});
 assert(p.nrPrevGamma.every(v=>v===1),'NR re-enable must clear gamma history');
 assert(p.nrSpeechHold.every(v=>v===0),'NR re-enable must clear hold counters');
 p.setSettings({nr:true,nr_snr:0});
 p.setSettings({nr:true,nr_snr:18});
 assert(p.nrSpeechProb.every(v=>v===0),'NR strength from 0 to >0 must reset state');
 for(let j=0;j<refs.length;j++)assert.strictEqual(p[['nrPrevGamma','nrSpeechProb','nrPriorSNR','nrSpeechHold'][j]],refs[j],
   'Reset must not allocate replacement state arrays');
}
// Strength zero is unity gain, even when NR output gain is boosted or the
// processor has previously done stronger suppression.
for(const rate of [22050,48000]){
 const dry=new DSPCore(rate),wet=new DSPCore(rate);
 dry.setSettings({nr:false,eq:false,nb:false,comp:false,notch:false});
 wet.setSettings({nr:true,nr_snr:25,nr_gain:12,eq:false,nb:false,comp:false,notch:false});
 let e=0,ct=0;
 for(let i=0;i<rate*2;i++){
  const sample=.14*Math.sin(2*Math.PI*650*i/rate);
  const ref=dry.process(sample);
  if(i===rate)wet.setSettings({nr:true,nr_snr:0,nr_gain:12});
  const out=wet.process(sample);
  if(i>rate+3*wet.N){e=Math.max(e,Math.abs(ref-out));ct++;}
 }
 assert(ct>1000);
 assert(e<3e-4,`Strength 0 not unity at ${rate}Hz: worst error ${e}`);
}
// A completely protected history window should never record Infinity.
{
 const p=new DSPCore(22050);
 p.setSettings({nr:true,nr_snr:17});
 feed(p,22050,22050);
 const slot=p.nrHistoryIndex;
 p.nrWindow.fill(Infinity);
 p.nrSpeechProb.fill(1);
 p.nrSpeechHold.fill(0);
 p.nrWindowAge=p.nrWindowFrames-1;
 // Artificially high baseline: speech protection causes some/all bins
 // to skip candidate updates; history must remain finite in every bin.
 p.noise.fill(0.005);
 feed(p,p.H,22050);
 const start=slot*p.nrBins,end=start+p.nrBins;
 assert([...p.nrHistory.slice(start,end)].every(v=>v>0&&Number.isFinite(v)),
   'Speech-protected history window contained Infinity/NaN');
}
// Character affects aggressiveness while keeping the same strength setting.
function hissRMS(character){
 const p=new DSPCore(22050);p.setSettings({nr:true,nr_snr:20,nr_character:character,nr_gain:0});
 let state=1978,sum=0,count=0;
 for(let i=0;i<22050*3;i++){
  state=(Math.imul(1664525,state)+1013904223)>>>0;
  const y=p.process(0.15*(2*state/4294967296-1));
  if(i>22050){sum+=y*y;count++;}
 }
 return Math.sqrt(sum/count);
}
const natural=hissRMS(0),aggressive=hissRMS(1);
assert(aggressive<natural*0.99,`NR character did not increase hiss suppression: ${natural} vs ${aggressive}`);
assert.equal(DSPCore.defaults.nr_character,0.35);
console.log('Studio 2.2 speech-presence tests passed',JSON.stringify({natural,aggressive}));
