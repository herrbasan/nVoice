/**
 * Built-in command and action definitions for the assistant layer.
 *
 * Two categories:
 *   - COMMANDS: transcript manipulation handled by the SDK itself (delete, undo, paragraph).
 *     The LLM detects these from spoken phrases; the SDK executes them on the segment array.
 *   - ACTIONS: app-defined pass-through triggers. The LLM detects the intent; the SDK
 *     emits an event; the consuming app decides what to do.
 *
 * Custom actions are registered at runtime via the WS query string or SDK config.
 * They are merged into the LLM prompt so the model knows what phrases to listen for.
 */

/**
 * Built-in commands — always available, handled by the SDK.
 * The LLM returns one of these ids when it detects a spoken editing command.
 */
const BUILTIN_COMMANDS = [
  { id: 'delete_last_sentence', phrases: ['scratch that', 'delete that', 'strike that', 'scratch last sentence', 'delete last sentence'] },
  { id: 'delete_last_paragraph', phrases: ['delete last paragraph', 'scratch paragraph', 'delete paragraph'] },
  { id: 'undo', phrases: ['undo that', 'undo last', 'put it back'] },
  { id: 'paragraph_break', phrases: ['new paragraph', 'next paragraph', 'paragraph break'] },
];

/**
 * Default actions — emitted as events, the consuming app handles them.
 * Apps can register additional actions via the WS query string (?actions=send_message:send it,send message).
 */
const DEFAULT_ACTIONS = [
  { id: 'send_message', phrases: ['send message', 'send it', 'send'] },
];

/**
 * Parse custom actions from a query string parameter.
 * Format: "action_id:phrase1,phrase2;action_id2:phrase3"
 *
 * @param {string|null} actionsParam
 * @returns {Array<{id: string, phrases: string[]}>}
 */
export function parseCustomActions(actionsParam) {
  if (!actionsParam) return [];
  const actions = [];
  for (const entry of actionsParam.split(';')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const id = entry.slice(0, colonIdx).trim();
    const phrases = entry.slice(colonIdx + 1).split(',').map(p => p.trim()).filter(Boolean);
    if (id && phrases.length) actions.push({ id, phrases });
  }
  return actions;
}

/**
 * Build the action/command description for the LLM prompt.
 * Returns a text block listing all detectable commands and actions.
 *
 * @param {Array<{id: string, phrases: string[]}>} customActions
 * @returns {string}
 */
export function buildActionPrompt(customActions = []) {
  const lines = [];

  lines.push('COMMANDS (editing, return {"command": "<id>"}):');
  for (const cmd of BUILTIN_COMMANDS) {
    lines.push(`  ${cmd.id}: "${cmd.phrases.join('", "')}"`);
  }

  const allActions = [...DEFAULT_ACTIONS, ...customActions];
  if (allActions.length) {
    lines.push('');
    lines.push('ACTIONS (triggers, return {"action": "<id>"}):');
    for (const act of allActions) {
      lines.push(`  ${act.id}: "${act.phrases.join('", "')}"`);
    }
  }

  return lines.join('\n');
}

export { BUILTIN_COMMANDS, DEFAULT_ACTIONS };
