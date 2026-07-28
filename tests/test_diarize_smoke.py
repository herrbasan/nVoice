import torch, soundfile, time, os
from pyannote.audio import Pipeline

hf_token = os.environ.get('HF_TOKEN')
if not hf_token:
    raise RuntimeError('HF_TOKEN environment variable not set')

p = Pipeline.from_pretrained(
    'pyannote/speaker-diarization-3.1',
    token=hf_token
)
p.to(torch.device('cuda'))

# Load audio ourselves (soundfile), hand pyannote a waveform dict
audio, sr = soundfile.read('d:/DEV/nVoice/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/de.wav')
if audio.ndim == 2:
    audio = audio.mean(axis=1)  # mono
waveform = torch.from_numpy(audio).float().unsqueeze(0)  # (1, samples)
file_dict = {'waveform': waveform, 'sample_rate': sr}

t0 = time.time()
out = p(file_dict, num_speakers=1)
elapsed = time.time() - t0

# pyannote 4.x: out.speaker_diarization is the Annotation object
annotation = out.speaker_diarization
turns = [(round(t.start, 2), round(t.end, 2), s) for t, _, s in annotation.itertracks(yield_label=True)]
print(f'Elapsed: {elapsed:.2f}s | Turns: {len(turns)}')
for start, end, spk in turns:
    print(f'  [{start:.2f}-{end:.2f}] {spk}')
print('SUCCESS')
