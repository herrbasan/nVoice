"""
Speaker-Turn Merge Logic

Aligns faster-whisper transcription segments with pyannote speaker turns
by timestamp overlap. Each whisper segment gets assigned the speaker who
has the most overlapping speech time.

This runs AFTER both transcription and diarization are complete. The
diarization turns cover the whole file (global clustering), so speaker
IDs are consistent across all segments — even when transcription was
chunked for progress events.
"""


def merge_segments(whisper_segments, speaker_turns):
    """
    Assign a speaker to each whisper segment based on timestamp overlap
    with pyannote speaker turns.

    Args:
        whisper_segments: list of dicts with "start" and "end" keys (seconds).
                          Typically STTSegment.to_dict() output. Modified in-place
                          by adding a "speaker" key.
        speaker_turns: list of dicts with "start", "end", "speaker" keys.
                       Output of Diarizer.diarize().

    Returns:
        The same list of segment dicts, each now with a "speaker" key (int).
        Segments with no overlapping speaker turn inherit the previous
        segment's speaker (or 0 if it's the first segment).
    """
    if not whisper_segments:
        return whisper_segments
    if not speaker_turns:
        for seg in whisper_segments:
            seg["speaker"] = 0
        return whisper_segments

    # Sort turns by start time for efficient scanning
    sorted_turns = sorted(speaker_turns, key=lambda t: t["start"])

    merged = []
    for seg in whisper_segments:
        seg_start = seg["start"]
        seg_end = seg["end"]
        speaker_scores = {}  # speaker_id → overlap_seconds

        for turn in sorted_turns:
            # Turns are sorted by start; once we're past the segment, stop.
            if turn["start"] >= seg_end:
                break
            # Skip turns that end before this segment starts.
            if turn["end"] <= seg_start:
                continue

            # Compute overlap duration
            overlap_start = max(seg_start, turn["start"])
            overlap_end = min(seg_end, turn["end"])
            overlap = overlap_end - overlap_start
            if overlap > 0:
                spk = turn["speaker"]
                speaker_scores[spk] = speaker_scores.get(spk, 0) + overlap

        if speaker_scores:
            best_speaker = max(speaker_scores, key=speaker_scores.get)
        else:
            # No overlap — inherit from previous segment's speaker.
            # For archival audio with gaps (music, silence), this keeps
            # continuity rather than defaulting everyone to speaker 0.
            best_speaker = merged[-1]["speaker"] if merged else 0

        seg["speaker"] = best_speaker
        merged.append(seg)

    return merged


def compute_speaker_stats(segments):
    """
    Compute total speech duration per speaker from merged segments.

    Args:
        segments: list of dicts with "start", "end", "speaker" keys.

    Returns:
        List of {"id": int, "total_speech_sec": float} sorted by speaker id.
    """
    totals = {}
    for seg in segments:
        spk = seg.get("speaker", 0)
        duration = seg["end"] - seg["start"]
        totals[spk] = totals.get(spk, 0) + duration

    return [
        {"id": spk, "total_speech_sec": round(sec, 1)}
        for spk, sec in sorted(totals.items())
    ]
