"""
Realtime strategy base interface.

A realtime strategy is a specialized driver for live audio streaming.
Each strategy is engine-class-specific:
  - buffer-retranscribe: batch model re-run on growing window (faster-whisper)
  - native-streaming: true streaming recognizer (sherpa-onnx)

The strategy ingests audio frames and emits transcript/telemetry events.
Endpointing/commit logic lives INSIDE the strategy, not in a shared loop.

Transport (WebSocket) lives in worker_routes.py; this module is transport-agnostic.
"""
import abc


class RealtimeStrategy(abc.ABC):
    """Base class for realtime strategies."""

    @abc.abstractmethod
    def on_audio(self, frames):
        """Ingest resampled 16kHz mono float32 frames."""
        ...

    @abc.abstractmethod
    def poll(self):
        """Return any transcript/telemetry events to emit to the client.
        Event shapes: {"type": "transcript", ...} or {"type": "telemetry", ...}"""
        ...

    @abc.abstractmethod
    def stop(self):
        """Clean up resources."""
        ...


def create_strategy(adapter, config=None):
    """
    Create the appropriate realtime strategy for the adapter.
    config is a dict (from config.json) or None for defaults.
    Returns a RealtimeStrategy instance or raises if unsupported.
    """
    from nvoice.logger import get_logger
    logger = get_logger("realtime")

    cfg = config or {}
    strategy_name = adapter.realtime_strategy()
    if strategy_name is None:
        raise ValueError("Engine does not support realtime")

    # Shared VAD (G7) — lazy-loaded
    vad = None
    vad_cfg = cfg.get('vad', {})
    vad_enabled = vad_cfg.get('backend_stage', True)
    if vad_enabled:
        try:
            from nvoice.vad import SileroVAD
            vad = SileroVAD(threshold=vad_cfg.get('backend_threshold', 0.5))
        except Exception as e:
            logger.warning(f"VAD init failed, falling back to RMS: {e}")

    if strategy_name == "buffer-retranscribe":
        from nvoice.realtime.buffer_retranscribe import BufferRetranscribeStrategy
        return BufferRetranscribeStrategy(
            stt_engine=adapter,
            sample_rate=16000,
            vad=vad,
            buffer_min_sec=cfg.get('buffer_min_sec', 0.3),
            commit_silence_tail_sec=cfg.get('commit_silence_tail_sec', 1.0),
        )

    if strategy_name == "native-streaming":
        # For engines that declare native-streaming but don't have a dedicated
        # streaming strategy driver yet, fall back to buffer-retranscribe.
        # This works well for fast engines like Parakeet (RTF ~0.1) where
        # re-transcribing the growing buffer is cheap.
        # TODO: implement realtime/parakeet_streaming.py for true chunked inference
        from nvoice.realtime.buffer_retranscribe import BufferRetranscribeStrategy
        logger.info("native-streaming: falling back to buffer-retranscribe (no dedicated strategy yet)")
        return BufferRetranscribeStrategy(
            stt_engine=adapter,
            sample_rate=16000,
            vad=vad,
            buffer_min_sec=cfg.get('buffer_min_sec', 0.3),
            commit_silence_tail_sec=cfg.get('commit_silence_tail_sec', 1.0),
        )

    raise ValueError(f"Unknown realtime strategy: {strategy_name}")
