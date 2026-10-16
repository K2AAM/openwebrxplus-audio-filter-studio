# Changelog

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
