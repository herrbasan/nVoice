# nVoice WebRTC JavaScript SDK

The nVoice SDK provides a simple, zero-dependency vanilla JavaScript client for integrating real-time Speech-to-Text (STT) into any browser-based application (or Electron apps). 
It leverages WebRTC for ultra-low latency audio streaming and DataChannels for receiving real-time transcripts and pipeline telemetry.

## Installation

Simply include the `nVoiceClient.js` in your project.

```html
<script src="path/to/nVoiceClient.js"></script>
```

Or if using ES modules:

```javascript
import { nVoiceClient } from './nVoiceClient.js';
```

## Quick Start

```javascript
const client = new nVoiceClient({
    serverUrl: 'http://localhost:8000'
});

// Listen for connection state changes
client.on('connected', () => console.log('Connected to nVoice STT!'));
client.on('disconnected', () => console.log('Disconnected.'));

// Listen for transcripts
client.on('transcript', (data) => {
    if (data.is_final) {
        console.log("FINAL:", data.text);
    } else {
        console.log("PROVISIONAL:", data.text);
    }
});

// Listen for telemetry
client.on('telemetry', (data) => {
    console.log(`Server backlog: ${data.backlog_sec}s, RTF: ${data.rtf}`);
});

// Start listening (prompts user for microphone permission)
await client.connect();

// Stop listening
// client.disconnect();
```

## API Reference

### `new nVoiceClient(config)`

Creates a new instance of the nVoice client.

**Parameters:**
- `config` (Object):
  - `serverUrl` (String): The URL of the nVoice backend server (default: `http://localhost:8000`).
  - `audioDeviceId` (String, optional): Specific microphone device ID to use.

### Methods

#### `async connect()`
Requests microphone access from the user, establishes a WebRTC peer connection, and negotiates with the backend server via its `/offer` REST endpoint. 

**Returns:** `Promise<void>` - Resolves when the connection and DataChannel are fully established.

#### `disconnect()`
Stops all audio tracks, closes the DataChannel and WebRTC PeerConnection, and resets the client state.

### Events

The client extends a simple event emitter interface. Use `.on(eventName, callback)` and `.off(eventName, callback)` to manage listeners.

| Event Name | Description | Callback Arguments |
|------------|-------------|--------------------|
| `connected` | Fired when the WebRTC connection & DataChannel are securely open. | None |
| `disconnected` | Fired when the connection is closed or fails. | None |
| `transcript` | Fired when the engine emits speech text. | `data` (Object): `{ text: String, is_final: Boolean }` |
| `telemetry` | Fired periodically by continuous back-end metrics. | `data` (Object): `{ rtf: Number, backlog_sec: Number, state: String }` |
| `error` | Fired when an irrecoverable error occurs. | `error` (Error object) |

## Event Payload Formats

### Transcript Payload
```javascript
{
    "type": "transcript",
    "text": "Hello world",
    "is_final": false // true if the user paused/stopped speaking, false for real-time uncommitted updates
}
```

### Telemetry Payload
Provides insight into server-side backpressure and inference speeds.
```javascript
{
    "type": "telemetry",
    "rtf": 0.35,           // Real Time Factor (inference time / audio duration). < 1.0 means faster than real-time.
    "backlog_sec": 2.1,    // Seconds of un-transcribed audio in the server buffer.
    "state": "processing"  // 'processing' or 'idle/silence'
}
```
