# Audio Filter Studio for OpenWebRX+ — 2.2 beta

**Status: 2.2.0-beta.1 development candidate.** The 2.1 audio routing, EQ, NR and mode switching have received live OpenWebRX+ validation. The speech-aware 2.2 NR changes pass automated tests but still require on-air listening tests, especially for weak speech and fading. All new code is MIT licensed.

Original concept: Copyright (c) 2025 DL1HQH. New architecture and interface: 2026 contributors. **MIT license.**

## What changed

- **Fail-open audio path.** The receiver node is first connected to a unity-gain dry path. A second, initially muted path is created for DSP. The wet path is selected only after periodic processing-heartbeat messages arrive. A worklet error or stalled processor switches back to dry audio.
- **One AudioWorklet DSP processor** implements noise blanking, 50%-overlapped STFT spectral noise reduction, up to two adaptive notches, multi-band audio EQ/loudness, hang-AGC/compressor, and a noise gate. The ScriptProcessorNode fallback calls the exact same `DSPCore` class; it will be less reliable under waterfall/main-thread load.
- **True ring buffers** for overlap-add and a normalized sine analysis/synthesis window. Processing intrinsic delay: 10.65 ms at 48 kHz, 11.59 ms at 44.1 kHz, 15.97 ms at 32 kHz, 11.56 ms at 22.05 kHz. Browser buffering can add more overall latency.
- **Better observability.** `AudioFilterPlugin.status()` reports actual routes, processor type, context state, heartbeats, nonzero input samples, intercept count, and errors. The Studio UI displays `DSP ACTIVE`, `FALLBACK`, `CONNECTING`, `NOT ROUTED`, `BYPASS`, or `DSP ERROR · BYPASS`.
- **Native receiver plugin UI.** Uses `Plugins.addButton` and `Plugins.addWindow` when available, with inline CSS and no dependencies. Advanced controls, JSON settings import/export, and original per-mode localStorage settings are retained; existing `null` overrides are treated as unset.
- **Lifecycle handling.** `AudioFilterPlugin.disable()` first connects the original source to the destination, disconnects injected nodes, restores the original `connect` function where still owned, removes observers/event listeners, and cancels RAF/intervals.

## What's new in 2.2.0-beta.1 (development branch)

**Natural-sounding spectral noise reduction, no architecture changes:** The existing FFT, STFT overlap-add, Worklet/ScriptProcessor kernel, fallback dry/wet routing, and demodulator tracking are unchanged. The NR block now computes a per-bin decision-directed prior SNR, smoothed speech-likelihood heuristic, and local ±2-bin speech protection, before applying a frequency-smoothed Wiener gain. It is a lightweight heuristic, **not** a neural voice detector or implementation of any GPL DSP library.

**Attack/release and noise tracking:** Wanted signal gain recovers with a 12 ms time constant, while noise attenuation comes back more slowly (90.5 ms at the default character setting). Speech-presence probability rises in 25 ms and decays in 160 ms. During confident speech the noise-floor minimum is protected against upward contamination, but the hold is bounded to 650 ms so abrupt broadband interference can still be relearned. Fully protected windows reuse a finite previous noise estimate instead of writing Infinity to history.

**NR Character:** New 0–1 slider (default `0.35`) in Advanced DSP settings; it affects:
- Minimum spectral gain `0.28 - 0.19*character` (0.28 natural → 0.09 aggressive).
- Regional speech-protection blend `0.65 - 0.35*character` with Speech Preservation enabled (less protection with it disabled).
- Noise suppression/release `115 - 70*character` milliseconds (115 ms natural → 45 ms aggressive).
- Moderate power oversubtraction `1 + 6*strength*(0.9 + 0.2*character)`.

**NR Strength stays separate:** `nr_snr` is unchanged and still means 0–30 suppression strength, not SNR dB. At strength 0, the NR block is skipped, **including NR output gain**, even if it has been set to a nonzero value.

The Weak SSB/DX preset includes `nr_character: 0.45`; Warm AM uses `0.25`. All factory defaults resolve to `0.35`. Older saved profiles lacking this key inherit the default, while normal parameter storage, preset selection and JSON import/export automatically retain explicit Character choices.

For the first on-air trial, try **NR Strength 12–18**, **NR Character 0.30–0.40**, NR output gain 0 dB, and Speech Preservation enabled. Compare with 2.1 on the same weak SSB station at matched overall volume. Increased naturalness may come at the expense of some absolute hiss attenuation.

**Regression tests:** `node tests/validate-speech-nr.cjs` checks constructor-allocated and reset per-bin state at 22.05/48/96 kHz; modulation switching and NR re-enabling; true strength-zero unity behavior after NR was active; finite noise-history recovery for speech-protected windows; and NR Character's influence on suppression. The original numerical DSP, Worklet, modulation/preset, and noise-floor-jump tests also run.

## What's new in the 2.1 beta

**New adaptive spectral NR:** The FFT processor now tracks a short-window, spectrally smoothed noise-floor minimum over approximately 720 ms and applies a Wiener-style, frequency/time-smoothed attenuation envelope. The intent is to respond to a changing HF noise floor without treating every strong speech syllable as noise. The NR strength slider uses the **same saved numerical key** (`nr_snr`) but now ranges from 0 = effectively no reduction to 30 = aggressive reduction; it's no longer a calibrated SNR-dB threshold. Existing saved numbers survive the upgrade but will sound different, so retune them.

Recommended initial listening test: disable the separate receiver's built-in NR and Studio compressor; enable Studio NR; try **NR strength 12–18**, `NR smoothing` 0.970–0.982, `NR output gain` 0 dB, and Speech Preservation on. A/B with NR off on the same weak HF signal. Continuous broadband hiss is the target; electrical clicks need NB, and stable heterodynes need Notch. Noise reduction will sometimes color weak speech, especially at high strengths.

**Listening presets** (selector above NB/Notch/NR/EQ/Comp): 

| Modulation | Named listening presets |
| --- | --- |
| SSB (USB/LSB) | Factory SSB, Weak SSB / DX, Wide SSB |
| AM | Factory AM, Hi-Fi AM, Warm AM, AM Communications |
| CW | Factory CW, CW Narrow, CW Wide |
| NFM/WFM/Digital | Factory mode preset |

Selecting a named preset replaces **only the currently selected modulation's parameter overrides** and immediately applies the profile. Where indicated it also enables or disables global EQ/NR/compression module switches. **Merely changing the receiver modulation never changes those global on/off switches.** Changing a slider after applying a preset automatically displays **Custom (manual)**. Prior saved profiles continue to load as Custom without being overwritten; `Reset mode` clears current-mode parameter overrides as before. Use the **Export** button to back up presets and tuning before experimenting.

Preset mode switching is automatic based on OpenWebRX+'s actual demodulator panel, but a listening preset is chosen explicitly by the operator. **Hi-Fi AM cannot recreate frequencies that the receiver's demodulator/bandwidth settings have already filtered out**; widen the receiver AM filter if available.

The plugin intentionally retains `AudioFilterPlugin.build === 'studio-2.0.0'` so older `init.js` compatibility checks keep passing. Check `AudioFilterPlugin.revision` or `AudioFilterPlugin.status().revision` for `2.1.0-beta.3`.

**Signal processing regression checks:** GitHub Actions runs `node tests/validate-nr-presets.cjs` alongside the existing DSP, worklet, default-resolution, and receiver-mode tests. A deterministic synthetic broadband-noise test measured approximately 3.3 dB reduction at strength 16 and 7.8 dB at strength 26, with a weak-tone projection retained. These tests are not equivalent to listening tests with live SSB, fading, static crashes, or AM broadcasts.

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

   **If you already have the early-loading configuration working, do not edit `init.js` at all for this upgrade.** Do not paste a second entire async block into an existing init.js. Insert only the `await Plugins.load('audio_filter');` line into its existing startup function. Remove any old `audio_filter` remote URL registrations. Do not call `Plugins.load()` twice for the same name. Keep all other working plugin lines intact.

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