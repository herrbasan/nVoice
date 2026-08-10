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
        if (this._kimiIdleCount >= this._kimiIdleToClassify) this._kimiClassifyCommand();
      }
    },
    _kimiOnFinal(text) {
      if (this._kimiState === 'command') { this._kimiCommandText = (this._kimiCommandText + ' ' + text).trim(); this._kimiCommandFinal = true; this._kimiIdleCount = 0; }
      else if (this._kimiState === 'transcribing') { this._kimiDictationText = (this._kimiDictationText + ' ' + text).trim(); this._kimiIdleCount = 0; }
    },
    _onKimiWake() {
      if (this._kimiState === 'command') return;
      this._kimiState = 'command'; this._kimiCommandText = ''; this._kimiCommandFinal = false; this._kimiIdleCount = 0;
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

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
