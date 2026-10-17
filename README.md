# Audio Filter Studio 2.0 for OpenWebRX+

**Status: engineering candidate for live receiver validation.** This is a complete, standalone replacement for DL1HQH/joer123's client-side `audio_filter.js`, but it has **not** been validated on the user's actual OpenWebRX+ installation. See the limitations below before deploying.

Original concept: Copyright (c) 2025 DL1HQH. New architecture and interface: 2026 contributors. **MIT license.**

## What changed

- **Fail-open audio path.** The receiver node is first connected to a unity-gain dry path. A second, initially muted path is created for DSP. The wet path is selected only after periodic processing-heartbeat messages arrive. A worklet error or stalled processor switches back to dry audio.
- **One AudioWorklet DSP processor** implements noise blanking, 50%-overlapped STFT spectral noise reduction, up to two adaptive notches, multi-band audio EQ/loudness, hang-AGC/compressor, and a noise gate. The ScriptProcessorNode fallback calls the exact same `DSPCore` class; it will be less reliable under waterfall/main-thread load.
- **True ring buffers** for overlap-add and a normalized sine analysis/synthesis window. Processing intrinsic delay: 10.65 ms at 48 kHz, 11.59 ms at 44.1 kHz, 15.97 ms at 32 kHz, 11.56 ms at 22.05 kHz. Browser buffering can add more overall latency.
- **Better observability.** `AudioFilterPlugin.status()` reports actual routes, processor type, context state, heartbeats, nonzero input samples, intercept count, and errors. The Studio UI displays `DSP ACTIVE`, `FALLBACK`, `CONNECTING`, `NOT ROUTED`, `BYPASS`, or `DSP ERROR · BYPASS`.
- **Native receiver plugin UI.** Uses `Plugins.addButton` and `Plugins.addWindow` when available, with inline CSS and no dependencies. Advanced controls, JSON settings import/export, and original per-mode localStorage settings are retained; existing `null` overrides are treated as unset.
- **Lifecycle handling.** `AudioFilterPlugin.disable()` first connects the original source to the destination, disconnects injected nodes, restores the original `connect` function where still owned, removes observers/event listeners, and cancels RAF/intervals.

## Installation

1. Back up your existing plugin on the receiver host:

   ```bash
   cd /usr/lib/python3/dist-packages/htdocs/plugins/receiver/audio_filter
   sudo cp -p audio_filter.js audio_filter.js.pre-studio2
   ```

2. Copy this `audio_filter.js` into that directory. The final filesystem path must be:

   `/usr/lib/python3/dist-packages/htdocs/plugins/receiver/audio_filter/audio_filter.js`

3. In `/usr/lib/python3/dist-packages/htdocs/plugins/receiver/init.js`, make sure it appears **once**, as early as possible, **before** `Plugins.utils.on_ready(...)` and before `Plugins.plugin_loader.setup(...)`:

   ```javascript
   (async () => {
     // Load Audio Filter Studio *before* waiting for the UI to finish loading.
     await Plugins.load('audio_filter');
     // Existing plugin startup lines follow here.
   })().catch(console.error);
   ```

   **Do not paste a second entire async block into an existing init.js.** Insert only the `await Plugins.load('audio_filter');` line into its existing startup function. Remove any old `audio_filter` remote URL registrations. Do not call `Plugins.load()` twice for the same name. Keep all other working plugin lines intact.

4. Access the receiver over HTTPS (your Cloudflare Tunnel is suitable), then hard-reload. **AudioWorklet may be blocked by restrictive Content-Security-Policy settings that prohibit `blob:` worklet modules.** In that case the page should retain audio and show fallback mode.

5. If the plugin doesn't appear, inspect Chrome DevTools → Network and Console for old/stale `init.js` or an earlier `audio_filter` registration. Loading a new copy after an old broken registration will not fix it on its own.

## Verify actual DSP processing

In the browser console, run:

```javascript
AudioFilterPlugin.status()
```

Check `dspLive: true`, a current `lastHeartbeatMs` on the route, and `nonzeroInputSamples > 0` while a station is receiving. A displayed UI alone is **not** evidence of processing. `engine` should read `AudioWorklet` on HTTPS or `ScriptProcessor` if the fallback is in use. A missing route means **the receiver connected before the intercept was installed** or it uses a different playback architecture.

**Modulation check:** Switch among AM, CW, and USB/LSB, then run `AudioFilterPlugin.getMode()` or `AudioFilterPlugin.settings().mode` in the browser console. The values should be `am`, `cw`, and `ssb` respectively. Native OpenWebRX+ exposes the active modulation via `$('#openwebrx-panel-receiver').data('panel').getDemodulator().get_modulation()`. The mode detector never creates an uninitialized receiver panel just to inspect it.

**Audible A/B test:** Tune an SSB voice signal, enable **EQ**, and reduce **Low-pass** to ~500 Hz in Advanced. The voice should become dramatically duller. Then use the panel's **Bypass** button and compare. Return the low-pass setting to 2,800 Hz when done. Make sure you are not simultaneously hearing OpenWebRX+ audio through another tab.

If a worklet reports `DSP ACTIVE` but no audible difference, inspect the route statistics and verify there is not another parallel direct audio path. `attach` does not prove or remove unknown additional paths.

## Late attachment / source integration API

Browsers intentionally provide **no public API for enumerating existing AudioNode graph connections**, and plugins cannot safely discover and rewire every already-running source. This release therefore provides a **primary explicit API** for receiver integrations that have the actual source-node object:

```javascript
// If an integration has its actual output source AudioNode:
const handle = AudioFilterPlugin.attach(receiverSourceNode, {
  // Set ONLY if you know this source has a direct connection to its
  // AudioContext.destination; this removes that specific direct connection
  // after first establishing a dry bypass path.
  replaceDirect: true
});
console.log(handle.status());
// Later: handle.detach();
```

The regular `AudioNode.prototype.connect` interception remains the **automatic fallback** for new connections. The plugin also observes future `createMediaStreamSource`, `createMediaElementSource`, and `createScriptProcessor` calls as diagnostic source candidates, but does **not** disconnect them speculatively. An OpenWebRX+ version exposing a stable source-node reference could call `attach()` explicitly (a small receiver-side integration would be necessary).

**Do not use `replaceDirect: true` against a node whose downstream audio topology is unknown**: Web Audio does not expose which outputs are currently connected, and `disconnect(destination)` can throw or be inappropriate for that topology. `attach()` without `replaceDirect` never alters existing direct routes, but may cause doubled audio if a direct path already exists.

## Defaults and behavior

- SSB: HPF 150 Hz, LPF 2800 Hz, gate 0.008, moderate NR, notch limited to two filters, mild compressor.
- AM: wider 55 Hz–8 kHz EQ preset for shortwave/hi-fi AM, less aggressive noise reduction.
- CW: 350–950 Hz EQ defaults; auto-notch is disabled to protect CW tones.
- LocalStorage compatibility: `openwebrx-audio-filter-enabled`, `-nr`, `-autonotch`, `-declick`, `-compressor`, `-loudness`, and `-settings` with per-mode `ssb`, `am`, `cw`, `nfm`, `wfm`, `digital` objects.
- Parameter changes do not enable a module automatically: turn on NB / Notch / NR / EQ / Comp in the top row. All filters run locally on **each listener's browser**, not on the SDR host.
- Studio initializes visible knobs/sliders from the **same effective settings** that are applied to the DSP (core defaults → modulation preset → saved user overrides). This corrects the earlier bug where untouched controls could misleadingly show their minimum.
- Profiles from older builds still load. `Reset mode` clears saved parameter overrides for the **current** modulation and restores its effective defaults; enable/disable buttons are global and unchanged by Reset mode. Newly saved profiles store user overrides instead of freezing every factory default.

## Known limitations and safety

1. **Not verified against the user's installed OpenWebRX+ build or real Airspy hardware.** Browser unit tests and a simulated Chromium audio-graph test passed; they cannot establish live integration with that deployment.
2. **Load order:** The OpenWebRX+ plugin loader may itself run after a receiver has already connected its audio. `init.js` ordering alone cannot repair a pre-existing connection. Use an explicit source-node integration or a receiver code change if that occurs.
3. **CSP / browser restrictions:** Inline Blob worklets require suitable Content-Security-Policy permissions. Strict CSP triggers deprecated ScriptProcessor fallback if the browser supports it. If neither engine works, playback remains dry and status shows bypass.
4. **Mono speech DSP:** Multichannel audio is downmixed to mono and written to each output channel. Hi-fi stereo FM isn't preserved by the wet path. If this matters, leave Studio bypassed on WFM.
5. **Auto-notch is conservative** and aimed at steady carriers, not arbitrary interference removal. It may still track tones poorly with a short FFT; disable it for CW/music.
6. **Latency:** the intrinsic STFT delay is under 25 ms at the documented sample rates; total end-to-end latency also includes Web Audio render quanta and codec/network buffering.
7. **Safety:** fail-open dry routing is designed to prevent silence caused by this plugin, but third-party plugin conflicts, browser faults, or other receiver routes remain possible. The plugin cannot guarantee audible continuity in every browser state.
8. **Server-side DSP is NOT included.** This is a client-side processing replacement. Hosting DSP on the OptiPlex would require changes to OpenWebRX+'s server audio pipeline.

## Test notes

- `node --check audio_filter.js`
- `node tests/validate.cjs` runs the same DSP kernel at 22.05, 32, 44.1, 48, 96 kHz and evaluates the generated AudioWorklet code with simulated audio quanta.
- `node tests/validate-defaults.cjs` checks that all 23 Studio controls across all six modes resolve to the same values as the DSP engine, including the actual knob initialization path and saved overrides.
- A Chromium smoke test (headless, deliberately insecure/opaque origin) verified UI creation, toggles, fail-open routing, status heartbeats, fallback processing and teardown. **A real secure-origin AudioWorklet test against OpenWebRX+ remains required.**

## Roll back

```bash
cd /usr/lib/python3/dist-packages/htdocs/plugins/receiver/audio_filter
sudo cp -p audio_filter.js.pre-studio2 audio_filter.js
```

Hard-reload the receiver. If audio is affected unexpectedly, remove or comment out its `await Plugins.load('audio_filter')` startup line until you restore the old plugin.