// Voice command parser for English + Tamil (script and common transliterations).
// Returns { action, ...args } or null. Works in browser (window.parseCommand) and Node.
(function (root) {
  const has = (t, re) => re.test(t);

  const FORMATS = [
    ['shorts', /shorts|ஷார்ட்ஸ்|ஷாட்ஸ்/],
    ['story', /stor(y|ies)|ஸ்டோரி|ஸ்டோரீஸ்/],
    ['reel', /reels?|ரீல்ஸ்|ரீல்/],
    ['youtube', /you ?tube|யூடியூப்|யூ டியூப்/],
    ['square', /square (post|format|layout)|instagram post/],
  ];

  const ANIMS = [
    ['none', /\bnone\b|\boff\b|\bremove\b|நீக்கு|இல்லை/],
    ['fade', /fade|மங்கல்|பேட்|ஃபேட்/],
    ['slide', /slide|சறுக்கு|ஸ்லைடு/],
    ['zoom', /zoom|push|ஜூம்|சூம்|பெரிதா/],
    ['pulse', /pulse|bounce|beat|துடிப்பு|பவுன்ஸ்/],
    ['wipe', /wipe|வைப்/],
  ];

  function pick(list, t) {
    for (const [name, re] of list) if (re.test(t)) return name;
    return null;
  }

  function parseInner(raw) {
    if (!raw) return null;
    const t = raw.toLowerCase().replace(/(?<!\d)[.,!?]|[.,!?](?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    const all = /\ball\b|everything|every clip|எல்லா|அனைத்து/.test(t);

    // Jump: "go to 5 seconds", "go to clip 2"
    if (/\b(go to|jump to|skip to|seek to|move to)\b|(?:^|\s)(போ|செல்)(?:\s|$)/.test(t)) {
      const m = t.match(/(\d+(?:\.\d+)?)\s*(?:sec|second|seconds|வினாடி|விநாடி)/);
      if (m) return { action: 'seek', to: parseFloat(m[1]) };
      if (/start|beginning|தொடக்க/.test(t)) return { action: 'seek', to: 0 };
      if (findTarget(t) != null) return { action: 'seek' };
    }

    // Auto captions from speech
    if (/^(?:(?:auto|generate|create|add|make)\s+)*(?:captions?|subtitles?)$/.test(t) || /(auto|generate).*(captions?|subtitles?)|ஆட்டோ கேப்ஷன்|சப்டைட்டில்|சப்டைடில்/.test(t))
      return { action: 'autoCaption' };

    // Caption: "caption Happy birthday" / "add text ..." / "கேப்ஷன் ..."
    const cap = raw.trim().match(/^(?:add )?(?:caption|text|title|கேப்ஷன்|டெக்ஸ்ட்|தலைப்பு)(?=[\s:\-])\s*[:\-]?\s*(.+)$/i);
    if (cap) return { action: 'caption', text: cap[1].trim() };
    if (/(remove|clear|delete|நீக்கு).*(caption|text|கேப்ஷன்|டெக்ஸ்ட்)/.test(t)) return { action: 'caption', text: '' };

    // Trim by seconds: "trim 2 to 5", "trim first 3 seconds", "trim last 2 seconds"
    if (/\btrim\b|ட்ரிம்|டிரிம்/.test(t)) {
      const nums = (t.match(/\d+(?:\.\d+)?/g) || []).map(parseFloat);
      if (nums.length >= 2) return { action: 'trim', from: nums[0], to: nums[1] };
      if (nums.length === 1) {
        if (/end|last|கடைசி|முடிவு/.test(t)) return { action: 'trim', cutEnd: nums[0] };
        return { action: 'trim', cutStart: nums[0] };
      }
    }

    // Volume: "volume 50 percent", "louder", "ஒலி குறை"
    const volNum = t.match(/(?:volume|sound level|ஒலி அளவு)\D{0,15}?(\d+)/);
    if (volNum) return { action: 'volume', level: Math.min(200, +volNum[1]) / 100 };
    if (/louder|volume up|(increase|raise|boost|turn up).*(volume|sound)|(ஒலி|சத்தம்|வால்யூம்)\s*(கூட்டு|அதிகரி)|சத்தமாக/.test(t)) return { action: 'volume', dir: 1 };
    if (/quieter|softer|volume down|(lower|reduce|decrease|turn down).*(volume|sound)|(ஒலி|சத்தம்|வால்யூம்)\s*(குறை|குறைக்க)/.test(t)) return { action: 'volume', dir: -1 };

    // Speed: "speed 2x", "slow motion", "faster", "normal speed"
    if (/speed|slow|fast|வேகம்|மெதுவ|வேகமாக/.test(t)) {
      if (/normal|reset|original|சாதாரண/.test(t)) return { action: 'speed', rate: 1 };
      const sn = t.match(/(\d+(?:\.\d+)?)\s*(?:x|times|மடங்கு)?/);
      if (sn && /speed|வேகம்/.test(t) && +sn[1] > 0) return { action: 'speed', rate: +sn[1] };
      if (/slow|மெதுவ/.test(t)) return { action: 'speed', dir: -1 };
      return { action: 'speed', dir: 1 };
    }

    // Layout / format
    if (/(format|layout|switch|change|set|make|use|for|to|ஃபார்மேட்|லேஅவுட்)/.test(t) || FORMATS.some(([, re]) => re.test(t))) {
      const f = pick(FORMATS, t);
      if (f && !/transition|animation|அனிமேஷன்|டிரான்சிஷன்/.test(t)) return { action: 'format', format: f };
    }

    // Audio: remove / include
    if (/(remove|delete|cut|strip|take off|turn off|drop).*(audio|sound|voice)|\bmute\b|(ஆடியோ|ஒலி|சத்தம்|சவுண்ட்|குரல்).*(நீக்கு|நீக்க|எடு|அகற்று|மியூட்|ஆஃப்)|மியூட்/.test(t) && !/unmute/.test(t))
      return { action: 'removeAudio', all };
    if (/unmute|(include|add|put|insert|bring back|restore|attach).*(audio|sound|music|song|track|voice)|(ஆடியோ|ஒலி|இசை|பாடல்|மியூசிக்|சவுண்ட்|சத்தம்).*(சேர்|போடு|இணை|வை)|அன்மியூட்/.test(t))
      return { action: 'includeAudio', fresh: /music|song|track|file|new|இசை|பாடல்|மியூசிக்|புதிய/.test(t) && !/original|back|unmute|restore|அன்மியூட்/.test(t), all };

    // Playback / history / export
    if (/\bundo\b|அன்டூ|திரும்ப/.test(t)) return { action: 'undo' };
    if (/\b(export|download|render|save)\b|ஏற்றுமதி|எக்ஸ்போர்ட்|டவுன்லோட்|சேமி/.test(t)) return { action: 'export' };
    if (/\b(pause|stop)\b|நிறுத்து|பாஸ்|ஸ்டாப்/.test(t)) return { action: 'pause' };
    if (/\b(play|start|resume)\b|ஓடு|பிளே|தொடங்கு|ஆரம்பி/.test(t)) return { action: 'play' };
    if (/(go to|jump to|back to).*(start|beginning)|rewind|தொடக்கத்து/.test(t)) return { action: 'seek', to: 0 };

    // Zoom (check "out" first)
    if (/zoom out|zoom less|smaller|shrink|ஜூம் அவுட்|சூம் அவுட்|சிறிதாக்கு|சிறிதாக|குறை/.test(t)) return { action: 'zoom', dir: -1 };
    if (/zoom|closer|bigger|enlarge|magnify|ஜூம்|சூம்|பெரிதாக்கு|பெரிதாக/.test(t) && !/transition|animation|அனிமேஷன்|டிரான்சிஷன்|மாற்றம்/.test(t))
      return { action: 'zoom', dir: 1 };

    // Transitions / animations
    if (/transition|டிரான்சிஷன்|ட்ரான்சிஷன்|மாற்றம்/.test(t)) return { action: 'transition', name: pick(ANIMS, t) || 'fade' };
    if (/animat|effect|அனிமேஷன்|எஃபெக்ட்/.test(t)) return { action: 'animation', name: pick(ANIMS, t) || 'fade' };

    // Crop
    if (/\bcrop\b|trim to|கிராப்|க்ராப்|செதுக்கு/.test(t)) {
      if (/reset|remove|clear|undo|none|நீக்கு|ரீசெட்/.test(t)) return { action: 'crop', shape: 'reset' };
      if (/square|1:1|1 by 1|சதுர/.test(t)) return { action: 'crop', shape: 'square' };
      if (/vertical|portrait|9:16|9 by 16|நெடு/.test(t)) return { action: 'crop', shape: 'vertical' };
      if (/wide|landscape|16:9|16 by 9|அகல/.test(t)) return { action: 'crop', shape: 'wide' };
      if (/left|இடது/.test(t)) return { action: 'crop', shape: 'left' };
      if (/right|வலது/.test(t)) return { action: 'crop', shape: 'right' };
      return { action: 'crop', shape: 'square' };
    }

    // Split
    if (/\b(split|cut|divide|break|slice)\b|பிரி|வெட்டு|ஸ்பிளிட்|துண்டு/.test(t)) {
      const m = t.match(/(\d+(?:\.\d+)?)\s*(?:sec|second|seconds|வினாடி|விநாடி)/);
      return { action: 'split', at: m ? parseFloat(m[1]) : null };
    }

    // Import
    if (/import|upload|open file|add (a |the )?(video|clip|photo|image|picture|file)|இறக்குமதி|இம்போர்ட்|அப்லோட்|(வீடியோ|புகைப்படம்|படம்|கோப்பு).*(சேர்|போடு)/.test(t))
      return { action: 'import' };

    // Delete clip
    if (/\b(delete|remove|erase)\b|அழி|நீக்கு/.test(t)) return { action: 'deleteClip' };

    return null;
  }

  // Which clip the user named: "clip 2", "second clip", "last video", "கிளிப் 2", "கடைசி கிளிப்". 1-based number or 'last'.
  const CLIP = '(?:clip|video|கிளிப்|க்ளிப்|வீடியோ)';
  const ORD = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, sixth: 6, '6th': 6, last: 'last', final: 'last' };
  const TA_ORD = { 'முதல்': 1, 'முதலாவது': 1, 'இரண்டாவது': 2, 'மூன்றாவது': 3, 'நான்காவது': 4, 'ஐந்தாவது': 5, 'கடைசி': 'last' };
  const NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  function findTarget(t) {
    let m = t.match(new RegExp('\\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|last|final)\\s+' + CLIP));
    if (m) return ORD[m[1]];
    m = t.match(new RegExp(CLIP + '\\s*(?:number|no|#)?\\s*(\\d{1,2}|one|two|three|four|five|six)(?![\\d:.]|\\s*(?:by|x)\\b)'));
    if (m) return NUMW[m[1]] || parseInt(m[1], 10);
    m = t.match(new RegExp('(முதல்|முதலாவது|இரண்டாவது|மூன்றாவது|நான்காவது|ஐந்தாவது|கடைசி)\\s*' + CLIP));
    if (m) return TA_ORD[m[1]];
    return null;
  }
  const TARGETABLE = new Set(['split', 'removeAudio', 'includeAudio', 'crop', 'zoom', 'transition', 'animation', 'deleteClip', 'trim', 'autoCaption', 'seek', 'volume', 'speed']);

  function parseCommand(raw) {
    const cmd = parseInner(raw);
    if (cmd && TARGETABLE.has(cmd.action)) {
      const t = raw.toLowerCase().replace(/(?<!\d)[.,!?]|[.,!?](?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
      const target = findTarget(t);
      if (target != null) cmd.target = target;
    }
    return cmd;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { parseCommand };
  else root.parseCommand = parseCommand;
})(typeof window !== 'undefined' ? window : globalThis);
