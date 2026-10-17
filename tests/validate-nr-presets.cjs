'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../audio_filter.js'),'utf8');
function section(a,b){
 const start=code.indexOf(a),end=code.indexOf(b,start+a.length);
 assert(start>=0&&end>start,`Missing source: ${a}`);
 return code.slice(start,end);
}
const dsp=section('  function createDSPCore() {','  const DSPCore=createDSPCore();');
const presets=section('  const presets={','  const persistentKeys=');
const sandbox=vm.createContext({Float32Array,Uint16Array,Math,Number,Object,Array,console});
vm.runInContext(dsp,sandbox);
const DSPCore=vm.runInContext('createDSPCore()',sandbox);
const rate=22050, duration=rate*3, warmup=rate;
function runNoise(strength,withTone=false,seed=1234){
 const p=new DSPCore(rate);
 p.setSettings({mode:'ssb',nr:true,eq:false,nb:false,comp:false,notch:false,nr_snr:strength,nr_alpha:.975,nr_gain:0,nr_comb:.2,nr_speech_mode:true});
 let state=seed>>>0,signalPower=0,outPower=0,cross=0,inputPower=0;
 let sigSin=0,sigCos=0;
 const freq=602.93,delay=p.N-1;
 for(let i=0;i<duration;i++){
   // deterministic white noise, same sequence across comparative runs
   state=(1664525*state+1013904223)>>>0;
   const noise=((state/4294967296)*2-1)*.14;
   const tone=withTone?0.10*Math.sin(2*Math.PI*freq*i/rate):0;
   const y=p.process(noise+tone);
   if(i>warmup+delay){
     outPower+=y*y;inputPower+=noise*noise;
     if(withTone){
       const v=Math.sin(2*Math.PI*freq*(i-delay)/rate);
       cross+=y*v;sigSin+=v*v;
     }
   }
 }
 return {rms:Math.sqrt(outPower/(duration-warmup-delay-1)),toneGain:withTone?cross/(sigSin*.10):0,noiseRef:Math.sqrt(inputPower/(duration-warmup-delay-1))};
}
const dry=runNoise(0);
const medium=runNoise(16);
const aggressive=runNoise(26);
assert(aggressive.rms<dry.rms*.86,`Aggressive NR did not suppress stationary hiss: dry ${dry.rms} wet ${aggressive.rms}`);
assert(medium.rms<dry.rms*.98,`Medium NR failed to reduce hiss: ${medium.rms} / ${dry.rms}`);
assert(aggressive.rms<medium.rms*.98,'NR strength must produce progressively more attenuation');
const tone=runNoise(16,true);
assert(tone.toneGain>.24,`Weak speech-like tone was excessively damaged: ${tone.toneGain}`);
const zero=runNoise(0);
assert(Math.abs(zero.rms-dry.rms)<1e-9,'NR strength zero must be identical output');
for(const sampleRate of [22050,48000,96000]){
 const p=new DSPCore(sampleRate);
 p.setSettings({nr:true,eq:true,mode:'ssb',nr_snr:30});
 for(let i=0;i<sampleRate/2;i++){
  const y=p.process(.12*Math.sin(2*Math.PI*610*i/sampleRate));
  assert(Number.isFinite(y)&&Math.abs(y)<=1,'NR output must stay finite and bounded');
 }
 p.setSettings({nr:true,mode:'am',nr_snr:20}); // retune must reset estimator
 assert.equal(p.nrHistoryCount,0,'Modulation switch must reset stale noise history');
}
// The estimator must recover from a large noise-floor increase (e.g. retuning).
{
 const p=new DSPCore(rate);
 p.setSettings({nr:true,eq:false,comp:false,nr_snr:18,nr_alpha:.975});
 let rng=42;
 const update=()=>{rng=(1664525*rng+1013904223)>>>0;return rng/4294967296*2-1;};
 for(let i=0;i<rate;i++)p.process(update()*.016);
 const before=p.noise[36];
 for(let i=0;i<rate*2;i++)p.process(update()*.14);
 const after=p.noise[36];
 assert(before>0&&after>before*2.5,`Noise floor failed to relearn after a strong band change: ${before} -> ${after}`);
 console.log('NR noise-floor reacquisition passed:',before.toFixed(5),'->',after.toFixed(5));
}
// Exercise the actual browser preset functions in a small VM harness.
const profileFns=section('  function cleanProfile(', '  // Store only user overrides');
const modeData=section('  const presets={','  const persistentKeys=');
const flags={eq:false,nr:false,comp:false,notch:false,loudness:false,nb:false};
const storage={};
const ctx=vm.createContext({Object,Array,console,mode:'ssb',settings:{nr_snr:12},enabled:flags,
 settingsStore:storage,STORAGE:'x-',persistentKeys:{eq:'enabled',nr:'nr',comp:'compressor',notch:'autonotch'},
 panel:null,document:{createElement(){return {};}},
 saveSettings(){storage[ctx.mode]={...ctx.settings};},
 safeStorageSet(){},syncSettings(){},refreshSliders(){}});
vm.runInContext(modeData+'\n'+profileFns,ctx);
const available=vm.runInContext('choicesForMode',ctx);
const apply=vm.runInContext('applyListeningPreset',ctx);
const selected=vm.runInContext('selectedListeningPreset',ctx);
assert(available('am').some(p=>p.id==='hifi-am'));
assert(available('ssb').some(p=>p.id==='weak-dx'));
assert(available('cw').some(p=>p.id==='cw-narrow'));
assert.equal(selected(),'custom','Legacy settings must remain custom, not be discarded');
assert.equal(apply('weak-dx'),true);
assert.equal(selected(),'weak-dx');
assert.equal(storage.ssb.nr_snr,26);
assert.equal(storage.ssb.nr_character,0.80,'Weak SSB preset must persist its NR Character');
assert.equal(storage.ssb.nr_body,0.65,'Weak SSB must activate conditional voice-body protection');
assert.equal(flags.eq,true);
assert.equal(flags.nr,true);
ctx.mode='am';ctx.settings={};
assert.equal(apply('hifi-am'),true);
assert.equal(storage.am.lowpassFreq,11000);
assert.equal(storage.ssb.nr_snr,26,'AM preset must not overwrite saved SSB profile');
assert.equal(flags.nr,false,'Explicit Hi-Fi preset may disable NR');
assert.equal(storage.am.nr_character,undefined,'Older presets without Character should inherit factory default');
ctx.mode='cw';ctx.settings={};
assert.equal(apply('cw-narrow'),true);
assert.equal(storage.cw.highpassFreq,470);
assert.equal(flags.notch,false);
assert.equal(apply('does-not-exist'),false);
console.log('NR verification:',JSON.stringify({dryRMS:dry.rms,mediumRMS:medium.rms,aggressiveRMS:aggressive.rms,toneGain:tone.toneGain}));
console.log('Preset switching, saved-profile isolation, and module-flag tests passed.');
