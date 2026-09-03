# Assistant LLM Prompts

Every file here is an LLM system prompt. **The file content is the prompt** — it is
sent verbatim (trimmed) to the model. Markdown syntax has no special meaning;
the model just reads the text.

## Files

| File | Used by | Behavior |
|------|---------|----------|
| `assistant-sentence.md` | Realtime WS assistant, per settled sentence (`AssistantSession.process`) | Returns JSON: action / command / correction. Contains the `{{actions}}` placeholder — **do not remove it**, the command/action list is injected there. |
| `dictation-cleanup.md` | `POST /v1/assistant/clean` ("ok kimi stop" dictation flow) | Removes voice-command remnants and STT misfires (incl. Russian misfires). |
| `handsfree-reply.md` | `POST /v1/assistant/chat` | Short TTS-friendly driver-assistant replies. |
| `command-classifier.md` | `POST /v1/assistant/command` | Classifies post-"ok kimi" utterance into listen/stop/send/message. Returns JSON. |
| `cleanup-clean.md` | `POST /v1/audio/cleanup` mode `clean` | Validated two-tier cleanup: safe surface fixes always, corrections only when unambiguous. |
| `cleanup-format.md` | `POST /v1/audio/cleanup` mode `format` | Same cleanup + deliberate paragraph organization. |
| `cleanup-compact.md` | `POST /v1/audio/cleanup` mode `compact` | Full rewrite: fewest words, all facts kept. |

## Live editing

Prompt files are **re-read on every LLM call** — edit, save, retry the request.
No server restart needed.

## Adding a cleanup mode

Drop a new `cleanup-<mode>.md` file in this folder and restart the server once.
The mode is immediately valid on `POST /v1/audio/cleanup` (`"mode": "<mode>"`).
Required files are validated at startup; deleting one crashes the server
(fail fast).

## Rules of thumb (from validated experiments, 2026-09-02)

- Explicit multilingual filler lists (EN + DE) beat generic instructions.
- Few-shot `Input:` / `Output:` examples anchor the transformation.
- Frame cleanup as mandatory ("surface form is yours to fix; preserve only
  semantic content") — pure preservation instructions make the model return
  text unchanged.
- For corrections (self-corrections, "strike that"), state the conservative
  fallback explicitly: if unclear, change nothing.
