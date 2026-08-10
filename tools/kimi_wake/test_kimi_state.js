// Unit test for the kimi state machine (extracted logic)
const events = [];
const log = [];
function makeClient() {
  const c = {
    kimiWakeEnabled: true, wakeWordEnabled: true, isAwake: false,
    _kimiState: 'sleep', _kimiCommandText: '', _kimiCommandFinal: false,
    _kimiDictationText: '', _kimiIdleCount: 0, _kimiIdleToClassify: 3,
    classifyResults: {},
    emit(evt, data) { events.push([evt, data]); },
    sleep() { this.isAwake = false; this.emit('asleep', {}); log.push('sleep()'); },
    wake() { this.isAwake = true; this.emit('wakeWordDetected', {}); log.push('wake()'); },
    async _kimiClassifyCommand() {
      const text = this._kimiCommandText.trim();
      if (!text) { this._kimiToSleep('empty'); return; }
      const action = this.classifyResults[text] || 'message';
      log.push('classify(' + text + ')->' + action);
      if (action === 'listen') { this._kimiState = 'transcribing'; this._kimiIdleCount = 0; this.emit('kimiState', { state: 'transcribing' }); this.emit('kimiCommand', { action: 'listen', text }); }
      else if (action === 'stop') { this._kimiState = 'sleep'; this._kimiDictationText = ''; this.emit('kimiCommand', { action: 'stop', text }); this.sleep(); }
      else if (action === 'send') { this._kimiState = 'sleep'; this.emit('kimiCommand', { action: 'send', text, dictation: this._kimiDictationText }); this.sleep(); }
      else { this._kimiState = 'sleep'; this.emit('kimiCommand', { action: 'message', text }); this.sleep(); }
    },
    _kimiHandleTelemetry(data) {
      if (!this.kimiWakeEnabled || !this.isAwake) return;
      if (this._kimiState === 'command' && this._kimiCommandFinal && data.state === 'idle/silence') {
        this._kimiIdleCount = (this._kimiIdleCount || 0) + 1;
        if (this._kimiIdleCount >= this._kimiIdleToClassify && !this._kimiClassifying) this._kimiClassifyCommand();
      }
    },
    async _kimiClassifyCommand() {
      if (this._kimiState !== 'command' || this._kimiClassifying) return;
      this._kimiClassifying = true;
      try {
        const text = this._kimiCommandText.trim();
        if (!text) { this._kimiToSleep('empty'); return; }
        const action = this.classifyResults[text] || 'message';
        log.push('classify(' + text + ')->' + action);
        if (this._kimiInterruptedTranscribing && action === 'message') {
          if (text) { this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim(); }
          this._kimiState = 'transcribing'; this._kimiIdleCount = 0; this._kimiInterruptedTranscribing = false;
          this.emit('kimiState', { state: 'transcribing' });
          return;
        }
        if (action === 'listen') { this._kimiState = 'transcribing'; this._kimiIdleCount = 0; this._kimiInterruptedTranscribing = false; this.emit('kimiState', { state: 'transcribing' }); this.emit('kimiCommand', { action: 'listen', text }); }
        else if (action === 'stop') { this._kimiState = 'sleep'; this._kimiDictationText = ''; this._kimiInterruptedTranscribing = false; this.emit('kimiCommand', { action: 'stop', text }); this.sleep(); }
        else if (action === 'send') { this._kimiState = 'sleep'; this._kimiInterruptedTranscribing = false; this.emit('kimiCommand', { action: 'send', text, dictation: this._kimiDictationText }); this.sleep(); }
        else { this._kimiState = 'sleep'; this._kimiInterruptedTranscribing = false; this.emit('kimiCommand', { action: 'message', text }); this.sleep(); }
      } finally { this._kimiClassifying = false; }
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

// Scenario 1: sleep -> wake -> listen -> transcribe -> wake -> send
const c = makeClient();
c.classifyResults = { 'listen': 'listen', 'send': 'send', 'stop': 'stop' };
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
c2.classifyResults = { 'listen': 'listen', 'stop': 'stop' };
c2._onKimiWake(); c2._kimiOnFinal('listen'); idle3(c2);
c2._kimiOnFinal('draft a note');
c2._onKimiWake(); c2._kimiOnFinal('stop'); idle3(c2);
check('s2: stop -> sleep', c2._kimiState === 'sleep');
check('s2: dictation discarded', c2._kimiDictationText === '');

// Scenario 3: wake -> message (non-transcription command)
const c3 = makeClient();
c3.classifyResults = { 'what is the weather': 'message' };
c3._onKimiWake(); c3._kimiOnFinal('what is the weather'); idle3(c3);
check('s3: message -> sleep', c3._kimiState === 'sleep');
const msgEvt = events.find(e => e[0] === 'kimiCommand' && e[1].action === 'message');
check('s3: message event emitted', !!msgEvt);

// Scenario 4: double wake ignored while in command
const c4 = makeClient();
c4.classifyResults = { 'listen': 'listen' };
c4._onKimiWake();
c4._onKimiWake();  // ignored
c4._kimiOnFinal('listen');
idle3(c4);
check('s4: double-wake ignored, transcribing', c4._kimiState === 'transcribing');

// Scenario 5: false wake during transcription -> dictation classified as
// 'message' -> RESUME transcribing (don't respond, don't lose dictation)
const c5 = makeClient();
events.length = 0;
c5.classifyResults = { 'listen': 'listen', 'draft a report about the sales numbers': 'message' };
c5._onKimiWake(); c5._kimiOnFinal('listen'); idle3(c5);
check('s5: pre: transcribing', c5._kimiState === 'transcribing');
c5._kimiOnFinal('draft a report');           // dictation so far
c5._onKimiWake();                             // FALSE wake fires mid-dictation
check('s5: false wake -> command', c5._kimiState === 'command');
c5._kimiOnFinal('about the sales numbers');   // captured as "command"
idle3(c5);                                     // classify -> message, interrupted
check('s5: message mid-transcribe -> back to transcribing', c5._kimiState === 'transcribing');
check('s5: dictation not lost', c5._kimiDictationText === 'draft a report about the sales numbers');
check('s5: no message command emitted', !events.find(e => e[0] === 'kimiCommand' && e[1].action === 'message'));

// Scenario 6: real "send" interrupt still works mid-transcription
const c6 = makeClient();
events.length = 0;
c6.classifyResults = { 'listen': 'listen', 'send': 'send' };
c6._onKimiWake(); c6._kimiOnFinal('listen'); idle3(c6);
c6._kimiOnFinal('note down the meeting at noon');
c6._onKimiWake();                             // real interrupt
c6._kimiOnFinal('send');
idle3(c6);
const sendEvt6 = events.find(e => e[0] === 'kimiCommand' && e[1].action === 'send');
check('s6: send interrupt works', !!sendEvt6);
check('s6: send carries dictation', sendEvt6 && sendEvt6[1].dictation === 'note down the meeting at noon');
check('s6: final sleep', c6._kimiState === 'sleep');

// Scenario 7: re-entrancy — extra idle beats during async classify don't re-fire
const c7 = makeClient();
events.length = 0;
c7.classifyResults = { 'listen': 'listen' };
c7._onKimiWake(); c7._kimiOnFinal('listen');
// fire classify once, then simulate more idle beats arriving during the await
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


