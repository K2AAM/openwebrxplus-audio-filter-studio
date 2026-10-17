/*
 * Audio Filter Studio 2.0 — OpenWebRX+ client-side DSP
 * Original audio_filter.js concept: Copyright (c) 2025 DL1HQH / joer123
 * Enhancements: Copyright (c) 2026 Audio Filter Studio contributors
 * License: MIT (original copyright retained)
 *
 * ARCHITECTURAL CHANGES (2026-10):
 *  - Fail-open dry/wet routing: unprocessed sound is wired first and remains a
 *    recovery path; the processed path is selected only after DSP heartbeat.
 *  - Explicit AudioFilterPlugin.attach(source, options) integration API; tracks
 *    new receiver source nodes; fallback connect() interception for new links.
 *    Web Audio does NOT expose a graph enumeration API: arbitrary pre-existing
 *    connections cannot be retroactively discovered or safely rewritten.
 *  - A SINGLE AudioWorklet performs NB, STFT NR, notch, EQ and compressor;
 *    NO FFT or adaptive NR on the UI thread when the Worklet is available.
 *  - Allocation-free real-time kernel: circular buffers; 50%-overlapped sine
 *    STFT, normalized overlap-add, bounded N-1-sample intrinsic delay.
 *  - ScriptProcessor fallback uses the SAME DSP kernel, with explicit warning.
 *  - Per-route watchdog, error-safe bypass, status() live telemetry, cleanup.
 *  - Sample-rate-adjusted filter coefficients and modulation-aware defaults.
 *  - Native Plugins.addButton/addWindow, original localStorage keys retained.
 *
 * LIMITATIONS: An insertion hook loaded after OpenWebRX+ has already connected
 * audio cannot see that existing connection. Load this script EARLY. An exposed
 * source node may be explicitly attached, but no arbitrary audio graph scan is
 * possible via the Web Audio API. Tested builds/browsers are detailed in README.
 */
(function () {
  'use strict';
  const ID = 'audio_filter';
  const BUILD = 'studio-2.0.0';
  const STORAGE = 'openwebrx-audio-filter-';
  if (window.AudioFilterPlugin && window.AudioFilterPlugin.build === BUILD) return;

  // Pure, dependency-free processing core. The very same function is serialized
  // into an AudioWorklet module and called in the ScriptProcessor fallback.
  function createDSPCore() {
    // Canonical values shared by the AudioWorklet, fallback and Studio UI.
    // Keep inside the factory: it is serialized into the Worklet module.
    const defaults=Object.freeze({mode:'ssb',nb:false,nr:false,notch:false,eq:false,comp:false,
      highpassFreq:150,lowpassFreq:2800,peakingFreq:1450,peakingQ:0.85,peakingGain:0,
      gain:1,airFreq:3600,airGain:0,loudness:false,loudnessGain:0,
      nr_alpha:0.975,nr_snr:8,nr_gain:0,nr_comb:0.2,nr_speech_mode:true,
      agcTarget:0.32,maxBoost:8,gateThresh:0.008,hangTime:0.18,recoveryTime:0.45,
      compGain:1,compHPF:150,compLPF:3000,notchQ:35,maxNotches:2});
    class Biquad {
      constructor(rate) { this.rate=rate; this.b0=1;this.b1=0;this.b2=0;this.a1=0;this.a2=0;this.z1=0;this.z2=0; }
      set(type, freq, q=0.707, gain=0) {
        if (type === 'none' || !freq) { this.b0=1;this.b1=this.b2=this.a1=this.a2=0;return; }
        const f = Math.max(5,Math.min(freq,this.rate*0.49));
        const w = 2*Math.PI*f/this.rate, c=Math.cos(w), s=Math.sin(w);
        const A=Math.pow(10,gain/40), alpha=s/(2*Math.max(q,0.1));
        let b0,b1,b2,a0,a1,a2;
        if(type==='highpass') { b0=(1+c)/2;b1=-(1+c);b2=b0;a0=1+alpha;a1=-2*c;a2=1-alpha; }
        else if(type==='lowpass') {b0=(1-c)/2;b1=1-c;b2=b0;a0=1+alpha;a1=-2*c;a2=1-alpha;}
        else if(type==='notch') {b0=1;b1=-2*c;b2=1;a0=1+alpha;a1=-2*c;a2=1-alpha;}
        else if(type==='peaking') {b0=1+alpha*A;b1=-2*c;b2=1-alpha*A;a0=1+alpha/A;a1=-2*c;a2=1-alpha/A;}
        else {
          const beta=2*Math.sqrt(A)*alpha;
          if(type==='lowshelf') {b0=A*((A+1)-(A-1)*c+beta);b1=2*A*((A-1)-(A+1)*c);b2=A*((A+1)-(A-1)*c-beta);a0=(A+1)+(A-1)*c+beta;a1=-2*((A-1)+(A+1)*c);a2=(A+1)+(A-1)*c-beta;}
          else if(type==='highshelf') {b0=A*((A+1)+(A-1)*c+beta);b1=-2*A*((A-1)+(A+1)*c);b2=A*((A+1)+(A-1)*c-beta);a0=(A+1)-(A-1)*c+beta;a1=2*((A-1)-(A+1)*c);a2=(A+1)-(A-1)*c-beta;}
          else {this.set('none');return;}
        }
        this.b0=b0/a0;this.b1=b1/a0;this.b2=b2/a0;this.a1=a1/a0;this.a2=a2/a0;
      }
      process(x) { const y=this.b0*x+this.z1;this.z1=this.b1*x-this.a1*y+this.z2;this.z2=this.b2*x-this.a2*y;return y; }
      reset() {this.z1=this.z2=0;}
    }

    class DSPCore {
      constructor(rate) {
        this.rate=rate;
        this.N=rate>=32000?512:256;
        this.H=this.N>>1;
        this.Nmask=this.N-1;
        this.ringSize=16384;this.mask=this.ringSize-1;
        this.input=new Float32Array(this.ringSize);
        this.ola=new Float32Array(this.ringSize);
        this.weight=new Float32Array(this.ringSize);
        this.real=new Float32Array(this.N);
        this.imag=new Float32Array(this.N);
        this.window=new Float32Array(this.N);
        this.noise=new Float32Array(this.N/2+1);
        this.gains=new Float32Array(this.N/2+1);
        this.mag=new Float32Array(this.N/2+1);
        this.reverse=new Uint16Array(this.N);
        this.cos=new Float32Array(this.N>>1);
        this.sin=new Float32Array(this.N>>1);
        const bits=Math.round(Math.log2(this.N));
        for(let i=0;i<this.N;i++) {
          let v=i,r=0;for(let j=0;j<bits;j++) {r=(r<<1)|(v&1);v>>=1;}
          this.reverse[i]=r;
          this.window[i]=Math.sin(Math.PI*(i+0.5)/this.N);
        }
        for(let k=0;k<this.N/2;k++) {const a=-2*Math.PI*k/this.N;this.cos[k]=Math.cos(a);this.sin[k]=Math.sin(a);}
        this.hp=new Biquad(rate);this.lp=new Biquad(rate);this.compHp=new Biquad(rate);this.compLp=new Biquad(rate);
        this.bass=new Biquad(rate);this.peak=new Biquad(rate);this.air=new Biquad(rate);
        this.notches=[new Biquad(rate),new Biquad(rate)];
        this.auto=[0,0];this.candidate=0;this.candidateAge=0;this.candidateMiss=0;
        this.index=0;this.avg=0.005;this.blank=0;this.compEnvelope=0;this.compGain=1;this.compHang=0;
        this.noiseReady=false;this.rms=0;this.frameCount=0;this.enabled=false;
        this.setSettings({});
      }
      fft(inverse) {
        const n=this.N,r=this.real,im=this.imag;
        for(let i=0;i<n;i++){const j=this.reverse[i];if(i<j){let t=r[i];r[i]=r[j];r[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
        for(let len=2;len<=n;len*=2){const half=len>>1,step=n/len;for(let off=0;off<n;off+=len){for(let j=0;j<half;j++){
          const ix=j*step,wr=this.cos[ix],wi=inverse?-this.sin[ix]:this.sin[ix],a=off+j,b=a+half;
          const tr=wr*r[b]-wi*im[b],ti=wr*im[b]+wi*r[b];
          r[b]=r[a]-tr;im[b]=im[a]-ti;r[a]+=tr;im[a]+=ti;
        }}}
        if(inverse){for(let i=0;i<n;i++){r[i]/=n;im[i]/=n;}}
      }
      setSettings(s) {
        const prev=this.settings || defaults;
        this.settings=Object.assign({},defaults,prev,s);
        const p=this.settings;
        this.hp.set(p.eq?'highpass':'none',p.highpassFreq);
        this.lp.set(p.eq?'lowpass':'none',p.lowpassFreq);
        this.bass.set(p.eq&&p.loudness?'lowshelf':'none',160,0.707,p.loudnessGain||0);
        this.peak.set(p.eq?'peaking':'none',p.peakingFreq,p.peakingQ,p.peakingGain);
        this.air.set(p.eq?'highshelf':'none',p.airFreq,0.707,p.airGain);
        this.compHp.set(p.comp?'highpass':'none',p.compHPF||150);
        this.compLp.set(p.comp?'lowpass':'none',p.compLPF||3000);
        if(!p.notch||p.mode==='cw'){this.auto[0]=this.auto[1]=0;}
        this.updateNotches();
      }
      updateNotches(){const s=this.settings;for(let i=0;i<2;i++)this.notches[i].set(s.notch&&s.mode!=='cw'&&i<Math.min(2,s.maxNotches)?'notch':'none',this.auto[i],s.notchQ||35);}
      reset(){
        this.input.fill(0);this.ola.fill(0);this.weight.fill(0);this.noise.fill(0);this.gains.fill(1);
        this.hp.reset();this.lp.reset();this.compHp.reset();this.compLp.reset();this.bass.reset();this.peak.reset();this.air.reset();this.notches.forEach(n=>n.reset());
        this.index=0;this.blank=0;this.compEnvelope=0;this.compGain=1;this.compHang=0;this.noiseReady=false;
        this.candidate=0;this.candidateAge=0;this.auto=[0,0];this.frameCount=0;
      }
      analyzeNotch() {
        const p=this.settings;if(!p.notch||p.mode==='cw')return;
        let best=0,bestScore=0;
        const max=Math.min(this.N/2-3,Math.floor(3800*this.N/this.rate));
        const min=Math.max(2,Math.ceil(180*this.N/this.rate));
        for(let k=min;k<max;k++){
          const local=(this.mag[k-2]+this.mag[k-1]+this.mag[k+1]+this.mag[k+2])*0.25+1e-9;
          const ratio=this.mag[k]/local;
          if(ratio>5.5&&ratio>bestScore){best=k;bestScore=ratio;}
        }
        if(best){if(Math.abs(best-this.candidate)<=1){this.candidateAge++;}else{this.candidate=best;this.candidateAge=1;}
          this.candidateMiss=0;
          if(this.candidateAge>=Math.ceil(0.20*this.rate/this.H)) {
            const f=best*this.rate/this.N;
            if(Math.abs(f-this.auto[0])>this.rate/this.N*1.2){this.auto[1]=this.auto[0];this.auto[0]=f;this.updateNotches();}
          }
        }else if(++this.candidateMiss>Math.ceil(0.7*this.rate/this.H)){
          this.candidateAge=0;this.candidate=0;this.candidateMiss=0;
          if(this.auto[0]||this.auto[1]){this.auto[0]=this.auto[1]=0;this.updateNotches();}
        }
      }
      processFrame(start){
        const p=this.settings,n=this.N;
        for(let j=0;j<n;j++){this.real[j]=this.input[(start+j)&this.mask]*this.window[j];this.imag[j]=0;}
        this.fft(false);
        for(let k=0;k<=n/2;k++){this.mag[k]=Math.hypot(this.real[k],this.imag[k]);}
        if(p.notch && (this.frameCount++%4===0))this.analyzeNotch();
        if(p.nr){
          const alpha=Math.max(0.8,Math.min(0.9997,p.nr_alpha));
          const strength=Math.pow(10,Math.max(-10,Math.min(35,p.nr_snr))/20);
          const speech=!!p.nr_speech_mode;
          for(let k=0;k<=n/2;k++){
            const mag=this.mag[k];
            if(!this.noiseReady)this.noise[k]=Math.max(mag,1e-7);
            else {
              const estimate=this.noise[k];
              const adap=mag<estimate?0.93:alpha;
              const rise= speech?0.001:0.004;
              this.noise[k]=Math.max(1e-7,adap*estimate+(1-adap)*Math.min(mag,estimate*(1+rise)));
            }
            const snr=mag/(this.noise[k]+1e-8);
            // Mild musical-noise suppression: frequency- and time-smoothed gain.
            let g=snr>=strength?1:Math.max(0.12,(snr/strength)*(snr/strength));
            if(p.nr_comb>0 && k>0 && k<n/2 && mag>this.mag[k-1]*1.25 && mag>this.mag[k+1]*1.25)
              g=Math.min(1,g+p.nr_comb*0.3);
            const prev=this.gains[k]||1;
            g= g>prev?0.55*g+0.45*prev:0.14*g+0.86*prev;
            this.gains[k]=g;
          }
          this.noiseReady=true;
          const amp=Math.pow(10,Math.max(-12,Math.min(12,p.nr_gain))/20);
          for(let k=0;k<=n/2;k++){
            let g=this.gains[k];
            if(k>0&&k<n/2)g=0.2*this.gains[k-1]+0.6*g+0.2*this.gains[k+1];
            g*=amp;
            this.real[k]*=g;this.imag[k]*=g;
            if(k>0&&k<n/2){this.real[n-k]*=g;this.imag[n-k]*=g;}
          }
        }
        this.fft(true);
        for(let i=0;i<n;i++){
          const pos=(start+i)&this.mask,w=this.window[i];
          this.ola[pos]+=this.real[i]*w;
          this.weight[pos]+=w*w;
        }
      }
      process(x){
        const p=this.settings;
        x=Number.isFinite(x)?Math.max(-4,Math.min(4,x)):0;
        this.rms=0.997*this.rms+0.003*x*x;
        if(p.nb){
          const amp=Math.abs(x);this.avg=0.999*this.avg+0.001*Math.min(amp,Math.max(0.006,this.avg*4));
          if(this.blank>0){x*=0.12;this.blank--;}
          else if(this.index>1000&&amp>Math.max(0.025,this.avg*8))this.blank=Math.max(2,Math.floor(this.rate*0.00035));
        }
        const idx=this.index++;
        this.input[idx&this.mask]=x;
        if(idx+1>=this.N&&(idx+1-this.N)%this.H===0)this.processFrame(idx+1-this.N);
        const outIdx=idx-(this.N-1);
        let y=0;
        if(outIdx>=0){const i=outIdx&this.mask;const wt=this.weight[i];y=wt>1e-7?this.ola[i]/wt:0;this.ola[i]=0;this.weight[i]=0;}
        if(p.notch&&p.mode!=='cw'){y=this.notches[0].process(y);y=this.notches[1].process(y);}
        if(p.eq){y=this.hp.process(y);y=this.bass.process(y);y=this.peak.process(y);y=this.air.process(y);y=this.lp.process(y);}
        if(p.comp){
          const side=this.compLp.process(this.compHp.process(y));
          const v=Math.abs(side),coeff=v>this.compEnvelope?Math.exp(-1/(0.008*this.rate)):Math.exp(-1/(0.13*this.rate));
          this.compEnvelope=coeff*this.compEnvelope+(1-coeff)*v;
          const gate=Math.max(0.0001,p.gateThresh);
          let desired=Math.min(Math.max(1,p.maxBoost),Math.max(0.05,p.agcTarget)/(this.compEnvelope+1e-7));
          if(this.compEnvelope<gate){const r=this.compEnvelope/gate;desired*=r*r;}
          if(desired<this.compGain)this.compHang=Math.floor(Math.max(0,p.hangTime||0)*this.rate);
          else if(this.compHang>0){this.compHang--;desired=this.compGain;}
          const k=desired<this.compGain?0.002:1/(Math.max(0.08,p.recoveryTime)*this.rate);
          this.compGain+=(desired-this.compGain)*k;
          y=Math.tanh(y*this.compGain)*(p.compGain||1);
        }
        const out=y*Math.max(0,Math.min(3,p.gain));
        return Math.max(-1,Math.min(1,Number.isFinite(out)?out:0));
      }
    }
    DSPCore.defaults=defaults;
    return DSPCore;
  }

  const DSPCore=createDSPCore();
  const presets={
    ssb:{highpassFreq:150,lowpassFreq:2800,peakingFreq:1500,peakingQ:0.85,peakingGain:1.5,gateThresh:0.008,nr_alpha:0.975,nr_snr:8,maxNotches:2,compGain:1},
    am:{highpassFreq:55,lowpassFreq:8000,peakingFreq:950,peakingQ:0.8,peakingGain:0,gateThresh:0.005,nr_alpha:0.982,nr_snr:5,maxNotches:2,compGain:1},
    cw:{highpassFreq:350,lowpassFreq:950,peakingFreq:650,peakingQ:2,peakingGain:0,gateThresh:0.005,nr_alpha:0.98,nr_snr:4,maxNotches:0,compGain:1},
    nfm:{highpassFreq:120,lowpassFreq:4400,nr_snr:4,maxNotches:2},
    wfm:{highpassFreq:35,lowpassFreq:15000,nr_snr:3,maxNotches:0},
    digital:{highpassFreq:60,lowpassFreq:8000,nr_snr:2,maxNotches:0}
  };
  const persistentKeys={eq:'enabled',nr:'nr',notch:'autonotch',nb:'declick',comp:'compressor',loudness:'loudness'};
  const enabled={eq:false,nb:false,nr:false,notch:false,comp:false,loudness:false};
  let settingsStore={};
  let mode='ssb', settings={}, initialized=false, destroyed=false, userDisabled=false;
  let windowNode=null, panel=null, statusEl=null, ledEl=null, canvas=null, canvasCtx=null;
  const routes=new Set(), errors=[], observedSources=new Set();
  let interceptCount=0, animationId=0, pollingId=0, watchdogId=0, workletUrl=null;
  const workletLoads=new WeakMap();
  const listeners=[];
  const originals={connect:AudioNode.prototype.connect};
  const originalFactories=[];
  function errorLog(e,context){const msg=context+': '+String(e&&e.message||e);errors.push({at:new Date().toISOString(),message:msg});if(errors.length>16)errors.shift();console.warn('[audio_filter]',msg);}
  function listen(target,event,fn,opts){target.addEventListener(event,fn,opts);listeners.push(()=>target.removeEventListener(event,fn,opts));}
  function safeStorageGet(k){try{return localStorage.getItem(k);}catch(_){return null;}}
  function safeStorageSet(k,v){try{localStorage.setItem(k,v);}catch(e){errorLog(e,'localStorage');}}
  function normalizeMode(m){m=String(m||'ssb').toLowerCase();if(m==='lsb'||m==='usb')return 'ssb';if(m==='fm')return 'nfm';if(['dmr','ysf','dstar','nxdn','m17','p25','freedv'].includes(m))return 'digital';return presets[m]?m:'ssb';}
  function cleanProfile(obj){return Object.fromEntries(Object.entries(obj||{}).filter(([,value])=>value!==null&&value!==undefined));}
  // Store only user overrides, not copied defaults: future versions can revise
  // presets without silently freezing old values into localStorage.
  function resolveModeSettings(currentMode=mode, overrides=settings){
    return Object.assign({},DSPCore.defaults,presets[currentMode],cleanProfile(overrides));
  }
  function readReceiverMode(){try{
    if(window.UI && typeof UI.getDemodulator==='function'){const d=UI.getDemodulator();if(d&&typeof d.get_modulation==='function')return normalizeMode(d.get_modulation());}
    if(typeof window.get_demodulator==='function')return normalizeMode(window.get_demodulator());
    if(typeof window.demodulator==='string')return normalizeMode(window.demodulator);
    const active=document.querySelector('.modulation.selected,.modulation.active,.mode-button.active,#openwebrx-panel .active[data-mode]');
    if(active)return normalizeMode(active.getAttribute('data-mode')||active.textContent.trim());
  }catch(_){} return mode;}
  function loadSettings(){
    for(const [k,v] of Object.entries(persistentKeys))enabled[k]=safeStorageGet(STORAGE+v)==='true';
    try{const obj=JSON.parse(safeStorageGet(STORAGE+'settings')||'{}');
      if(obj&&typeof obj==='object'){
        if(Object.keys(obj).some(k=>presets[k]))settingsStore=obj;
        else if(Object.keys(obj).length)settingsStore.ssb=obj;
      }
    }catch(e){errorLog(e,'restore profiles');}
    mode=readReceiverMode();settings=cleanProfile(settingsStore[mode]);
  }
  function saveSettings(){settingsStore[mode]=Object.assign({},settings);safeStorageSet(STORAGE+'settings',JSON.stringify(settingsStore));}
  function updateParameter(key,value){settings[key]=value;saveSettings();syncSettings();}
  function syncSettings(){
    const p=Object.assign({},resolveModeSettings(),{mode,eq:enabled.eq,nb:enabled.nb,nr:enabled.nr,notch:enabled.notch,comp:enabled.comp,loudness:enabled.loudness});
    for(const r of routes){
      if(r.engine){r.engine.setSettings(p);}
      if(r.processor&&r.processor.port)try{r.processor.port.postMessage({type:'settings',value:p});}catch(e){errorLog(e,'send settings');}
    }
    updateToggles();
  }
  function setFlag(flag,on){enabled[flag]=!!on;safeStorageSet(STORAGE+persistentKeys[flag],String(!!on));syncSettings();}

  function makeWorkletSource(){
    return `"use strict";\nconst DSPCore=(${createDSPCore.toString()})();\n`+
      `class AudioFilterStudioProcessor extends AudioWorkletProcessor{\n`+
      `constructor(o){super();this.engine=new DSPCore(sampleRate);this.samples=0;this.nonzero=0;this.port.onmessage=e=>{try{if(e.data.type==='settings')this.engine.setSettings(e.data.value);else if(e.data.type==='reset')this.engine.reset();}catch(err){this.port.postMessage({type:'error',message:String(err)});}};}\n`+
      `process(inputs,outputs){const input=inputs[0],output=outputs[0];if(!output||!output[0])return true;try{const n=output[0].length;for(let i=0;i<n;i++){let x=0;if(input&&input.length){for(let c=0;c<input.length;c++)x+=input[c][i]||0;x/=input.length;}if(Math.abs(x)>1e-5)this.nonzero++;const y=this.engine.process(x);for(let c=0;c<output.length;c++)output[c][i]=y;}this.samples+=n;if(this.samples>=sampleRate/3){this.port.postMessage({type:'heartbeat',samples:this.samples,nonzero:this.nonzero,rate:sampleRate,latency:this.engine.N-1});this.samples=0;this.nonzero=0;} }catch(e){for(let c=0;c<output.length;c++)output[c].fill(0);this.port.postMessage({type:'error',message:String(e)});}return true;}\n`+
      `}\nregisterProcessor('af-studio-2',AudioFilterStudioProcessor);`;
  }
  async function createWorklet(context){
    if(!window.isSecureContext||!context.audioWorklet||typeof AudioWorkletNode==='undefined')throw Error('AudioWorklet unsupported or insecure context');
    if(!workletUrl)workletUrl=URL.createObjectURL(new Blob([makeWorkletSource()],{type:'text/javascript'}));
    if(!workletLoads.has(context))workletLoads.set(context,context.audioWorklet.addModule(workletUrl));
    await workletLoads.get(context);
    return new AudioWorkletNode(context,'af-studio-2',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
  }

  function originalConnect(source,dest,args=[]){return originals.connect.call(source,dest,...args);}
  function bypass(r,reason){
    if(r.destroyed)return;
    r.working=false;r.mode=reason||'BYPASS';
    try{r.dry.gain.setTargetAtTime(1,r.context.currentTime,0.006);r.wet.gain.setTargetAtTime(0,r.context.currentTime,0.006);}catch(e){r.dry.gain.value=1;r.wet.gain.value=0;}
    renderStatus();
  }
  function chooseWet(r){
    if(r.destroyed||r.working||userDisabled)return;
    if(r.heartbeat<=0||!r.processor)return;
    try{const t=r.context.currentTime;r.wet.gain.setTargetAtTime(1,t,0.006);r.dry.gain.setTargetAtTime(0,t,0.006);r.working=true;r.mode=r.worklet?'DSP ACTIVE':'FALLBACK';renderStatus();}
    catch(e){errorLog(e,'activate wet path');bypass(r,'BYPASS');}
  }
  function handleHeartbeat(r,data){if(r.destroyed)return;r.lastHeartbeat=Date.now();r.heartbeat++;r.samples+=data.samples||0;r.nonzero+=data.nonzero||0;
    // A silent stream still exercises DSP; incoming signal above -100 dBFS
    // is tracked independently, so DSP ACTIVE means hooked + exercised.
    chooseWet(r);}
  async function beginProcessor(r){
    if(r.destroyed)return;
    try{
      let worklet=false,node;
      try{node=await createWorklet(r.context);worklet=true;}
      catch(e){errorLog(e,'AudioWorklet unavailable; fallback');
        if(!r.context.createScriptProcessor)throw Error('No supported processor path');
        node=r.context.createScriptProcessor(1024,1,1);
        const engine=new DSPCore(r.context.sampleRate);r.engine=engine;
        node.onaudioprocess=e=>{
          try{
            const inp=e.inputBuffer.getChannelData(0),out=e.outputBuffer.getChannelData(0);
            for(let i=0;i<out.length;i++){out[i]=engine.process(inp[i]);if(Math.abs(inp[i])>1e-5)r.fallbackNonzero=(r.fallbackNonzero||0)+1;}
            r.fallbackFrames=(r.fallbackFrames||0)+out.length;
            if(r.fallbackFrames>=r.context.sampleRate/3){const count=r.fallbackFrames,nz=r.fallbackNonzero||0;r.fallbackFrames=0;r.fallbackNonzero=0;handleHeartbeat(r,{samples:count,nonzero:nz});}
          }catch(ex){errorLog(ex,'fallback process');bypass(r,'ERROR');e.outputBuffer.getChannelData(0).fill(0);}
        };
      }
      if(r.destroyed){try{node.disconnect();}catch(_){}return;}
      r.processor=node;r.worklet=worklet;
      // Connect all wet nodes while gain is still zero. Original dry audio is
      // always present until DSP confirms it is actually receiving samples.
      originalConnect(r.source,r.input,typeof r.args[0]==='number'?[r.args[0]]:[]);
      originalConnect(r.input,node);
      originalConnect(node,r.output);
      originalConnect(r.output,r.wet);
      if(worklet){
        node.port.onmessage=e=>{
          if(e.data.type==='heartbeat')handleHeartbeat(r,e.data);
          else if(e.data.type==='error'){errorLog(e.data.message,'worklet');bypass(r,'ERROR');}
        };
        const onerror=()=>{errorLog('AudioWorklet processorerror','worklet');bypass(r,'ERROR');};
        node.addEventListener('processorerror',onerror);r.unlisten=()=>node.removeEventListener('processorerror',onerror);
      }
      syncSettings();r.mode=worklet?'CONNECTING':'FALLBACK INIT';renderStatus();
    }catch(e){errorLog(e,'create processor');bypass(r,'BYPASS');}
  }
  function buildRoute(source,destination,args,kind='intercept'){
    if(destroyed||!source||!destination||source.__afStudioInternal)return null;
    const context=source.context;
    if(!context||context.destination!==destination||typeof context.createGain!=='function')return null;
    let dry,wet,input,output;
    try{
      dry=context.createGain();wet=context.createGain();input=context.createAnalyser();output=context.createAnalyser();
      dry.__afStudioInternal=wet.__afStudioInternal=input.__afStudioInternal=output.__afStudioInternal=true;
      dry.gain.value=1;wet.gain.value=0;
      input.fftSize=2048;output.fftSize=2048;
      originalConnect(dry,destination);originalConnect(wet,destination);
      originalConnect(source,dry,args);
    }catch(e){errorLog(e,'fail-open dry route');try{dry&&dry.disconnect();wet&&wet.disconnect();}catch(_){}return null;}
    const r={source,destination,args,context,dry,wet,input,output,kind,mode:'CONNECTING',working:false,heartbeat:0,
      samples:0,nonzero:0,lastHeartbeat:0,worklet:false,engine:null,processor:null,destroyed:false};
    routes.add(r);interceptCount++;beginProcessor(r);renderStatus();return r;
  }
  function intercept(source,destination,args){
    const existing=[...routes].find(r=>r.source===source&&r.destination===destination&&!r.destroyed);
    if(existing){ // Allow repeated receiver connect() calls without bypassing already-installed processing.
      return destination;
    }
    const r=buildRoute(source,destination,args,'intercept');
    if(r)return destination;
    return originalConnect(source,destination,args);
  }
  function installHook(){
    const ours=function(destination,...args){
      if(!destroyed&&destination&&this.context&&destination===this.context.destination&&!this.__afStudioInternal){
        return intercept(this,destination,args);
      }
      return originalConnect(this,destination,args);
    };
    AudioNode.prototype.connect=ours;originals.ours=ours;
    // Opportunistic source discovery for integrations; recording nodes does
    // not disconnect them or imply that existing links can be inspected.
    for(const method of ['createMediaStreamSource','createMediaElementSource','createScriptProcessor']){
      const proto=window.BaseAudioContext&&BaseAudioContext.prototype[method]?BaseAudioContext.prototype:AudioContext.prototype;
      const orig=proto&&proto[method];if(typeof orig!=='function')continue;
      proto[method]=function(...args){const node=orig.apply(this,args);observedSources.add(node);return node;};
      originalFactories.push({proto,method,orig,wrapped:proto[method]});
    }
  }
  function restoreHook(){if(AudioNode.prototype.connect===originals.ours)AudioNode.prototype.connect=originals.connect;
    for(const x of originalFactories){if(x.proto[x.method]===x.wrapped)x.proto[x.method]=x.orig;}
    originalFactories.length=0;
  }
  function detachRoute(r){if(r.destroyed)return;r.destroyed=true;
    // Restore unprocessed direct connection FIRST so teardown cannot mute sound.
    try{originalConnect(r.source,r.destination,r.args);}catch(e){errorLog(e,'restore direct audio');}
    for(const node of [r.input,r.processor,r.output,r.dry,r.wet]){
      if(!node)continue;try{node.disconnect();}catch(_){}
    }
    try{if(r.processor&&r.processor.port){r.processor.port.onmessage=null;r.processor.port.close();}}catch(_){}
    try{if(r.processor&&'onaudioprocess' in r.processor)r.processor.onaudioprocess=null;}catch(_){}
    try{r.unlisten&&r.unlisten();}catch(_){}
    routes.delete(r);
  }
  function attach(source,options={}){
    if(!source||!source.context||typeof source.connect!=='function')throw TypeError('attach(source): expected AudioNode');
    const dest=options.destination||source.context.destination;
    if(dest!==source.context.destination)throw Error('attach supports receiver destination only');
    // With an established direct connection, an integrator may explicitly
    // opt into disconnect(destination). NEVER do that on automatic discovery.
    const route=buildRoute(source,dest,[], 'explicit');
    if(!route)throw Error('Unable to attach; original audio left unchanged');
    if(options.replaceDirect){
      try{source.disconnect(dest);}catch(e){errorLog(e,'explicit disconnect(destination)');}
    }
    return {detach:()=>detachRoute(route),status:()=>routeStatus(route)};
  }
  function routeStatus(r){return {kind:r.kind,live:r.working,mode:r.mode,contextState:r.context.state,
    sampleRate:r.context.sampleRate,worklet:r.worklet,processor:r.processor?(r.worklet?'AudioWorklet':'ScriptProcessor'):'none',
    interceptedConnections:interceptCount,heartbeats:r.heartbeat,processedSamples:r.samples,nonzeroInputSamples:r.nonzero,
    lastHeartbeatMs:r.lastHeartbeat?Date.now()-r.lastHeartbeat:null,latencyMs:1000*((r.context.sampleRate>=32000?512:256)-1)/r.context.sampleRate};}
  function status(){const all=[...routes].map(routeStatus);const active=all.some(r=>r.live&&r.lastHeartbeatMs!==null&&r.lastHeartbeatMs<2200);
    return {build:BUILD,initialized,disabled:userDisabled,dspLive:active,routeCount:routes.size,
      interceptedConnections:interceptCount,mode,engine:all.some(r=>r.processor==='AudioWorklet')?'AudioWorklet':all.some(r=>r.processor==='ScriptProcessor')?'ScriptProcessor':'none',
      sampleRate:all[0]?.sampleRate||null,contextState:all[0]?.contextState||'none',routes:all,errors:errors.slice()};}
  function renderStatus(){if(!statusEl)return;const s=status(),a=s.routes.find(r=>r.live),r=s.routes[0];
    let label='NOT ROUTED',color='#efad58';
    if(s.disabled){label='BYPASS';color='#a0aaba';}
    else if(a){label=a.worklet?'DSP ACTIVE':'FALLBACK';color=a.worklet?'#48daaa':'#e1b85c';}
    else if(r){label=r.mode==='ERROR'?'DSP ERROR · BYPASS':r.mode==='BYPASS'?'BYPASS':'CONNECTING';color='#e1b85c';}
    statusEl.textContent=label;if(ledEl)ledEl.style.background=color;
    const sub=document.getElementById('af-studio-meta');if(sub)sub.textContent=r?`${Math.round(r.sampleRate)} Hz · ${r.processor}`:'Awaiting receiver audio route';
  }
  function poll(){
    if(destroyed)return;
    const next=readReceiverMode();if(next!==mode){saveSettings();mode=next;settings=cleanProfile(settingsStore[mode]);syncSettings();refreshSliders();}
    for(const r of routes){if(r.working&&Date.now()-r.lastHeartbeat>2500)bypass(r,'WATCHDOG');}
    renderStatus();
  }
  const sliders=[
    ['nr_snr','NR threshold',0,30,1,' dB'],['nr_alpha','NR smoothing',0.9,0.999,0.001,''],
    ['maxBoost','Comp boost',1,25,1,'×'],['gain','Output',0,2,0.05,'×'],
    ['highpassFreq','High-pass',20,800,10,' Hz'],['lowpassFreq','Low-pass',400,16000,100,' Hz'],
    ['peakingFreq','EQ presence',200,6000,50,' Hz'],['peakingGain','EQ gain',-18,18,0.5,' dB'],
    ['peakingQ','EQ Q',0.3,8,0.1,''],['loudnessGain','Bass shelf',-12,12,0.5,' dB'],
    ['airFreq','Treble shelf freq',900,16000,100,' Hz'],['airGain','Treble shelf gain',-12,12,0.5,' dB'],
    ['gateThresh','Noise gate',0.001,0.05,0.001,''],['compHPF','Comp sidechain HPF',30,1200,10,' Hz'],['compLPF','Comp sidechain LPF',500,8000,100,' Hz'],['hangTime','Comp hang',0,1,0.05,' s'],['agcTarget','AGC target',0.1,0.8,0.01,''],
    ['recoveryTime','AGC recovery',0.08,2,0.02,' s'],['compGain','Comp output',0.1,2,0.05,'×'],
    ['notchQ','Notch Q',10,80,1,''],['maxNotches','Max notches',0,2,1,''],
    ['nr_gain','NR output gain',-12,12,1,' dB'],['nr_comb','NR tonal guard',0,1,0.05,'']
  ];
  const css=`
    .af2{font:12px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#dfe6ee;background:linear-gradient(160deg,#1b242e,#111923);padding:12px;border-radius:9px;max-width:660px;min-width:330px;box-sizing:border-box;}
    .af2 *{box-sizing:border-box}.af2-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
    .af2-brand{letter-spacing:.08em;font-size:11px;font-weight:800;color:#c3d2e1}.af2-status{display:flex;align-items:center;gap:7px;font-size:10px;letter-spacing:.075em;color:#adbece;font-weight:700}
    .af2-led{width:9px;height:9px;border-radius:50%;background:#e1b85c;box-shadow:0 0 7px #455}
    .af2-buttons{display:grid;grid-template-columns:repeat(5,1fr) auto;gap:6px}.af2 button{background:#202d3a;color:#bdccdc;border:1px solid #3b4a5b;border-radius:6px;padding:8px 6px;cursor:pointer;font:inherit;font-weight:650}
    .af2 button.on{background:linear-gradient(#176d73,#12505b);color:#dffffb;border-color:#45b8bd;box-shadow:inset 0 1px 0 #438589}.af2 button:focus-visible{outline:2px solid #54bdf1}
    .af2 canvas{display:block;width:100%;height:185px;border-radius:6px;background:#090e15;border:1px solid #2d3948;margin-top:11px}
    .af2-line{display:flex;justify-content:space-between;color:#819aaf;font-size:10px;margin-top:5px}
    .af2-controls{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:12px 0 4px}
    .af2-control{background:#151e28;border:1px solid #304050;border-radius:7px;padding:9px 7px}
    .af2-control label{display:flex;flex-direction:column;gap:5px;font-size:10px;color:#a9bcce}
    .af2-control output{color:#7ee2f4;font-size:11px;font-weight:700}.af2-knob{position:relative;width:62px;height:62px;border-radius:50%;border:4px solid #3a5365;background:radial-gradient(circle at 35% 25%,#425565,#182631 70%);box-shadow:inset 0 2px 5px #000b,0 2px 5px #0007;margin:9px auto;cursor:ns-resize;touch-action:none}.af2-knob:focus-visible{outline:2px solid #5ed9f2}.af2-needle{position:absolute;left:calc(50% - 2px);top:8px;width:4px;height:17px;background:#67daf1;border-radius:3px;transform-origin:2px 19px;transform:rotate(var(--angle,-120deg));box-shadow:0 0 4px #6cd8ef}.af2-control input[type=range]{display:none}.af2 input[type=range]{width:100%;margin:0;accent-color:#4a9cc5;cursor:pointer}
    .af2-advanced{display:none;margin-top:12px;padding:9px;border:1px solid #304050;border-radius:6px;background:#111920;max-height:340px;overflow:auto}
    .af2-advanced.open{display:block}.af2-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .af2-adv label{display:block;color:#9db0c3;font-size:11px}.af2-adv input{width:100%}
    .af2-bottom{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:11px;color:#8095a7;font-size:11px}
    .af2-bottom button{padding:4px 8px;font-size:10px}.af2 .af2-fail{color:#e6bc62}
    @media(max-width:470px){.af2-controls{grid-template-columns:repeat(2,1fr)}.af2{min-width:280px}.af2-buttons{grid-template-columns:repeat(3,1fr)}}
  `;
  function formatValue(v,unit){return (v<1?Number(v).toFixed(3):v<10?Number(v).toFixed(2):Math.round(v))+unit;}
  function setKnobRotation(key, value, min, max){
    const knob=document.getElementById('af2-knob-'+key);if(!knob)return;
    const a=-125+(Math.max(0,Math.min(1,(value-min)/(max-min)))*250);
    knob.style.setProperty('--angle',a+'deg');knob.setAttribute('aria-valuenow',String(value));
  }
  function makeSlider([key,label,min,max,step,unit],advanced=false){
    const root=document.createElement('div');root.className=advanced?'af2-adv':'af2-control';
    const lbl=document.createElement('label');lbl.textContent=label;lbl.setAttribute('for','af2-'+key);
    const out=document.createElement('output');out.id='af2-'+key+'-value';
    const inp=document.createElement('input');inp.id='af2-'+key;inp.type='range';inp.min=min;inp.max=max;inp.step=step;
    const v=resolveModeSettings()[key]??min;inp.value=Number(v);
    out.textContent=formatValue(Number(inp.value),unit);
    listen(inp,'input',()=>{out.textContent=formatValue(Number(inp.value),unit);setKnobRotation(key,Number(inp.value),min,max);updateParameter(key,Number(inp.value));});
    if(advanced){root.append(lbl,inp,out);return root;}
    const knob=document.createElement('div');knob.className='af2-knob';knob.id='af2-knob-'+key;
    knob.setAttribute('role','slider');knob.setAttribute('tabindex','0');knob.setAttribute('aria-label',label);
    knob.setAttribute('aria-valuemin',String(min));knob.setAttribute('aria-valuemax',String(max));
    const needle=document.createElement('span');needle.className='af2-needle';knob.appendChild(needle);
    let startY=0,startValue=0,dragging=false;
    const commit=value=>{inp.value=String(Math.max(min,Math.min(max,Math.round(value/step)*step)));inp.dispatchEvent(new Event('input',{bubbles:true}));};
    listen(knob,'pointerdown',e=>{if(e.button!==0)return;dragging=true;startY=e.clientY;startValue=Number(inp.value);knob.setPointerCapture(e.pointerId);});
    listen(knob,'pointermove',e=>{if(dragging)commit(startValue+(startY-e.clientY)*step*0.5);});
    listen(knob,'pointerup',e=>{dragging=false;try{knob.releasePointerCapture(e.pointerId);}catch(_){}});
    listen(knob,'pointercancel',()=>{dragging=false;});
    listen(knob,'keydown',e=>{if(['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Home','End'].includes(e.key)){
      e.preventDefault();const d=e.key==='ArrowDown'||e.key==='ArrowLeft'?-step:step;
      commit(e.key==='Home'?min:e.key==='End'?max:Number(inp.value)+d);
    }});
    listen(knob,'wheel',e=>{e.preventDefault();commit(Number(inp.value)+(e.deltaY<0?step:-step));},{passive:false});
    root.append(lbl,knob,inp,out);
    knob.style.setProperty('--angle',(-125+(Number(inp.value)-min)/(max-min)*250)+'deg');
    knob.setAttribute('aria-valuenow',String(inp.value));return root;
  }
  function refreshSliders(){const resolved=resolveModeSettings();for(const [key,,min,max,,unit] of sliders){
    const el=document.getElementById('af2-'+key);if(!el)continue;
    el.value=Number(resolved[key]??min);
    const out=document.getElementById('af2-'+key+'-value');if(out)out.textContent=formatValue(Number(el.value),unit||'');
    setKnobRotation(key,Number(el.value),min,max);
  }
    const speech=panel&&panel.querySelector('#af2-speech-preservation');
    if(speech)speech.checked=resolved.nr_speech_mode!==false;
  }

  function updateToggles(){if(!panel)return;for(const flag of Object.keys(enabled)){
    const el=panel.querySelector(`[data-af-flag="${flag}"]`);if(el){el.classList.toggle('on',enabled[flag]);el.setAttribute('aria-pressed',String(enabled[flag]));}
  }}
  function renderSpectrum(){
    if(!canvas||destroyed||!panel||panel.offsetWidth===0)return;
    const width=Math.max(200,Math.floor(canvas.clientWidth*devicePixelRatio)),height=Math.max(100,Math.floor(185*devicePixelRatio));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const ctx=canvasCtx;ctx.clearRect(0,0,width,height);ctx.fillStyle='#090e15';ctx.fillRect(0,0,width,height);
    ctx.lineWidth=1;ctx.strokeStyle='#1c2a36';
    for(let i=1;i<8;i++){ctx.beginPath();ctx.moveTo(width*i/8,0);ctx.lineTo(width*i/8,height);ctx.stroke();}
    for(let i=1;i<5;i++){ctx.beginPath();ctx.moveTo(0,height*i/5);ctx.lineTo(width,height*i/5);ctx.stroke();}
    const live=[...routes].find(r=>r.working&&r.input&&r.output);
    if(!live){ctx.fillStyle='#91a2b4';ctx.textAlign='center';ctx.font=`${Math.round(12*devicePixelRatio)}px system-ui`;ctx.fillText('Awaiting routed receiver audio',width/2,height/2);return;}
    const traces=[[live.input,'#8595a5'],[live.output,'#48bfe8']];
    for(const [analyser,color] of traces){
      const arr=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(arr);
      ctx.strokeStyle=color;ctx.lineWidth=Math.max(1,1.3*devicePixelRatio);ctx.beginPath();
      const minFreq=70,maxFreq=Math.min(10000,live.context.sampleRate/2);
      for(let px=0;px<width;px+=Math.max(1,Math.floor(devicePixelRatio))){
        const freq=minFreq*Math.pow(maxFreq/minFreq,px/width);
        const k=Math.max(0,Math.min(arr.length-1,Math.floor(freq*analyser.fftSize/live.context.sampleRate)));
        const db=Number.isFinite(arr[k])?arr[k]:-100;
        const y=Math.max(0,Math.min(height,height*(1-(db+100)/100)));
        if(px===0)ctx.moveTo(px,y);else ctx.lineTo(px,y);
      }ctx.stroke();
    }
  }
  let lastDraw=0;
  function renderLoop(t){if(destroyed)return;if(t-lastDraw>=40){lastDraw=t;renderSpectrum();}animationId=requestAnimationFrame(renderLoop);}
  function openPanel(){if(!panel)return;const node=windowNode;
    if(node){ // Native window toggling differs between OWRX+ releases.
      if(typeof window.$==='function'){
        try{window.$(node).toggle();}catch(_){node.style.display=node.style.display==='none'?'block':'none';}
      }else node.style.display=node.style.display==='none'?'block':'none';
    }else panel.parentElement.style.display=panel.parentElement.style.display==='none'?'block':'none';
    renderStatus();
  }
  function createUI(){
    if(panel)return true;
    const style=document.createElement('style');style.id='af-studio-2-css';style.textContent=css;document.head.appendChild(style);
    const markup=`<div class="af2" id="af-studio-2"><div class="af2-top"><span class="af2-brand">◈ AUDIO FILTER STUDIO</span><div class="af2-status"><i class="af2-led" id="af2-led"></i><span id="af2-status">NOT ROUTED</span></div></div>
      <div class="af2-buttons">${[['nb','NB'],['notch','Notch'],['nr','NR'],['eq','EQ'],['comp','Comp']].map(([k,t])=>`<button type="button" data-af-flag="${k}">${t}</button>`).join('')}<button type="button" id="af2-settings" aria-expanded="false" title="Advanced DSP settings">⋯</button></div>
      <canvas id="af2-spectrum" aria-label="Input and output audio spectrum"></canvas>
      <div class="af2-line"><span>● Input &nbsp; <span style="color:#48bfe8">● Output</span></span><span id="af-studio-meta">Awaiting receiver audio route</span></div>
      <div class="af2-controls" id="af2-quick"></div><section class="af2-advanced" id="af2-advanced"><div class="af2-grid" id="af2-advanced-grid"></div></section>
      <div class="af2-bottom"><span>Studio 2.0 · Browser DSP</span><span><button type="button" id="af2-export">Export</button> <button type="button" id="af2-import">Import</button> <button type="button" id="af2-bypass">Bypass</button> <button type="button" id="af2-reset">Reset mode</button></span></div></div>`;
    if(typeof window.Plugins!=='undefined'&&typeof Plugins.addWindow==='function'){
      try{windowNode=Plugins.addWindow(ID,'Audio Filter Studio',markup);}catch(e){errorLog(e,'Plugins.addWindow');}
    }
    panel=document.getElementById('af-studio-2');
    if(!panel&&windowNode){const body=windowNode.querySelector('.openwebrx-plugin-body');if(body){body.innerHTML=markup;panel=body.querySelector('#af-studio-2');}}
    if(!panel){const shell=document.createElement('div');shell.style.cssText='position:fixed;top:15%;left:3%;z-index:10000;display:none;box-shadow:0 12px 40px #0009;max-width:94vw';shell.innerHTML=markup;document.body.appendChild(shell);panel=shell.querySelector('#af-studio-2');}
    statusEl=panel.querySelector('#af2-status');ledEl=panel.querySelector('#af2-led');canvas=panel.querySelector('#af2-spectrum');canvasCtx=canvas.getContext('2d');
    const quick=panel.querySelector('#af2-quick'),adv=panel.querySelector('#af2-advanced-grid');
    for(let i=0;i<sliders.length;i++){(i<4?quick:adv).appendChild(makeSlider(sliders[i],i>=4));}
    for(const b of panel.querySelectorAll('[data-af-flag]'))listen(b,'click',()=>setFlag(b.dataset.afFlag,!enabled[b.dataset.afFlag]));
    listen(panel.querySelector('#af2-settings'),'click',e=>{const a=panel.querySelector('#af2-advanced');a.classList.toggle('open');e.currentTarget.setAttribute('aria-expanded',String(a.classList.contains('open')));});
    listen(panel.querySelector('#af2-bypass'),'click',e=>{userDisabled=!userDisabled;e.currentTarget.textContent=userDisabled?'Enable':'Bypass';
      for(const r of routes){if(userDisabled)bypass(r,'BYPASS');else chooseWet(r);}renderStatus();});
    listen(panel.querySelector('#af2-export'),'click',()=>{
      const blob=new Blob([JSON.stringify({version:2,profiles:settingsStore,enabled},null,2)],{type:'application/json'});
      const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='openwebrx-audio-filter-settings.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
    });
    listen(panel.querySelector('#af2-import'),'click',()=>{
      const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
      input.onchange=async()=>{try{const file=input.files&&input.files[0];if(!file)return;const obj=JSON.parse(await file.text());
        const incoming=obj.profiles||obj;if(!incoming||typeof incoming!=='object')throw Error('Invalid settings file');
        for(const [key,value] of Object.entries(incoming)){if(!presets[key]||!value||typeof value!=='object')continue;
          const profile={};for(const [param,val] of Object.entries(value)){if(typeof val==='number'&&Number.isFinite(val)||typeof val==='boolean')profile[param]=val;}
          settingsStore[key]=profile;
        }
        if(obj.enabled&&typeof obj.enabled==='object')for(const flag of Object.keys(enabled)){if(typeof obj.enabled[flag]==='boolean'){enabled[flag]=obj.enabled[flag];safeStorageSet(STORAGE+persistentKeys[flag],String(enabled[flag]));}}
        settings=cleanProfile(settingsStore[mode]);saveSettings();syncSettings();refreshSliders();
      }catch(e){errorLog(e,'import settings');renderStatus();}};input.click();
    });
    listen(panel.querySelector('#af2-reset'),'click',()=>{settingsStore[mode]={};settings={};saveSettings();syncSettings();refreshSliders();});
    // Keep original optional loudness switch, without taking space in the top row.
    const loud=document.createElement('label');loud.style.cssText='display:flex;gap:7px;margin-top:9px';
    const loudCheck=document.createElement('input');loudCheck.type='checkbox';loudCheck.checked=enabled.loudness;
    listen(loudCheck,'change',()=>setFlag('loudness',loudCheck.checked));
    loud.append(loudCheck,document.createTextNode('Enable bass loudness shelf (requires EQ)'));
    panel.querySelector('#af2-advanced').appendChild(loud);
    const speech=document.createElement('label');speech.style.marginTop='10px';speech.style.display='flex';speech.style.gap='7px';
    const check=document.createElement('input');check.id='af2-speech-preservation';check.type='checkbox';check.checked=resolveModeSettings().nr_speech_mode!==false;
    listen(check,'change',()=>updateParameter('nr_speech_mode',check.checked));speech.append(check,document.createTextNode('Speech preservation'));panel.querySelector('#af2-advanced').appendChild(speech);
    if(typeof window.Plugins!=='undefined'&&typeof Plugins.addButton==='function'){
      try{Plugins.addButton(ID,'AF',openPanel);}catch(e){errorLog(e,'Plugins.addButton');}
    }else{
      const b=document.createElement('button');b.id='af2-floating-toggle';b.textContent='AF';b.style.cssText='position:fixed;bottom:10px;left:10px;z-index:10001;background:#163d49;color:white;padding:8px';document.body.appendChild(b);listen(b,'click',openPanel);
    }
    updateToggles();renderStatus();return true;
  }
  function init(){if(initialized)return true;if(destroyed)return false;
    loadSettings();installHook();
    // Avoid reliance on receiver DOM readiness for the audio intercept. The
    // interception MUST run synchronously as soon as this file is loaded.
    function whenDOM(){if(destroyed)return;try{createUI();}catch(e){errorLog(e,'UI init');}}
    if(document.readyState==='loading')listen(document,'DOMContentLoaded',whenDOM,{once:true});else whenDOM();
    pollingId=setInterval(poll,600);
    renderLoop();initialized=true;return true;
  }
  function disable(){if(destroyed)return;destroyed=true;userDisabled=true;
    // Restore audio before removing DSP nodes, then unpatch safely.
    for(const r of [...routes])detachRoute(r);
    restoreHook();clearInterval(pollingId);clearInterval(watchdogId);cancelAnimationFrame(animationId);
    listeners.splice(0).forEach(fn=>{try{fn();}catch(_){}});
    if(workletUrl){URL.revokeObjectURL(workletUrl);workletUrl=null;}
    const btn=document.getElementById('plugin-button-'+ID);if(btn)btn.remove();
    const fallback=document.getElementById('af2-floating-toggle');if(fallback)fallback.remove();
    if(windowNode)windowNode.remove();else if(panel&&panel.parentElement)panel.parentElement.remove();
    const style=document.getElementById('af-studio-2-css');if(style)style.remove();
    initialized=false;
  }
  const api={build:BUILD,init,disable,status,attach,detachAll:()=>[...routes].forEach(detachRoute),
    setFlag,settings:()=>resolveModeSettings(),getMode:()=>mode};
  window.AudioFilterPlugin=api;
  if(window.Plugins&&Plugins.audio_filter){
    Plugins.audio_filter.no_css=true;
    Plugins.audio_filter.init=init;
    Plugins.audio_filter._version=2;
  }
  // Do NOT wait for DOM / full page load before installing the hook!
  init();
  listen(window,'pagehide',disable,{once:true});
})();