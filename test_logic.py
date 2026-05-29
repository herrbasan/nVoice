class DummyWord:
    def __init__(self, s, e, w):
        self.start = s; self.end = e; self.word = w

def get_new_words(already_emitted, safe_words):
    # just return safe_words that are past the len(already_emitted)
    return safe_words[len(already_emitted):]

emitted = []
all_words = [DummyWord(0, 1, 'Hello'), DummyWord(1, 2, 'world'), DummyWord(2, 3, 'how'), DummyWord(3, 4, 'are'), DummyWord(4, 5, 'you')]

safe = all_words[:-3]
new_w = get_new_words(emitted, safe)
print('new1:', [w.word for w in new_w])
emitted.extend(new_w)

# simulate next tick where whisper changed 'world' to 'Worlds' but we already emitted it.
# We will just accept the desync, or we can send the new ones.
all_words = [DummyWord(0, 1, 'Hello'), DummyWord(1, 2, 'Worlds'), DummyWord(2, 3, 'how'), DummyWord(3, 4, 'are'), DummyWord(4, 5, 'you'), DummyWord(5, 6, 'doing')]
safe = all_words[:-3]
new_w = get_new_words(emitted, safe)
print('new2:', [w.word for w in new_w])
emitted.extend(new_w)

