"""
nVoice v3 — WebRTC Manager

Manages RTCPeerConnection instances and wires incoming audio tracks to the
appropriate realtime strategy driver.

v3 changes from v2:
  - Engine-agnostic: accepts any adapter with a realtime_strategy()
  - Strategy selection: buffer-retranscribe → BufferRetranscribeStrategy
  - Shared VAD: passes SileroVAD to the strategy (G7)
  - AudioConsumer logic extracted to realtime/buffer_retranscribe.py (G4)
"""
import asyncio
import json
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
import av

from nvoice.logger import get_logger

logger = get_logger("webrtc")


class RealtimeSession:
    """
    Consumes a WebRTC audio track, resamples to 16kHz mono float32,
    and feeds frames to the realtime strategy driver.

    Replaces v2 AudioConsumer. The daemon loop logic now lives in the
    strategy driver (realtime/buffer_retranscribe.py), extracted verbatim (G4).
    """

    def __init__(self, track, dc, strategy, sample_rate=16000):
        self.track = track
        self.dc = dc
        self.strategy = strategy
        self.sample_rate = sample_rate

        self.resampler = av.audio.resampler.AudioResampler(
            format='flt', layout='mono', rate=sample_rate
        )

        self._ingest_task = None
        self._poll_task = None
        self._running = False

    def start(self):
        self._running = True
        self._ingest_task = asyncio.create_task(self._ingest_loop())
        self._poll_task = asyncio.create_task(self._poll_loop())
        self.strategy.start()
        logger.info(f"RealtimeSession started (strategy={type(self.strategy).__name__})")

    def stop(self):
        self._running = False
        if self._ingest_task:
            self._ingest_task.cancel()
        if self._poll_task:
            self._poll_task.cancel()
        if self.strategy:
            self.strategy.stop()
        logger.info("RealtimeSession stopped")

    async def _ingest_loop(self):
        """Receive WebRTC frames, resample, feed to strategy."""
        frame_count = 0
        while self._running:
            try:
                frame = await self.track.recv()
                for resampled_frame in self.resampler.resample(frame):
                    plane = resampled_frame.planes[0]
                    np_audio = np.frombuffer(plane, dtype=np.float32)
                    self.strategy.on_audio(np_audio)
                    frame_count += 1
                    if frame_count % 100 == 0:
                        buf_sec = len(self.strategy.audio_buffer) / self.sample_rate
                        logger.info(f"Ingest: {frame_count} frames, buffer={buf_sec:.1f}s")
            except Exception as e:
                logger.info(f"Ingest loop stopping: {e}")
                self.stop()
                break

    async def _poll_loop(self):
        """Poll the strategy for events and send them over the DataChannel."""
        while self._running:
            try:
                events = self.strategy.poll()
                for event in events:
                    if self.dc and getattr(self.dc, "readyState", "open") == "open":
                        self.dc.send(json.dumps(event))
                await asyncio.sleep(0.05)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Poll loop error: {e}")
                await asyncio.sleep(0.5)


def create_strategy(adapter, config=None):
    """
    Create the appropriate realtime strategy for the adapter.
    config is a dict (from config.json) or None for defaults.
    Returns a RealtimeStrategy instance or raises if unsupported.
    """
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


class WebRTCManager:
    """
    Manages RTCPeerConnection instances for realtime sessions.

    Unlike v2, this is engine-agnostic — it receives an adapter and creates
    the appropriate strategy driver from adapter.realtime_strategy().
    """

    def __init__(self, adapter, config=None):
        self.adapter = adapter
        self.config = config or {}
        self.pcs = set()

    async def process_offer(self, offer_sdp, offer_type):
        logger.info(f"Processing WebRTC offer (sdp length={len(offer_sdp)})")
        offer = RTCSessionDescription(sdp=offer_sdp, type=offer_type)
        pc = RTCPeerConnection()
        self.pcs.add(pc)

        session = None
        data_channel = None

        @pc.on("datachannel")
        def on_datachannel(channel):
            nonlocal data_channel
            data_channel = channel
            logger.info(f"DataChannel opened: {channel.label}")
            if session:
                session.dc = channel

        @pc.on("track")
        def on_track(track):
            nonlocal session
            logger.info(f"Track received: kind={track.kind}, id={track.id}")
            if track.kind == "audio":
                strategy = create_strategy(self.adapter, self.config)
                logger.info(f"Created strategy: {type(strategy).__name__}")
                session = RealtimeSession(
                    track, data_channel, strategy,
                    sample_rate=16000,
                )
                session.start()

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info(f"Connection state: {pc.connectionState}")
            if pc.connectionState in ("failed", "closed"):
                if session:
                    session.stop()
                self.pcs.discard(pc)

        await pc.setRemoteDescription(offer)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        logger.info(f"SDP answer created (length={len(pc.localDescription.sdp)})")

        return {
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type,
        }
