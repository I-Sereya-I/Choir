// Pocket keeps the complete, attributed voice transcript on its mounted cards.
// Read that data without clicking the player or changing Pocket's state.
export function pocketVoiceNotes(document, activityId, scope) {
  let snapshotFound = false;
  for (const host of document.querySelectorAll('[data-pocket-sequence]')) {
    let group;
    try { group = JSON.parse(host.dataset.pocketSequence); } catch { continue; }
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      const activity = entry?.[0];
      if (activity?.id !== activityId) continue;
      snapshotFound = true;
      if (activity.scope?.chatId !== scope.chatId ||
          scope.characterId && activity.scope?.characterId !== scope.characterId ||
          scope.messageId && activity.source?.messageId && activity.source.messageId !== scope.messageId) continue;
      const presentation = activity.presentation;
      if (presentation?.batchMessages?.length) return presentation.batchMessages
        .filter(row => row.format === 'voice')
        .map(row => ({ speaker: row.senderName, text: row.text }));
      return presentation?.format === 'voice'
        ? [{ speaker: presentation.senderName, text: presentation.voiceTranscript }]
        : [];
    }
  }
  if (snapshotFound) return null;
  // Older Pocket cards expose the same transcript inside their open shadow root.
  const host = [...document.querySelectorAll('[data-pocket-inline-anchor]')]
    .find(node => node.dataset.pocketInlineAnchor === activityId && node.dataset.pocketMounted === 'true' && !node.hidden);
  if (!host) return null;
  const roots = [host], notes = [];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    for (const player of root.querySelectorAll('.lp-voice-message')) {
      const button = player.querySelector('.lp-voice-play');
      if (button?.disabled || button?.hidden) continue;
      notes.push({ speaker: button?.dataset.voiceSender, text: player.querySelector('.lp-voice-transcript > p')?.textContent });
    }
  }
  return notes;
}

export function pocketVoiceReading(value, resolve, clean) {
  const content = String(value || ''), slots = [], seen = new Set();
  let prefix = 'CHOIRPOCKETVOICE';
  while (content.includes(prefix)) prefix += 'X';
  const marked = content.replace(/(<div\b(?:"[^"]*"|'[^']*'|[^'">])*>)[ \t\r\n]*<\/div\s*>/gi, (block, opening) => {
    const attributes = Object.create(null);
    for (const match of opening.slice(4, -1).matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    const id = attributes['data-pocket-inline-anchor'];
    if (!(attributes.class || '').split(/\s+/).includes('pocket-inline-anchor') || !/^act_[a-z0-9]+$/i.test(id || '')) return block;
    const token = `${prefix}${slots.length}END`, notes = resolve(id);
    if (Array.isArray(notes) && !notes.length) return block;
    slots.push({ token, id, notes });
    return `${opening}${token}</div>`;
  });
  const cleaned = clean(marked), parts = [], unresolved = [], activeNotes = [];
  let cursor = 0;
  for (const slot of slots) {
    const start = cleaned.indexOf(slot.token, cursor);
    if (start < 0) continue; // The user's normal speech filters also exclude these notes.
    const prose = cleaned.slice(cursor, start).trim();
    if (prose) parts.push({ text: prose });
    if (seen.has(slot.id)) { cursor = start + slot.token.length; continue; }
    seen.add(slot.id);
    if (!Array.isArray(slot.notes) || slot.notes.some(note => typeof note.speaker !== 'string' || !note.speaker.trim() || typeof note.text !== 'string' || !note.text.trim())) {
      unresolved.push(slot.id);
    } else for (const note of slot.notes) {
      const part = { activityId: slot.id, speaker: note.speaker.trim(), text: note.text };
      parts.push(part);activeNotes.push(part);
    }
    cursor = start + slot.token.length;
  }
  const tail = cleaned.slice(cursor).trim();
  if (tail) parts.push({ text: tail });
  return { parts, transcript: parts.map(part => part.text).join('\n\n'), notes: activeNotes,
    unresolved, signature: activeNotes.length ? JSON.stringify(activeNotes) : '' };
}
