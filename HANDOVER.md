# Handover Document

## Current Objective
The goal is to integrate Qwen3-ASR as a real-time/batch engine backend for nVoice. The server receives audio chunks via WebRTC, uses silero-vad to detect pauses, and invokes the transcription backend. 

## Infrastructure Status
- **Environment:** Dedicated venv/qwen3_asr/env setup.
- **Hardware Acceleration:** Successfully working on RTX 5090. Installed PyTorch Nightly (cu132) because standard cu126 wheels lack sm_120 binaries, leading to kernel errors.
- **Voice Activity Detection (VAD):** silero-vad model is loading correctly. WebRTC correctly groups audio and detects silence endpoints correctly.
- **WebRTC Ingestion:** The aiortc handler captures Opus streams, uses av.AudioResampler to convert to float32 16000Hz mono, and buffers the samples into a list.

## Current Bug
On VAD silence timeouts, webrtc.py converts the mock samples list into a numpy array (np.array(samples, dtype=np.float32)) and feeds it to Qwen3ASRAdapter.transcribe_array(). 
- The GPU processes the request successfully.
- No tracebacks occur.
- However, the output returned is consistently empty ''.

## Debugging Attempts
- Isolated engine.transcribe_array() in an external script and fed it synthetically generated audio and a real audio file downloaded via Wikipedia. Result: Qwen3 processes and outputs correct text for valid .ogg/.wav files loaded with soundfile and resampled to 16000Hz float32 mono.
- Tested amplitude scaling (quiet vs normal volume) to verify if the float range was incompatible, but Qwen3 transcribed successfully in all external test cases.
- Suspect an issue with the framing/buffering structure from the WebRTC stream or an unexpected artifact created by av.AudioResampler.resample(frame).to_ndarray().flatten().tolist().

## Next Actions Recommended
1. Dump the np.float32 chunk accumulated by webrtc.py into a physical .wav file right before self.engine.transcribe_array(samples_arr, 16000) is called.
2. Inspect the dumped audio using an external audio player to check for static, silence, or encoding errors.
3. Compare the WebRTC arrays min/max/mean amplitude with soundfile loaded test values.
