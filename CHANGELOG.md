# Changelog

## 2.2.0-beta.1 — in development (2026-10-17)

- **No audio graph changes:** preserve existing FFT, 50% hop, overlap-add and intrinsic latency, single AudioWorklet, fail-open routing, preset storage, and modulation detection.
- Add per-frequency-bin decision-directed `nrPriorSNR` (ξ), previous posterior SNR (`nrPrevGamma`), and smoothed speech-presence probability (`nrSpeechProb`). All state arrays are allocated only in the constructor.
- Speech-presence rise/decay constants: 25/160 ms. Noise estimator protects probable speech against rapid upward contamination and expires protective holds after 650 ms so sustained broadband interference can still be acquired.
- Replace fixed per-frame gain smoothing with sample-rate-invariant 12 ms speech recovery and Character-adjustable noise close/release (~90.5 ms at default). Add ±2-bin local speech-region preservation to the original tonal guard.
- Introduce `nr_character` 0–1 (default 0.35) as a standard saved, exported, imported, and preset-compatible slider. Character affects gain floor, protection, slow noise closing, and mild power oversubtraction independently of NR Strength.
- Preserve true bypass at NR Strength=0 even when NR output gain is nonzero; reset estimated speech/noise state on enabling NR, changing modulation, or moving Strength from 0 to positive.
- Add `tests/validate-speech-nr.cjs` to CI for constructor-only state allocations, reinitialization, strength-zero unity, finite sliding-window history, and Character effect. Existing tests and synthetic noise-reacquisition checks pass.
- Awaiting live-receiver speech intelligibility and artifact evaluation before release.

## 2.1.0-beta.3 — 2026-10-17

- Add adaptive 720-ms minimum-statistics spectral noise estimation with smoothed bin magnitudes and bounded Wiener-style suppression; NR strength has a true zero endpoint.
- Retain existing `nr_snr` storage for backward compatibility but interpret it as **strength**, not a measured SNR-dB threshold.
- Reset the NR noise model on enabling NR or switching modulation; retain allocation-free worklet processing.
- Add named listening presets: Weak SSB/DX, Wide SSB, Hi-Fi AM, Warm AM, AM Communications, CW Narrow, CW Wide.
- Apply named presets only to the current modulation; pre-existing manual settings remain intact and appear as Custom.
- Show a preset selector in the Studio window; module toggles change only on explicit preset selection, never automatically with receiver-mode changes.
- Add deterministic synthetic noise/weak-tone and preset state regression tests to CI. Existing routing and demodulator tracking unchanged.
- Keep the compatibility `build` identifier while exposing `revision: '2.1.0-beta.3'`.

## 2.0.x — beta.2 bugfixes

- Detect AM/CW/USB/LSB and other modes from OpenWebRX+'s actual jQuery DemodulatorPanel (`#openwebrx-panel-receiver`), rather than stale or incompatible selectors; include its highlighted mode buttons as a fallback and avoid lazily creating the receiver panel before initialization.

- Fix `AudioFilterPlugin.settings().mode` always reporting `ssb` even when the receiver is in AM or CW; report the live modulation and global enabled-module states using the same effective settings sent to the DSP.

- Fix Studio sliders/knobs initially displaying their minimum instead of the DSP's actual defaults (especially Output gain, NR gain, compressor boost, tonal guard and AGC target).
- Resolve all six modulation profiles against one canonical set of AudioWorklet/ScriptProcessor defaults.
- Save only new per-mode user overrides; retain existing stored settings without resetting preferences. `Reset mode` clears overrides for the current mode.
- Keep the Speech Preservation checkbox in sync after mode switches and preset reset.
- Add a UI/DSP default regression test for all 23 controls and six modulation modes to GitHub Actions.
- No intentional change to the NR algorithm or signal path.

## 2.0.0-beta.1 — 2026-10-16

Engineering preview; not yet confirmed on a live OpenWebRX+ receiver.

- Replaced separate audio DSP processors with one AudioWorklet kernel; shared core with a ScriptProcessor fallback.
- Added dry/wet fail-open routing with heartbeat-based activation, manual attachment API, and diagnostic status information.
- Refactored spectral noise reduction around circular buffers and 50% overlapping STFT windows.
- Added conservative notch defaults and modulation-oriented SSB/AM/CW settings.
- Redesigned the Studio control panel and retained legacy localStorage keys.
- Added numerical DSP tests covering multiple sample rates and a simulated generated worklet.

### Known limitations

- Interception cannot retroactively discover a fully connected receiver audio graph.
- Live OpenWebRX+ and secure-origin AudioWorklet compatibility remain unverified.
- This is a browser-side plugin, not a server-side DSP module.
