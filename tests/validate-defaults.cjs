'use strict';
// Regression tests for GUI/AudioWorklet defaults and per-mode overrides.
// No browser or third-party dependency required.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const file = fs.readFileSync(path.join(__dirname, '..', 'audio_filter.js'), 'utf8');
function segment(start, end) {
  const a=file.indexOf(start), b=file.indexOf(end, a+start.length);
  assert(a>=0 && b>a, `Missing source anchors: ${start}, ${end}`);
  return file.slice(a,b);
}
const dsp = segment('  function createDSPCore() {', '  const DSPCore=createDSPCore();');
const presets = segment('  const presets={', '  const persistentKeys=');
const resolver = segment('  function cleanProfile(', '  function readReceiverMode(');
const sliderMeta = segment('  const sliders=[', '  const css=`');
const ctx=vm.createContext({ Float32Array, Uint16Array, Math, Number, Object, Array, console });
vm.runInContext(`${dsp}\nconst DSPCore=createDSPCore();\n${presets}\nlet mode='ssb', settings={};\n${resolver}\n${sliderMeta}`,ctx);
const resolve = vm.runInContext('resolveModeSettings',ctx);
const DSPCore = vm.runInContext('DSPCore',ctx);
const modes=vm.runInContext('Object.keys(presets)',ctx);
const sliders=vm.runInContext('sliders',ctx);
const defaults=DSPCore.defaults;
assert(Object.isFrozen(defaults),'DSPCore defaults should not be mutable');
assert.equal(defaults.gain,1);
assert.equal(defaults.nr_gain,0);
assert.equal(defaults.maxBoost,8);
assert.equal(defaults.nr_comb,0.2);
assert.equal(defaults.agcTarget,0.32);
for(const mode of modes){
 const actual=resolve(mode,{});
 for(const [key,label,min,max] of sliders){
  assert(Number.isFinite(actual[key]), `${mode}: ${label} (${key}) must resolve to a real number`);
  assert(actual[key]>=min&&actual[key]<=max, `${mode}: ${key}=${actual[key]} out of [${min},${max}]`);
 }
 const engine=new DSPCore(48000);engine.setSettings(actual);
 for(const [key] of sliders)assert.equal(engine.settings[key],actual[key], `${mode}: UI/processor mismatch for ${key}`);
}
assert.equal(resolve('ssb',{}).lowpassFreq,2800,'SSB preset takes precedence over core defaults');
assert.equal(resolve('am',{}).lowpassFreq,8000,'AM preset takes precedence over core defaults');
assert.equal(resolve('cw',{}).maxNotches,0,'CW protects the tone');
assert.equal(resolve('ssb',{gain:0, nr_gain:-12}).gain,0,'explicit zero override must be preserved');
assert.equal(resolve('ssb',{gain:0, nr_gain:-12}).nr_gain,-12);
assert.equal(resolve('ssb',{gain:null}).gain,1,'legacy null must be treated as unset');
assert.equal(resolve('ssb',{nr_speech_mode:false}).nr_speech_mode,false);

// Execute the actual makeSlider function with a fake DOM, not a duplicate UI implementation.
const formatValue = segment('  function formatValue(', '  function setKnobRotation(');
const makeSlider = segment('  function makeSlider(', '  function refreshSliders(');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.style={setProperty(){}};this.attributes={};}
 append(...children){this.children.push(...children);}
 appendChild(child){this.children.push(child);return child;}
 setAttribute(key,value){this.attributes[key]=value;}
 addEventListener(){}
 dispatchEvent(){}
}
ctx.document={createElement(tag){return new Element(tag);}};
vm.runInContext(`${formatValue}\nfunction listen() {}\nfunction setKnobRotation(){}\nfunction updateParameter(){}\n${makeSlider}`,ctx);
const createControl=vm.runInContext('makeSlider',ctx);
for(const profile of modes){
  vm.runInContext(`mode=${JSON.stringify(profile)};settings={};`,ctx);
  const p=resolve(profile,{});
  for(const meta of sliders){
    const root=createControl(meta,false);
    const input=root.children.find(c=>c.tag==='input');
    assert(input,`No input element rendered for ${meta[0]}`);
    assert.equal(Number(input.value),p[meta[0]], `${profile} ${meta[0]}: visible value differs from processor`);
  }
}
console.log(`Default/UI synchronization passed for ${modes.length} modes and ${sliders.length} controls each.`);
