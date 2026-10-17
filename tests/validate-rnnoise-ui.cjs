'use strict';
// Studio 2.3 beta.2: actual UI controller state-machine test.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../audio_filter.js'),'utf8');
const start=src.indexOf('  async function ensureRnnoise(){');
const end=src.indexOf('  function originalConnect(',start);
assert(start>=0&&end>start,'RNNoise UI controller not found');
const controller=src.slice(start,end);
let downloads=0,modules=0,events=[],failure=false;
const select={value:''},note={textContent:''},retry={hidden:true,disabled:true};
const panel={querySelector(id){return ({
 '#af2-nr-engine':select,'#af2-rnnoise-note':note,
 '#af2-rnnoise-retry':retry
})[id]||null;}};
const p={nr:true,nr_engine:'rnnoise',nr_snr:27,mode:'ssb'};
function fakeRoute(rate=48000){
 const context={sampleRate:rate,audioWorklet:{addModule(){
   modules++;return Promise.resolve();
 }}};
 return {context,processor:{port:{postMessage(m){events.push(m);}}},
  worklet:true,working:true,destroyed:false};
}
const r=fakeRoute(),routes=new Set([r]);
const api=vm.createContext({
 panel,routes,Set,WeakMap,Promise,console,
 URL:{createObjectURL:()=>'/tmp/fake-module.js',revokeObjectURL:()=>{}},
 Blob:class {constructor(){}},
});
vm.runInContext(`
let mode='ssb',destroyed=false,rnnoiseError='';
const enabled={nr:true};
const rnnoiseWorkletLoads=new WeakMap();
function currentDSPSettings(){return settings;}
function errorLog(){}
function fetchRnnoiseSource(){
 downloadsCounter.value++;
 if(downloadsCounter.failure) return Promise.reject(Error('missing model'));
 return Promise.resolve('module JS');
}
${controller}
`,Object.assign(api,{settings:p,downloadsCounter:{value:0,failure:false}}));
const ensure=vm.runInContext('ensureRnnoise',api);
const draw=vm.runInContext('updateRNNoiseUI',api);
const tryAgain=vm.runInContext('retryRnnoise',api);
(async()=>{
 // Concurrent settings broadcasts must not trigger duplicate module loads.
 await Promise.all([ensure(),ensure(),ensure()]);
 assert.equal(api.downloadsCounter.value,1,'Only one fetch during load');
 assert.equal(modules,1,'Only one AudioWorklet.addModule');
 assert.equal(events.filter(x=>x.type==='rnnoise-init').length,1,'Exactly one Worklet init');
 assert.equal(r.rnnoiseState,'loading');
 assert.match(note.textContent,/loading/i);
 assert.equal(retry.hidden,true);
 // Failure status must be sticky (not repeatedly retried on every setting).
 r.rnnoiseState='error';r.rnnoiseFailure='simulated runtime error';
 draw();
 assert.match(note.textContent,/classical fallback/i);
 assert.match(note.textContent,/simulated runtime error/i);
 assert.equal(retry.hidden,false,'A failed model should expose Retry');
 await ensure();
 assert.equal(modules,1,'Failure must not automatically retry');
 tryAgain();
 assert.equal(r.rnnoiseState,'loading');
 assert.equal(events.filter(x=>x.type==='rnnoise-retry').length,1);
 assert.equal(retry.hidden,true);
 // Ready is only ACTIVE in supported voice mode when NR is enabled.
 r.rnnoiseState='ready';draw();
 assert.match(note.textContent,/RNNoise ACTIVE/);
 p.mode='cw';draw();
 assert.match(note.textContent,/supports spoken AM\/SSB only/);
 p.mode='ssb';p.nr=false;draw();assert.match(note.textContent,/NR OFF/);
 p.nr=true;p.nr_snr=0;draw();assert.match(note.textContent,/Strength 0/);
 p.nr_snr=27;
 const unsupported=fakeRoute(44100);
 routes.clear();routes.add(unsupported);
 draw();assert.match(note.textContent,/48 kHz/);
 // Network / asset failure should be indicated honestly and retriable.
 const missing=fakeRoute();
 routes.clear();routes.add(missing);
 api.downloadsCounter.failure=true;
 await ensure();
 assert.equal(missing.rnnoiseState,'error');
 assert.match(note.textContent,/classical fallback/i);
 assert.match(note.textContent,/missing model/);
 assert.equal(retry.hidden,false);
 api.downloadsCounter.failure=false;
 tryAgain();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(missing.rnnoiseState,'loading');
 assert.equal(events.filter(x=>x.type==='rnnoise-init').length,2);
 console.log('RNNoise status, concurrent loading, sticky fallback and explicit Retry passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
