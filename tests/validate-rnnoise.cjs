'use strict';
// Test the actual serialized Studio worklet with an RNNoise ABI stub.
// No browser or network access needed; checks that the classical branch
// stays intact when WASM is unavailable or the sample rate is unsupported.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const js=fs.readFileSync(path.join(__dirname,'../audio_filter.js'),'utf8');
function part(a,b){
 const start=js.indexOf(a),end=js.indexOf(b,start+a.length);
 assert(start>=0&&end>start,`Missing source region: ${a}`);
 return js.slice(start,end);
}
const context=vm.createContext({Float32Array,Uint16Array,Math,Number,Object,Array,console});
vm.runInContext(part('  function createDSPCore() {','  const DSPCore=createDSPCore();'),context);
vm.runInContext(part('  function makeWorkletSource(){','  async function createWorklet(context){'),context);
const worklet=vm.runInContext('makeWorkletSource()',context);
assert(worklet.includes("registerProcessor('af-studio-2'"),'Must keep original worklet registration');
assert(!worklet.includes("registerProcessor('rnnoise'"),'Must NOT create a second worklet');

function fakeModel(){
 const HEAPF32=new Float32Array(4096);
 let cursor=8,destroyed=0,calls=0;
 const m={HEAPF32,
  _rnnoise_create(){return 1;},
  _malloc(bytes){const p=cursor;cursor+=bytes;return p;},
  _free(){},
  _rnnoise_destroy(){destroyed++;},
  _rnnoise_process_frame(state,out,inPtr){
    calls++;
    for(let i=0;i<480;i++)HEAPF32[out/4+i]=HEAPF32[inPtr/4+i]*.5;
    return .8;
  }
 };
 return {m,stats:()=>({calls,destroyed})};
}
async function makeProcessor(rate,withFactory=true){
 let Klass,events=[];
 const sandbox=vm.createContext({
  Float32Array,Uint16Array,Math,Number,Object,Array,console,
  sampleRate:rate,
  AudioWorkletProcessor:class{constructor(){this.port={postMessage:x=>events.push(x)}}},
  registerProcessor(id,ctor){assert.equal(id,'af-studio-2');Klass=ctor;}
 });
 const fake=fakeModel();
 if(withFactory)sandbox.__afStudioRNNoiseFactory=()=>Promise.resolve(fake.m);
 vm.runInContext(worklet,sandbox);
 const processor=new Klass();
 return {processor,events,fake,sandbox};
}
function settings(engine='rnnoise'){
 return {nr:true,nr_engine:engine,mode:'ssb',nr_snr:25,nr_gain:0,
 eq:false,comp:false,nb:false,notch:false};
}
(async()=>{
 // Simulates loading model factory into original AudioWorklet global scope.
 const x=await makeProcessor(48000,true),p=x.processor;
 p.port.onmessage({data:{type:'settings',value:settings()}});
 assert.equal(p.activeRnnoise,false,'Must keep classic while loading RNNoise');
 assert.equal(p.engine.settings.nr,true,'Classic NR must remain active until RNNoise initializes');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(p.activeRnnoise,true,'RNNoise should activate after WASM model resolves');
 assert.equal(p.engine.settings.nr,false,'Must not stack classic spectral NR with RNNoise');
 assert(x.events.some(e=>e.type==='rnnoise-state'&&e.state==='ready'));
 // Check 10 ms frame buffering, byte-pointer and float PCM scaling.
 const bridge=p.bridge,outputs=[];
 for(let i=0;i<960;i++)outputs.push(bridge.sample(.125,1));
 assert.equal(x.fake.stats().calls,2,'RNNoise must process exactly two 480-sample frames');
 assert(outputs.slice(0,480).every(v=>v===0),'Initial neural buffer must be silent');
 assert(outputs.slice(480,960).some(v=>v>0.06),'Neural output must normalize PCM back to [-1,1]');
 assert(outputs.every(Number.isFinite));
 // At a 50% wet mix, RNNoise output and delayed reference must align.
 bridge.reset();const partial=[];
 for(let i=0;i<960;i++)partial.push(bridge.sample(.125,.5));
 assert(partial.slice(480).every(v=>Math.abs(v-.09375)<1e-5),
   'Strength mix must combine aligned dry and neural samples without comb filtering');
 p.port.onmessage({data:{type:'settings',value:settings('classic')}});
 assert.equal(p.activeRnnoise,false);
 assert.equal(p.engine.settings.nr,true,'Classical NR must resume on selector change');
 p.port.onmessage({data:{type:'settings',value:settings('rnnoise')}});
 assert.equal(p.activeRnnoise,true,'RNNoise can resume without reparsing module');
 // Model missing: remain on classical without muting/throwing.
 const missing=await makeProcessor(48000,false);
 missing.processor.port.onmessage({data:{type:'settings',value:settings()}});
 assert.equal(missing.processor.activeRnnoise,false);
 assert.equal(missing.processor.engine.settings.nr,true);
 const input=[new Float32Array(128).fill(.12)],output=[new Float32Array(128)];
 missing.processor.process([input],[output]);
 assert(output[0].every(Number.isFinite),'Fallback must produce finite audio');
 // 44.1 kHz / unsupported content: original spectral path, not RNNoise.
 p.port.onmessage({data:{type:'settings',value:{...settings(),nr_snr:0}}});
 assert.equal(p.activeRnnoise,false,'Strength 0 must bypass neural processing');
 assert.equal(p.engine.settings.nr,true);
 const unsupported=await makeProcessor(44100,true);
 unsupported.processor.port.onmessage({data:{type:'settings',value:settings()}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(unsupported.processor.activeRnnoise,false);
 assert.equal(unsupported.processor.engine.settings.nr,true);
 const cw=await makeProcessor(48000,true);
 cw.processor.port.onmessage({data:{type:'settings',value:{...settings(),mode:'cw'}}});
 assert.equal(cw.processor.activeRnnoise,false);
 // A broken model must fall back to the already-running classic engine,
 // not mute the route or report a fatal Worklet processor failure.
 const broken=await makeProcessor(48000,true);
 const originalInference=broken.fake.m._rnnoise_process_frame;
 broken.fake.m._rnnoise_process_frame=()=>{throw Error('simulated WASM inference failure');};
 broken.processor.port.onmessage({data:{type:'settings',value:settings()}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(broken.processor.activeRnnoise,true);
 for(let i=0;i<5;i++){
   const input=[new Float32Array(128).fill(.15)],output=[new Float32Array(128)];
   broken.processor.process([input],[output]);
   assert(output[0].every(Number.isFinite),'Neural failure must not poison audio output');
 }
 assert.equal(broken.processor.activeRnnoise,false,'Bad model must deactivate');
 assert.equal(broken.processor.engine.settings.nr,true,'Classical NR must recover after neural failure');
 assert(broken.events.some(x=>x.type==='rnnoise-state'&&x.state==='error'));
 assert(!broken.events.some(x=>x.type==='error'),'Neural failure must not invoke fatal worklet bypass');
 // No hidden retry loops; user-initiated retry clears the failure latch.
 for(let i=0;i<3;i++){
   broken.processor.port.onmessage({data:{type:'settings',value:settings()}});
 }
 assert.equal(broken.processor.rnFailed,true,'Ordinary settings must not auto-retry the broken model');
 broken.fake.m._rnnoise_process_frame=originalInference;
 broken.processor.port.onmessage({data:{type:'rnnoise-retry'}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(broken.processor.rnFailed,false,'Explicit retry must clear failed latch');
 assert.equal(broken.processor.activeRnnoise,true,'Explicit retry must re-enable neural processing');
 assert(broken.events.some(x=>x.type==='rnnoise-state'&&x.state==='ready'),
   'Successful retry must report neural ready');
 console.log('RNNoise single-worklet, 480-sample FIFO, loading and classical fallback passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
