const { parseCommand } = require('./commands.js');
const assert = require('assert');
const cases = [
  ['split', 'split'], ['Split at 5 seconds', 'split'], ['பிரி', 'split'], ['ஸ்பிளிட்', 'split'],
  ['remove audio', 'removeAudio'], ['mute', 'removeAudio'], ['ஆடியோ நீக்கு', 'removeAudio'], ['சத்தம் நீக்கு', 'removeAudio'],
  ['include audio', 'includeAudio'], ['add music', 'includeAudio'], ['ஆடியோ சேர்', 'includeAudio'], ['இசை சேர்', 'includeAudio'],
  ['crop square', 'crop'], ['crop to vertical', 'crop'], ['கிராப் சதுரம்', 'crop'],
  ['zoom in', 'zoom'], ['zoom out', 'zoom'], ['பெரிதாக்கு', 'zoom'], ['சிறிதாக்கு', 'zoom'], ['ஜூம் அவுட்', 'zoom'],
  ['import video', 'import'], ['வீடியோ சேர்', 'import'], ['இம்போர்ட்', 'import'],
  ['add fade transition', 'transition'], ['டிரான்சிஷன் ஸ்லைடு', 'transition'],
  ['add zoom animation', 'animation'], ['அனிமேஷன் பல்ஸ்', 'animation'],
  ['make it a reel', 'format'], ['youtube layout', 'format'], ['ஸ்டோரி', 'format'],
  ['play', 'play'], ['நிறுத்து', 'pause'], ['undo', 'undo'], ['delete clip', 'deleteClip'], ['அழி', 'deleteClip'], ['export', 'export'],
];
for (const [text, action] of cases) assert.strictEqual((parseCommand(text) || {}).action, action, text);
assert.strictEqual(parseCommand('zoom out').dir, -1);
assert.strictEqual(parseCommand('zoom in').dir, 1);
assert.strictEqual(parseCommand('split at 5 seconds').at, 5);
assert.strictEqual(parseCommand('add zoom transition').action, 'transition');
assert.strictEqual(parseCommand('add zoom transition').name, 'zoom');
assert.deepStrictEqual(parseCommand('trim 2 to 5'), { action: 'trim', from: 2, to: 5 });
assert.strictEqual(parseCommand('trim last 3 seconds').cutEnd, 3);
assert.strictEqual(parseCommand('trim first 2 seconds').cutStart, 2);
assert.strictEqual(parseCommand('caption Happy Birthday').text, 'Happy Birthday');
assert.strictEqual(parseCommand('கேப்ஷன் வணக்கம்').text, 'வணக்கம்');
assert.strictEqual(parseCommand('make the clip blurry'), null);
for (const p of ['auto captions', 'add captions', 'generate subtitles', 'subtitles', 'ஆட்டோ கேப்ஷன்']) assert.strictEqual(parseCommand(p).action, 'autoCaption', p);
assert.strictEqual(parseCommand('add caption hello world').text, 'hello world');
const T = (s) => parseCommand(s);
assert.strictEqual(T('split clip 2').target, 2);
assert.strictEqual(T('mute the last clip').target, 'last');
assert.strictEqual(T('zoom in on the second clip').target, 2);
assert.strictEqual(T('delete the first video').target, 1);
assert.strictEqual(T('crop square clip two').target, 2);
assert.strictEqual(T('கிளிப் 2 ஐ பிரி').target, 2);
assert.strictEqual(T('கடைசி கிளிப் ஆடியோ நீக்கு').target, 'last');
assert.deepStrictEqual(T('go to 5 seconds'), { action: 'seek', to: 5 });
assert.deepStrictEqual(T('go to clip 3'), { action: 'seek', target: 3 });
assert.strictEqual(T('go to the start').to, 0);
assert.strictEqual(T('split').target, undefined);
assert.strictEqual(T('trim last 3 seconds').target, undefined);
assert.strictEqual(T('trim last 3 seconds').cutEnd, 3);
assert.strictEqual(T('split at 3 seconds').target, undefined);
assert.strictEqual(T('crop video 16 by 9').target, undefined);
assert.strictEqual(T('import video').target, undefined);
assert.deepStrictEqual(T('volume 50 percent'), { action: 'volume', level: 0.5 });
assert.deepStrictEqual(T('set the volume to 150'), { action: 'volume', level: 1.5 });
assert.deepStrictEqual(T('make it louder'), { action: 'volume', dir: 1 });
assert.deepStrictEqual(T('lower the volume'), { action: 'volume', dir: -1 });
assert.deepStrictEqual(T('ஒலி குறை'), { action: 'volume', dir: -1 });
assert.deepStrictEqual(T('ஒலி கூட்டு'), { action: 'volume', dir: 1 });
assert.deepStrictEqual(T('speed 2x'), { action: 'speed', rate: 2 });
assert.deepStrictEqual(T('speed 0.5'), { action: 'speed', rate: 0.5 });
assert.deepStrictEqual(T('slow motion'), { action: 'speed', dir: -1 });
assert.deepStrictEqual(T('make it faster'), { action: 'speed', dir: 1 });
assert.deepStrictEqual(T('normal speed'), { action: 'speed', rate: 1 });
assert.deepStrictEqual(T('வேகம் 2'), { action: 'speed', rate: 2 });
assert.deepStrictEqual(T('மெதுவாக'), { action: 'speed', dir: -1 });
assert.strictEqual(T('speed up the last clip').target, 'last');
assert.strictEqual(T('zoom out').action, 'zoom');
assert.strictEqual(T('சிறிதாக்கு').action, 'zoom');
console.log('all', cases.length, 'parser cases pass');
