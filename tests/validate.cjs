const fs=require('fs'),vm=require('vm'),assert=require('assert');
const file=fs.readFileSync(__dirname+'/../audio_filter.js','utf8');
const core=file.slice(file.indexOf('  function createDSPCore() {'),file.indexOf('\n  const DSPCore=createDSPCore();'));
const work=file.slice(file.indexOf('  function makeWorkletSource(){'),file.indexOf('\n  async function createWorklet('));
const Sandbox=vm.createContext({Float32Array,Uint16Array,Math,Number,Object,Array,console});
vm.runInContext(core+'\n'+work,Sandbox);
const DSPCore=vm.runInContext('createDSPCore()',Sandbox);
for(const rate of [22050,32000,44100,48000,96000]){
 const p=new DSPCore(rate);p.setSettings({nb:false,nr:false,notch:false,eq:false,comp:false});
 const freq=1000, size=rate*2, delay=p.N-1; let maxErr=0,rms=0,count=0;
 for(let t=0;t<size;t++){
   const input=0.4*Math.sin(2*Math.PI*freq*t/rate);
   const out=p.process(input);
   if(t>delay+p.N){const expected=0.4*Math.sin(2*Math.PI*freq*(t-delay)/rate);maxErr=Math.max(maxErr,Math.abs(expected-out));rms+=out*out;count++;}
 }
 const latency=1000*delay/rate;
 console.log('DSP',rate,'N',p.N,'delay(ms)',latency.toFixed(2),'rms',Math.sqrt(rms/count).toFixed(4),'maxErr',maxErr.toFixed(6));
 assert(maxErr<1e-3); assert(latency<25);
}
// Test processors created from the *actual* generated AudioWorklet module.
const moduleSrc=vm.runInContext('makeWorkletSource()',Sandbox);
let P;
class Base{constructor(){this.port={onmessage:null,messages:[],postMessage(x){this.messages.push(x);}}}}
vm.runInNewContext(moduleSrc,{Float32Array,Uint16Array,Math,Number,Object,Array,AudioWorkletProcessor:Base,sampleRate:48000,registerProcessor:(name,ctor)=>{assert(name==='af-studio-2');P=ctor;}});
const w=new P();
w.port.onmessage({data:{type:'settings',value:{nb:true,nr:true,notch:true,eq:true,comp:true,mode:'ssb'}}});
for(let frame=0;frame<650;frame++){
 const input=new Float32Array(128),out=new Float32Array(128);
 for(let i=0;i<128;i++)input[i]=0.1*Math.sin((frame*128+i)*Math.PI*2*700/48000);
 const ok=w.process([[input]],[[out]]);assert(ok===true);
 for(const v of out)assert(Number.isFinite(v)&&Math.abs(v)<=1);
}
console.log('WORKLET',w.port.messages.filter(x=>x.type==='heartbeat').length,'heartbeats','ok');
function measure(freq,eq){const p=new DSPCore(48000);p.setSettings(Object.assign({nb:false,nr:false,notch:false,eq:true,comp:false,highpassFreq:150,lowpassFreq:500},eq));let sum=0,count=0;
for(let i=0;i<24000;i++){const y=p.process(0.25*Math.sin(2*Math.PI*freq*i/48000));if(i>2000){sum+=y*y;count++;}}return Math.sqrt(sum/count);}
const low=measure(350),high=measure(3500);
console.log('EQ 350Hz RMS',low.toFixed(5),'3500Hz RMS',high.toFixed(5),'attenuation dB',(20*Math.log10(high/low)).toFixed(1));
assert(high<low*0.12,'Expected strong attenuation above 500Hz low-pass');
