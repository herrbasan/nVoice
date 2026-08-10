// Unit test for the kimi state machine (extracted logic).
// Command classification is LOCAL keyword matching (NO gateway):
//   listen / stop / send — language-tolerant (Cyrillic→Latin, because
//   parakeet often auto-detects single words as Russian; "стоп" = "stop"
//   phonetically) with word-boundary matching ("stopwatch" ≠ "stop").

const events = [];
const log = [];

// --- matcher (mirrors sdk/nVoiceClient.js) ---
const _KIMI_CYR_TO_LAT = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};
// Match priority: stop > send > listen ("stop listening" must stop, not listen).
const _KIMI_COMMAND_PHRASES = [
  ['stop',   ['stop', 'stopp', 'stoppen', 'halt']],
  ['send',   ['send', 'sende', 'zend']],
  ['listen', ['listen', 'listening', 'lissin', 'listun']],
];
function _kimiNormalize(raw) {
  let out = '';
  for (const ch of String(raw || '').toLowerCase()) {
    const c = _KIMI_CYR_TO_LAT[ch];
    if (c !== undefined) out += c;
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}
function _kimiMatchCommand(text) {
  const norm = _kimiNormalize(text);
  if (!norm) return null;
  for (const [action, phrases] of _KIMI_COMMAND_PHRASES) {
    for (const p of phrases) {
      const np = _kimiNormalize(p);
      const re = new RegExp('\\b' + np.replace(/\s+/g, '\\s+') + '\\b');
      if (re.test(norm)) return action;
    }
  }
  return null;
}

function makeClient() {
  const c = {
    kimiWakeEnabled: true, wakeWordEnabled: true, isAwake: false,
    _kimiState: 'sleep', _kimiCommandText: '', _kimiCommandFinal: false,
    _kimiDictationText: '', _kimiIdleCount: 0, _kimiIdleToClassify: 3,
    _kimiClassifying: false, _kimiInterruptedTranscribing: false,
    emit(evt, data) { events.push([evt, data]); },
    sleep() { this.isAwake = false; this.emit('asleep', {}); log.push('sleep()'); },
    wake() { this.isAwake = true; this.emit('wakeWordDetected', {}); log.push('wake()'); },
    async _kimiClassifyCommand() {
      if (this._kimiState !== 'command' || this._kimiClassifying) return;
      this._kimiClassifying = true;
      try {
        const text = this._kimiCommandText.trim();
        if (!text) { this._kimiToSleep('empty'); return; }
        const action = _kimiMatchCommand(text);
        log.push('classify(' + text + ')->' + (action || 'none'));
        // A wake that interrupted transcription is only honored for real
        // commands. No match = false wake (it was dictation) → resume.
        if (action === null && this._kimiInterruptedTranscribing) {
          if (text) { this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim(); }
          this._kimiState = 'transcribing'; this._kimiIdleCount = 0; this._kimiInterruptedTranscribing = false;
          this.emit('kimiState', { state: 'transcribing' });
          return;
        }
        // Not a command and nothing was being dictated → silent sleep.
        if (action === null) { this._kimiToSleep('not a command'); return; }
        if (action === 'listen') { this._kimiState = 'transcribing'; this._kimiIdleCount = 0; this._kimiInterruptedTranscribing = false; this.emit('kimiState', { state: 'transcribing' }); this.emit('kimiCommand', { action: 'listen', text }); }
        else if (action === 'stop') { this._kimiState = 'sleep'; this._kimiDictationText = ''; this._kimiInterruptedTranscribing = false; this.emit('kimiCommand', { action: 'stop', text }); this.sleep(); }
        else if (action === 'send') { this._kimiState = 'sleep'; this._kimiInterruptedTranscribing = false; this.emit('kimiCommand', { action: 'send', text, dictation: this._kimiDictationText }); this.sleep(); }
      } finally { this._kimiClassifying = false; }
    },
    _kimiHandleTelemetry(data) {
      if (!this.kimiWakeEnabled || !this.isAwake) return;
      if (this._kimiState === 'command' && this._kimiCommandFinal && data.state === 'idle/silence') {
        this._kimiIdleCount = (this._kimiIdleCount || 0) + 1;
        if (this._kimiIdleCount >= this._kimiIdleToClassify && !this._kimiClassifying) this._kimiClassifyCommand();
      }
    },
    _kimiOnFinal(text) {
      if (this._kimiState === 'command') { this._kimiCommandText = (this._kimiCommandText + ' ' + text).trim(); this._kimiCommandFinal = true; this._kimiIdleCount = 0; }
      else if (this._kimiState === 'transcribing') { this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim(); this._kimiIdleCount = 0; }
    },
    _onKimiWake() {
      if (this._kimiState === 'command') return;
      const wasTranscribing = this._kimiState === 'transcribing';
      this._kimiState = 'command'; this._kimiCommandText = ''; this._kimiCommandFinal = false; this._kimiIdleCount = 0;
      this._kimiInterruptedTranscribing = wasTranscribing;
      if (!this.isAwake) this.wake();
      this.emit('kimiState', { state: 'command' });
    },
    _kimiToSleep(reason) { this._kimiState = 'sleep'; this._kimiCommandText = ''; this._kimiCommandFinal = false; this._kimiIdleCount = 0; this.emit('kimiState', { state: 'sleep' }); if (this.isAwake) this.sleep(); }
  };
  return c;
}
function idle3(c) {
  c._kimiHandleTelemetry({ state: 'idle/silence' });
  c._kimiHandleTelemetry({ state: 'idle/silence' });
  c._kimiHandleTelemetry({ state: 'idle/silence' });
}
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name); } }

// --- matcher unit tests (no state machine) ---
check('m1: stop -> stop', _kimiMatchCommand('stop') === 'stop');
check('m2: russian стоп -> stop', _kimiMatchCommand('стоп') === 'stop');
check('m3: "okay kimi send" -> send', _kimiMatchCommand('okay kimi send') === 'send');
check('m4: russian сенд -> send', _kimiMatchCommand('сенд') === 'send');
check('m5: russian листен -> listen', _kimiMatchCommand('листен') === 'listen');
check('m6: stopwatch NOT stop (word boundary)', _kimiMatchCommand('stopwatch on the desk') === null);
check('m7: "stop listening" -> stop (priority)', _kimiMatchCommand('stop listening') === 'stop');
check('m8: "start listening" -> listen', _kimiMatchCommand('start listening') === 'listen');
check('m9: plain sentence -> null', _kimiMatchCommand('the weather is nice today') === null);
check('m10: "stopp" -> stop', _kimiMatchCommand('stopp') === 'stop');
check('m11: "please zend it" -> send', _kimiMatchCommand('please zend it') === 'send');
check('m12: "halt" -> stop', _kimiMatchCommand('halt') === 'stop');
check('m13: empty -> null', _kimiMatchCommand('') === null);

// Scenario 1: sleep -> wake -> listen -> transcribe -> wake -> send
const c = makeClient();
c._onKimiWake();
c._kimiOnFinal('listen');
idle3(c);
check('s1: listen -> transcribing', c._kimiState === 'transcribing');
c._kimiOnFinal('remember to buy milk');
c._kimiOnFinal('and eggs');
check('s1: dictation accumulates', c._kimiDictationText === 'remember to buy milk and eggs');
c._onKimiWake();
check('s1: interrupt -> command', c._kimiState === 'command');
c._kimiOnFinal('send');
idle3(c);
const sendEvt = events.find(e => e[0] === 'kimiCommand' && e[1].action === 'send');
check('s1: send carries dictation', sendEvt && sendEvt[1].dictation === 'remember to buy milk and eggs');
check('s1: final state sleep', c._kimiState === 'sleep');

// Scenario 2: stop discards
const c2 = makeClient();
c2._onKimiWake(); c2._kimiOnFinal('listen'); idle3(c2);
c2._kimiOnFinal('draft a note');
c2._onKimiWake(); c2._kimiOnFinal('stop'); idle3(c2);
check('s2: stop -> sleep', c2._kimiState === 'sleep');
check('s2: dictation discarded', c2._kimiDictationText === '');

// Scenario 3: wake -> non-command -> silent sleep (NO gateway, NO message event)
const c3 = makeClient();
events.length = 0;
c3._onKimiWake(); c3._kimiOnFinal('what is the weather'); idle3(c3);
check('s3: non-command -> sleep', c3._kimiState === 'sleep');
check('s3: no kimiCommand emitted', events.filter(e => e[0] === 'kimiCommand').length === 0);

// Scenario 4: double wake ignored while in command
const c4 = makeClient();
c4._onKimiWake();
c4._onKimiWake();  // ignored
c4._kimiOnFinal('listen');
idle3(c4);
check('s4: double-wake ignored, transcribing', c4._kimiState === 'transcribing');

// Scenario 5: false wake during transcription -> captured text not a command
// -> RESUME transcribing (don't respond, don't lose dictation)
const c5 = makeClient();
events.length = 0;
c5._onKimiWake(); c5._kimiOnFinal('listen'); idle3(c5);
check('s5: pre: transcribing', c5._kimiState === 'transcribing');
c5._kimiOnFinal('draft a report');           // dictation so far
c5._onKimiWake();                             // FALSE wake fires mid-dictation
check('s5: false wake -> command', c5._kimiState === 'command');
c5._kimiOnFinal('about the sales numbers');   // captured as "command"
idle3(c5);                                     // classify -> no match, interrupted
check('s5: no-match mid-transcribe -> back to transcribing', c5._kimiState === 'transcribing');
check('s5: dictation not lost', c5._kimiDictationText === 'draft a report about the sales numbers');
check('s5: no command other than initial listen emitted', events.filter(e => e[0] === 'kimiCommand' && e[1].action !== 'listen').length === 0);

// Scenario 8: false wake captures dictation containing a stop-prefixed word
// (word boundary protects it — "stopwatch" is not "stop")
const c8 = makeClient();
events.length = 0;
c8._onKimiWake(); c8._kimiOnFinal('listen'); idle3(c8);
c8._kimiOnFinal('set a stopwatch timer for ten minutes');
c8._onKimiWake();                             // false wake
c8._kimiOnFinal('set a stopwatch timer');     // captured as "command"
idle3(c8);
check('s8: stopwatch dictation resumes', c8._kimiState === 'transcribing');
check('s8: dictation preserved', c8._kimiDictationText === 'set a stopwatch timer for ten minutes set a stopwatch timer');

// Scenario 6: real "send" interrupt still works mid-transcription
const c6 = makeClient();
events.length = 0;
c6._onKimiWake(); c6._kimiOnFinal('listen'); idle3(c6);
c6._kimiOnFinal('note down the meeting at noon');
c6._onKimiWake();                             // real interrupt
c6._kimiOnFinal('send');
idle3(c6);
const sendEvt6 = events.find(e => e[0] === 'kimiCommand' && e[1].action === 'send');
check('s6: send interrupt works', !!sendEvt6);
check('s6: send carries dictation', sendEvt6 && sendEvt6[1].dictation === 'note down the meeting at noon');
check('s6: final sleep', c6._kimiState === 'sleep');

// Scenario 9: real "stop" interrupt mid-transcription discards dictation
const c9 = makeClient();
events.length = 0;
c9._onKimiWake(); c9._kimiOnFinal('listen'); idle3(c9);
c9._kimiOnFinal('do not actually save this');
c9._onKimiWake(); c9._kimiOnFinal('stop'); idle3(c9);
check('s9: stop interrupt -> sleep', c9._kimiState === 'sleep');
check('s9: dictation discarded', c9._kimiDictationText === '');

// Scenario 7: re-entrancy — extra idle beats during classify don't re-fire
const c7 = makeClient();
events.length = 0;
c7._onKimiWake(); c7._kimiOnFinal('listen');
// fire classify once, then simulate more idle beats arriving during it
const p1 = c7._kimiClassifyCommand();
c7._kimiHandleTelemetry({ state: 'idle/silence' });
c7._kimiHandleTelemetry({ state: 'idle/silence' });
c7._kimiHandleTelemetry({ state: 'idle/silence' });
const p2 = Promise.all([p1, c7._kimiClassifyCommand()]);
Promise.resolve().then(() => p2).then(() => {
  const listenCount = events.filter(e => e[0] === 'kimiCommand' && e[1].action === 'listen').length;
  check('s7: re-entrancy — classify fired exactly once', listenCount === 1);
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});


