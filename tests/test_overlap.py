class DummyWord:
    def __init__(self, s, e, w):
        self.start = s; self.end = e; self.word = w

words = [
    DummyWord(0.0, 0.5, 'This'), DummyWord(0.5, 1.0, 'time'), DummyWord(1.0, 1.2, 'I\\'m'), 
    DummyWord(1.2, 1.6, 'trying'), DummyWord(1.8, 1.9, 'to'), DummyWord(1.9, 2.5, 'speak')
]

best_gap = -1
for i in range(len(words)-1):
    gap = words[i+1].start - words[i].end
    if gap > best_gap:
        best_gap = gap
        best_cut_idx = i

print(best_gap, words[best_cut_idx].word)
