"""
Realtime strategy base interface.

A realtime strategy is a specialized driver for live audio streaming.
Each strategy is engine-class-specific:
  - buffer-retranscribe: batch model re-run on growing window (faster-whisper)
  - native-streaming: true streaming recognizer (sherpa-onnx)

The strategy ingests audio frames and emits transcript/telemetry events.
Endpointing/commit logic lives INSIDE the strategy, not in a shared loop.
"""
import abc


class RealtimeStrategy(abc.ABC):
    """Base class for realtime strategies."""

    @abc.abstractmethod
    def on_audio(self, frames):
        """Ingest resampled 16kHz mono float32 frames from the WebRTC track."""
        ...

    @abc.abstractmethod
    def poll(self):
        """Return any transcript/telemetry events to emit over the DataChannel.
        Event shapes: {"type": "transcript", ...} or {"type": "telemetry", ...}"""
        ...

    @abc.abstractmethod
    def stop(self):
        """Clean up resources."""
        ...
