# nVoice JavaScript SDK

The `nVoiceClient` SDK allows you to drop nVoice's streaming LLM-enhanced Speech-to-Text directly into your integrations (like a chat app, assistant, or interactive agent).

It securely handles:
1. Microphone permission acquiring
2. Stream configuration (Echo Cancellation / Noise Suppression)
3. WebRTC lifecycle (ICE matching, DataChannels, Offer/Answer SDP negotiations)
4. Standardized JSON callbacks handling 

## Usage

Simply import the class and instantiate it pointing to your running API instance:

```javascript
import { NVoiceClient } from './sdk/nVoiceClient.js';

// Setup state
let accumulatedText = [];
let partialString = "";

const nvoice = new NVoiceClient({
    serverUrl: 'https://localhost:2245',

    // Callback when speech is detected but the user hasn't paused yet
    onPartial: (text) => {
        partialString = text;
        console.log(`[Partial]: ${accumulatedText.join(" ")} ${text}`);
    },

    // Callback when a sentence has been completed and cut by the VAD logic
    onFinal: (text, info) => {
        partialString = "";
        accumulatedText.push(text);
        console.log(`[Raw DB]: Segment saved -> ${text}`);
    },

    // Callback containing the grammar-corrected/enhanced transcript from the LLM
    onEnhanced: (enhancedText) => {
        // NOTE: The enhanced text contains the full revised transcript history, 
        // not just the latest segment chunk. You can directly overwrite the view.
        console.log(`[UPGRADED]: ${enhancedText}`);
        document.getElementById('display').innerText = enhancedText;
    },

    onStateChange: (state) => {
         // 'disconnected' | 'connecting' | 'listening'
         console.log(`Mic state is now: ${state}`);
    },

    onError: (err) => {
         console.error('nVoice Error: ', err);
    }
});

// Trigger recording on a button click
document.getElementById('record-btn').addEventListener('click', () => {
    if (nvoice.state === 'disconnected') {
        nvoice.start();
    } else {
        nvoice.stop();
    }
});
```

*Note: For browser security, `getUserMedia()` must be triggered from a secure context (`HTTPS` or `localhost`). It also must be triggered by an explicit user interaction (like a physical button click).*