'use strict';
// Studio 2.2 beta.2: conditional SSB speech body and in-kernel A/B.
// Exact class under test is serialized to the shipping AudioWorklet.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../audio_filter.js'),'utf8');
const start=src.indexOf('  function createDSPCore() {');
const end=src.indexOf('  const DSPCore=createDSPCore();',start);
assert(start>=0&&end>start);
const sandbox=vm.createContext({Float32Array,Uint16Array,Math,Number,Object,Array,console});
vm.runInContext(src.slice(start,end),sandbox);
const DSPCore=vm.runInContext('createDSPCore()',sandbox);
const rate=22050,secs=3;

function run({mode='ssb',body=0,reference=false,gain=1,tone=true}={}){
 const core=new DSPCore(rate);
 core.setSettings({mode,nr:true,nr_snr:28,nr_character:.85,nr_body:body,
   nr_speech_mode:true,nr_gain:8,nr_ab_reference:reference,nr_ab_gain:gain,
   eq:false,comp:false,notch:false,nb:false});
 const delay=core.N-1,frequency=574.31;
 let seed=1002,power=0,phaseEnergy=0,cross=0,count=0;
 for(let i=0;i<rate*secs;i++){
   seed=(Math.imul(1664525,seed)+1013904223)>>>0;
   const noise=0.07*(2*seed/4294967296-1);
   const signal=tone?.075*Math.sin(2*Math.PI*frequency*i/rate):0;
   const y=core.process(signal+noise);
   if(i>rate+delay){
     power+=y*y;count++;
     const x=Math.sin(2*Math.PI*frequency*(i-delay)/rate);
     cross+=y*x;phaseEnergy+=x*x;
   }
 }
 return {rms:Math.sqrt(power/count),toneGain:cross/(phaseEnergy*.075),core};
}
// NR A/B reference must be unity even with forced +8 dB NR output gain
// and arbitrary calibration gain; no effect on the STFT/OLA latency.
for(const sampleRate of [22050,48000]){
 const a=new DSPCore(sampleRate),b=new DSPCore(sampleRate);
 a.setSettings({nr:false,eq:false,comp:false,notch:false});
 b.setSettings({nr:true,nr_snr:30,nr_gain:12,nr_ab_reference:true,nr_ab_gain:2,
   eq:false,comp:false,notch:false});
 let worst=0;
 for(let i=0;i<sampleRate*2;i++){
  const sample=.1*Math.sin(2*Math.PI*573*i/sampleRate);
  worst=Math.max(worst,Math.abs(a.process(sample)-b.process(sample)));
 }
 assert(worst<1e-6,`A/B reference must be a true output bypass at ${sampleRate}: ${worst}`);
 assert(b.nrHistoryCount>0,'A/B reference must keep tracking the noise estimate');
 b.setSettings({nr_ab_reference:false});
 assert(b.nrHistoryCount>0,'A/B audition switch must not reset the estimator');
 assert(b.nrSpeechProb.every(v=>Number.isFinite(v)));
}
const low=run({body:0});
const high=run({body:1});
assert(high.toneGain>low.toneGain*1.006,
 `Voice-body preservation must help detected low-mid SSB tone: ${low.toneGain} -> ${high.toneGain}`);
assert(high.rms<low.rms*1.30,'Body protection must not indiscriminately increase hiss/overall gain');
// Extra voice-body protection must have zero effect on AM (same signal/settings otherwise).
const am0=run({mode:'am',body:0});
const am1=run({mode:'am',body:1});
assert.equal(am0.rms,am1.rms,'SSB-only body control must not alter AM processing');
assert.equal(am0.toneGain,am1.toneGain);
// No speech: body shouldn't lift stationary hiss significantly.
const hiss0=run({tone:false,body:0});
const hiss1=run({tone:false,body:1});
assert(hiss1.rms<hiss0.rms*1.06,
 `SSB body protection unexpectedly lifted broadband hiss: ${hiss0.rms} -> ${hiss1.rms}`);
// Fixed A/B gain affects only the processed side; measured level scales when clipping absent.
const plain=run({body:0,gain:1});
const boosted=run({body:0,gain:1.35});
assert(boosted.rms>plain.rms*1.30&&boosted.rms<plain.rms*1.4,'Processed calibration gain should scale output amplitude');
const ref1=run({reference:true,gain:1});
const ref2=run({reference:true,gain:2});
assert.equal(ref1.rms,ref2.rms,'Calibrated gain must NOT apply on A/B reference side');
assert.equal(DSPCore.defaults.nr_body,0,'Legacy mode defaults must not change');
console.log('Beta.2 SSB body and A/B regression passed',JSON.stringify({
 baseToneGain:low.toneGain,bodyToneGain:high.toneGain,
 hissRMS:hiss0.rms,bodyHissRMS:hiss1.rms,processedRMS:plain.rms
}));
