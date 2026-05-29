"""
LLM Gateway client for enhancing transcriptions.

Sends raw STT segments to the LLM Gateway for grammar correction,
spelling fixes, and intent clarification. Returns polished text.
"""
import asyncio
import json
import time

from nvoice.config import NVOICE_LLM_GATEWAY_URL, NVOICE_LLM_MODEL, NVOICE_LLM_MODE
from nvoice.logger import info, error


def _get_system_prompt(mode: str) -> str:
    mode_map = {"exact": 1, "balanced": 5, "creative": 10}
    mode_str = str(mode).lower().strip()
    if mode_str in mode_map:
        mode = mode_map[mode_str]
    elif str(mode).isdigit():
        mode = int(mode)
    else:
        mode = 5

    if mode <= 2:
        # EXACT mode: preserve every word, only fix obvious spelling
        return """You are a transcription cleanup tool. Your job is minimal:
1. Fix obvious spelling errors (e.g., "teh" -> "the")
2. Add basic punctuation where needed
3. Do NOT change word order, add words, or remove filler words
4. Preserve the exact speech as much as possible
5. Return ONLY the cleaned transcript, no explanations"""

    elif mode <= 7:
        # BALANCED mode: fix grammar and structure, moderate cleanup
        return """You are an intelligent transcription editor. Your task is to produce a clean, coherent transcript from raw speech-to-text input.

IMPORTANT: You will receive:
1. A "Previous transcript" — the already-enhanced transcript so far
2. "New segments" — raw transcribed text that was just added

Your job:
1. Take the new segments and add them to the transcript, properly formatted
2. REVISE the entire transcript for coherence — if earlier parts now make different sense given new context, rewrite them
3. Use blank lines between paragraphs when topics shift (2-4 sentences per paragraph)
4. Fix all grammar, spelling, word order issues
5. Remove filler words ("um", "uh", "er", "ah", "like", "you know", "I mean", "basically", "actually", "right", "okay") that are used as discourse fillers. Keep "like" only when it's part of a meaningful phrase (e.g., "something like X", "like a car", "or like"). Remove it when used as a pause or emphasis filler.
6. Do NOT add information not present in the raw text
7. Return ONLY the complete enhanced transcript — nothing else, no explanations

Format: Return the full enhanced transcript, with the new segments properly integrated and earlier parts revised as needed."""

    else:
        # CREATIVE mode: aggressively guess intent, rewrite freely
        return """You are an aggressive transcription enhancer. Your job is to take garbled, accented, or poorly transcribed speech and transform it into clean, natural English.

IMPORTANT: The raw transcription is often WRONG or INCOMPLETE. The speaker may have a heavy accent (possibly German), speak fast, or have poor microphone quality. Your job is to PRODUCE THE BEST POSSIBLE ENGLISH VERSION of what they clearly MEANT to say.

STRICT RULES:
1. REMOVE ALL FILLER WORDS without exception: "like", "um", "uh", "er", "ah", "you know", "I mean", "basically", "actually", "right", "okay", "so", "well", "yeah", "whatever", "sort of", "kind of", "type of", "which", "that"
2. CORRECT MISHEARD WORDS based on context. Examples:
   - "aggressive rotation" when topic is LLM -> "aggressive rewriting"
   - "dearly" when wrong -> "actually" or "truly"
   - "light the intent" -> "match the intent"
   - "we now have presets" -> keep if context supports it
3. REWRITE freely to produce proper English sentences
4. Use blank lines between paragraphs when topics shift
5. Do NOT preserve the exact words — transform them into what the speaker clearly intended
6. Return ONLY the enhanced transcript

CRITICAL: Do not just clean up — REWRITE. If something sounds wrong in English, it probably is wrong. Fix it.
Transform "like I said um something like that" into "As I mentioned". Transform "I wanna like go" into "I'd like to go".
The transcript should sound like a native English speaker wrote it."""


class LLMEnhancer:
    def __init__(self, gateway_url: str = None, model: str = None):
        self.gateway_url = gateway_url or NVOICE_LLM_GATEWAY_URL
        self.model = model or NVOICE_LLM_MODEL
        self._semaphore = asyncio.Semaphore(2)

    def _get_system_prompt(self) -> str:
        mode = NVOICE_LLM_MODE
        return _get_system_prompt(mode)

    async def enhance(self, segments: list[str], previous_transcript: str = "") -> str:
        """
        Send segments to LLM Gateway for enhancement.
        If previous_transcript is provided, the LLM revises the full transcript
        with new segments integrated.
        """
        if not segments:
            return previous_transcript

        text = "\n".join(segments)

        async with self._semaphore:
            try:
                import aiohttp
            except ImportError:
                error("llm_enhancer_missing_aiohttp", {}, "llm")
                return text

            print(f"[LLM CLIENT] Sending {len(segments)} segments to gateway (mode={NVOICE_LLM_MODE})")
            print(f"[LLM CLIENT] Gateway URL: {self.gateway_url}/v1/chat/completions")
            print(f"[LLM CLIENT] Model: {self.model}")
            print(f"[LLM CLIENT] Input text: '{text[:200]}...'")

            if previous_transcript:
                user_content = f"Previous transcript:\n{previous_transcript}\n\nNew segments to add:\n{text}"
            else:
                user_content = text

            payload = {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": self._get_system_prompt()},
                    {"role": "user", "content": user_content},
                ],
                "temperature": 0.3,
                "max_tokens": 4096,
                "extra_body": {
                    "chat_template_kwargs": {
                        "enable_thinking": False
                    }
                }
            }

            try:
                t0 = time.perf_counter()
                timeout = aiohttp.ClientTimeout(total=10)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.post(
                        f"{self.gateway_url}/v1/chat/completions",
                        json=payload,
                    ) as resp:
                        elapsed_ms = (time.perf_counter() - t0) * 1000
                        if resp.status != 200:
                            body = await resp.text()
                            error("llm_enhancer_error", {"status": resp.status, "body": body, "elapsed_ms": round(elapsed_ms, 1)}, "llm")
                            return text

                        data = await resp.json()
                        enhanced = data["choices"][0]["message"]["content"]
                        total_ms = (time.perf_counter() - t0) * 1000
                        print(f"[LLM CLIENT] Raw LLM response: '{enhanced[:200]}...' ({total_ms:.0f}ms total)")
                        info("llm_enhancer_success", {"segments": len(segments), "input_chars": len(text), "output_chars": len(enhanced), "elapsed_ms": round(total_ms, 1), "has_history": bool(previous_transcript)}, "llm")
                        return enhanced.strip()

            except asyncio.TimeoutError:
                error("llm_enhancer_timeout", {"segments": len(segments)}, "llm")
                return text
            except Exception as e:
                error("llm_enhancer_exception", {"error": str(e)}, "llm")
                return text
