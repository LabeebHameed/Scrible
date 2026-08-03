/**
 * Chat-export parsers (build plan §9.1). One isolated, individually-updatable parser
 * per assistant format; every parser returns only the USER side of conversations —
 * assistant text is never used. Output feeds deriveProfile and is then discarded.
 */

export type ImportSource = 'claude' | 'chatgpt' | 'gemini' | 'generic';

export interface ParsedImport {
  userMessages: string[];
  conversationCount: number;
}

export function parseImport(source: ImportSource, raw: string): ParsedImport {
  switch (source) {
    case 'claude':
      return parseClaude(raw);
    case 'chatgpt':
      return parseChatGPT(raw);
    case 'gemini':
      return parseGemini(raw);
    case 'generic':
      return parseGeneric(raw);
  }
}

/** Claude data export: conversations.json — [{ name, chat_messages: [{ sender, text }] }] */
function parseClaude(raw: string): ParsedImport {
  const data = JSON.parse(raw) as unknown;
  const conversations = Array.isArray(data)
    ? data
    : ((data as Record<string, unknown>).conversations as unknown[] | undefined) ?? [];
  const userMessages: string[] = [];
  for (const conv of conversations as Array<Record<string, unknown>>) {
    const msgs = (conv.chat_messages ?? conv.messages ?? []) as Array<Record<string, unknown>>;
    for (const m of msgs) {
      if (m.sender === 'human' || m.role === 'human' || m.role === 'user') {
        const text =
          typeof m.text === 'string'
            ? m.text
            : Array.isArray(m.content)
              ? (m.content as Array<Record<string, unknown>>)
                  .filter((c) => c.type === 'text')
                  .map((c) => String(c.text ?? ''))
                  .join('\n')
              : '';
        if (text.trim()) userMessages.push(text.trim());
      }
    }
  }
  return { userMessages, conversationCount: conversations.length };
}

/** ChatGPT export: conversations.json — [{ mapping: { id: { message } } }] */
function parseChatGPT(raw: string): ParsedImport {
  const data = JSON.parse(raw) as Array<Record<string, unknown>>;
  const userMessages: string[] = [];
  for (const conv of data) {
    const mapping = (conv.mapping ?? {}) as Record<string, Record<string, unknown>>;
    for (const node of Object.values(mapping)) {
      const message = node.message as Record<string, unknown> | null | undefined;
      if (!message) continue;
      const author = message.author as Record<string, unknown> | undefined;
      if (author?.role !== 'user') continue;
      const content = message.content as Record<string, unknown> | undefined;
      const parts = (content?.parts ?? []) as unknown[];
      const text = parts.filter((p) => typeof p === 'string').join('\n').trim();
      if (text) userMessages.push(text);
    }
  }
  return { userMessages, conversationCount: data.length };
}

/** Gemini (Takeout) or Gemini-like: {conversations:[{messages:[{role,text}]}]} or MyActivity list. */
function parseGemini(raw: string): ParsedImport {
  const data = JSON.parse(raw) as unknown;
  const userMessages: string[] = [];
  let conversationCount = 0;
  if (Array.isArray(data)) {
    // Takeout MyActivity.json: [{ title: "Prompted <text>", ... }]
    for (const entry of data as Array<Record<string, unknown>>) {
      const title = String(entry.title ?? '');
      if (title.startsWith('Prompted ')) {
        userMessages.push(title.slice('Prompted '.length).trim());
        conversationCount++;
      }
    }
  } else {
    const conversations = ((data as Record<string, unknown>).conversations ?? []) as Array<
      Record<string, unknown>
    >;
    conversationCount = conversations.length;
    for (const conv of conversations) {
      for (const m of (conv.messages ?? []) as Array<Record<string, unknown>>) {
        if (m.role === 'user' && typeof m.text === 'string' && m.text.trim()) {
          userMessages.push(m.text.trim());
        }
      }
    }
  }
  return { userMessages, conversationCount };
}

/** Generic fallback: {messages:[{role, content|text}]} JSON, or plain text (one message per line). */
function parseGeneric(raw: string): ParsedImport {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const msgs = (Array.isArray(data) ? data : (data.messages as unknown[]) ?? []) as Array<
      Record<string, unknown>
    >;
    const userMessages = msgs
      .filter((m) => m.role === 'user' || m.sender === 'user' || (!m.role && !m.sender))
      .map((m) => String(m.content ?? m.text ?? '').trim())
      .filter(Boolean);
    if (userMessages.length > 0) return { userMessages, conversationCount: 1 };
  } catch {
    /* not JSON — treat as plain text */
  }
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 3);
  return { userMessages: lines, conversationCount: 1 };
}
