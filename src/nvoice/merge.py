"""
Speaker-Turn Merge Logic

Aligns faster-whisper transcription segments with pyannote speaker turns
by timestamp overlap.

IMPORTANT: The merge operates at WORD level, not segment level. Whisper
segments can be very long (30-90s) and span multiple speakers. If we assign
a speaker per segment, the dominant speaker always wins. Instead, each WORD
gets assigned to a speaker individually based on its timestamp, then
consecutive same-speaker words are grouped into speaker-attributed segments.

This runs AFTER both transcription and diarization are complete. The
diarization turns cover the whole file (global clustering), so speaker
IDs are consistent across all segments — even when transcription was
chunked for progress events.
"""


def _assign_speaker_at_timestamp(t, speaker_turns_sorted):
    """
    Find the speaker with the most overlap at timestamp t.
    Uses the sorted turns list for efficiency.
    """
    best_speaker = None
    best_overlap = 0
    for turn in speaker_turns_sorted:
        if turn["start"] > t:
            break  # turns are sorted; no more can contain t
        if turn["end"] >= t:
            # This turn contains t. Use its duration as weight
            # (longer turns are more confident).
            overlap = turn["end"] - turn["start"]
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = turn["speaker"]
    return best_speaker


def merge_segments(whisper_segments, speaker_turns):
    """
    Assign speakers to whisper segments using WORD-LEVEL timestamps.

    Each word in each segment is assigned to the speaker whose turn
    contains that word's midpoint. Then the segment is split whenever
    the speaker changes, producing speaker-attributed sub-segments.

    Args:
        whisper_segments: list of dicts with "start", "end", "text", "words"
                          keys. "words" should be a list of
                          {"word", "start", "end"} dicts.
        speaker_turns: list of dicts with "start", "end", "speaker" keys.

    Returns:
        List of segment dicts, each with a "speaker" key (int). Segments
        are split at speaker boundaries, so a single whisper segment that
        spans two speakers becomes two output segments.
    """
    if not whisper_segments:
        return whisper_segments
    if not speaker_turns:
        for seg in whisper_segments:
            seg["speaker"] = 0
        return whisper_segments

    sorted_turns = sorted(speaker_turns, key=lambda t: t["start"])

    merged = []
    for seg in whisper_segments:
        words = seg.get("words", [])

        if not words:
            # No word timestamps — fall back to segment-level assignment
            mid = (seg["start"] + seg["end"]) / 2
            spk = _assign_speaker_at_timestamp(mid, sorted_turns)
            if spk is None:
                spk = merged[-1]["speaker"] if merged else 0
            seg["speaker"] = spk
            merged.append(seg)
            continue

        # Assign each word to a speaker based on its midpoint
        word_speakers = []
        for w in words:
            mid = (w["start"] + w["end"]) / 2
            spk = _assign_speaker_at_timestamp(mid, sorted_turns)
            if spk is None:
                # No turn covers this word — inherit from previous word
                spk = word_speakers[-1] if word_speakers else 0
            word_speakers.append(spk)

        # Group consecutive words by speaker → split segment
        groups = []  # list of (speaker, [word_indices])
        for i, spk in enumerate(word_speakers):
            if groups and groups[-1][0] == spk:
                groups[-1][1].append(i)
            else:
                groups.append((spk, [i]))

        # Create one output segment per speaker group
        for spk, indices in groups:
            group_words = [words[i] for i in indices]
            new_seg = {
                "text": "".join(
                    w["word"] if "word" in w else f" {w.get('word', '')}"
                    for w in group_words
                ).strip(),
                "start": group_words[0]["start"],
                "end": group_words[-1]["end"],
                "speaker": spk,
                "words": group_words,
            }
            merged.append(new_seg)

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
