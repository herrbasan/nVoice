# nVoice v2

nVoice is a highly-optimized, real-time Speech-to-Text (STT) inference pipeline coupled with an integrated LLM enhancement bridge. It captures voice efficiently, transcribes it using dynamic chunking natively on local hardware (primarily `faster-whisper`), and gracefully handles hardware backpressure (compute bottlenecks).

## Project Philosophy
* **Zero Necessary Dependencies**: Runs as close to bare metal and standard library Python as possible.
* **Fail Fast**: Explicit errors over defensive coding. If something drops, we let it crash and find the root cause.
* **AI-Readable over Human-Readable**: Coded structurally to be parsed smoothly by intelligent coding agents and local models.

## Core Architecture (v2)
`Browser Audio` > `WebRTC (aiortc)` > `Decoupled Continuous Buffer` > `Dynamic Inference Loop` > `WebRTC Telemetry/Text (Browser UI)`

- **Decoupled Buffering:** Ingestion unconditionally accepts audio and appends it to a ring buffer. The inference loop grabs dynamic chunks based entirely on available compute context. If STT takes 5 seconds, the next chunk is simply 5 seconds larger, scaling naturally without crash or lockup.
- **Telemetry-First:** Realtime DataChannel payload containing backlog times and processing states keeps the client fully aware of pipeline health.
- **Engine Layer:** Streamlined STT adapter pattern focusing initially on getting safe cursor advancement and overlapping right using `faster_whisper`.

## Setup (WIP)
Documentation scaling back while core architecture is re-written. Reference `legacy_v1` for older configurations.