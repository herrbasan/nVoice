# nVoice WebRTC JavaScript SDK

Zero-dependency vanilla JS client for real-time STT via WebRTC. Includes client-side Silero VAD for wake-on-voice.

## Usage

```html
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.js"></script>
<script src="/sdk/nVoiceClient.js"></script>
```

```javascript
const client = new nVoiceClient({ serverUrl: '' });

client.on('connected', () => console.log('Connected'));
client.on('transcript', (data) => {
    console.log(data.is_final ? 'FINAL:' : 'PROV:', data.text);
});
client.on('telemetry', (data) => console.log(`RTF: ${data.rtf} Backlog: ${data.backlog_sec}s`));

// Plain STT (no wake word)
await client.start();

// With wake-on-voice (VAD triggers on any speech)
await client.enableWakeWord('/sdk/silero_vad.onnx');
await client.start(); // Starts asleep, wakes on speech, auto-sleeps after final transcript + silence

client.stop();       // Mute mic, keep connection
client.disconnect(); // Full teardown
```

## API

### Constructor
`new nVoiceClient({ serverUrl, audioDeviceId })`

### Methods

| Method | Description |
|--------|-------------|
| `start()` | Get mic, establish WebRTC, start audio. If wake word enabled, starts asleep. |
| `stop()` | Mute mic (silent dummy track), keep connection alive. |
| `disconnect()` | Full teardown: close PeerConnection, DataChannel, AudioContext. |
| `setAudioDevice(id)` | Set mic device ID for next `start()`. |
| `enableWakeWord(modelUrl)` | Load Silero VAD ONNX model. Enables wake-on-voice mode. Must be called before `start()`. |
| `sleep()` | Manually put to sleep (swap to dummy track, resume VAD listening). |
| `on(event, cb)` / `off(event, cb)` | Event listener management. |

### Events

| Event | Description |
|-------|-------------|
| `connected` | WebRTC + DataChannel open. |
| `disconnected` | Connection closed. |
| `standby` | Mic muted, connection kept alive (`stop()`). |
| `transcript` | `{ text, is_final }` from backend. |
| `telemetry` | `{ rtf, backlog_sec, state }` from backend. |
| `wakeWordDetected` | VAD detected speech, backend now receiving live mic. |
| `asleep` | System went to sleep (dummy track active, VAD listening). |
| `error` | Irrecoverable error. |

## Wake-on-Voice Flow

1. `enableWakeWord()` loads the Silero V4 legacy ONNX model.
2. `start()` sends a silent dummy track to the backend (0% compute). VAD runs locally via AudioWorklet.
3. VAD detects speech probability > 50% → hot-swaps live mic track → backend Whisper processes.
4. Backend sends `is_final` transcript → SDK starts counting silence frames (~3s).
5. Silence threshold met → auto-sleep: swap back to dummy track, reset VAD state.

## Model File

`sdk/silero_vad.onnx` is the Silero V4 legacy model from `@ricky0123/vad`. Input signature: `input`, `sr`, `h` [2,1,64], `c` [2,1,64]. Output: `output`, `hn`, `cn`. Frame size: 1536 samples at 16kHz (96ms).
