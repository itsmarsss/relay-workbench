import { sideAnswerText } from '../public/side-answer.js';
// Claude public text and tool events only; private reasoning is never rendered.
export function sideStream(onProgress = () => {}) {
  const messages = new Map(),
    tools = new Map();
  let current = 'initial',
    final;
  function blocks(id = current) {
    if (!messages.has(id)) messages.set(id, new Map());
    return messages.get(id);
  }
  function tool(block) {
    if (!block.id) return;
    const previous = tools.get(block.id);
    if (!previous && tools.size >= 100) return;
    tools.set(block.id, {
      id: block.id,
      name: block.name,
      status: 'running',
      startedAt: new Date().toISOString(),
      ...previous,
      ...(block.input && Object.keys(block.input).length ? { input: block.input } : {}),
    });
  }
  function publish() {
    const answer = [...messages.values()]
      .flatMap((parts) =>
        [...parts.values()].filter((b) => b.type === 'text').map((b) => b.text ?? ''),
      )
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 128000);
    onProgress({
      answer: sideAnswerText(answer),
      toolCalls: [...tools.values()].map((t) => ({ ...t })),
    });
  }
  return {
    consume(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      let changed = false;
      if (event.type === 'stream_event') {
        const delta = event.event;
        if (delta?.type === 'message_start') {
          current = delta.message.id;
          blocks();
        } else if (delta?.type === 'content_block_start') {
          const block = delta.content_block;
          if (['text', 'tool_use'].includes(block?.type)) {
            blocks().set(delta.index, { ...block });
            if (block.type === 'tool_use') tool(block);
            changed = true;
          }
        } else if (delta?.type === 'content_block_delta') {
          const block = blocks().get(delta.index);
          if (block?.type === 'text' && delta.delta?.type === 'text_delta') {
            block.text = ((block.text ?? '') + delta.delta.text).slice(0, 128000);
            changed = true;
          } else if (block?.type === 'tool_use' && delta.delta?.type === 'input_json_delta')
            block.partial = ((block.partial ?? '') + delta.delta.partial_json).slice(0, 16000);
        } else if (delta?.type === 'content_block_stop') {
          const block = blocks().get(delta.index);
          if (block?.type === 'tool_use') {
            try {
              block.input = JSON.parse(block.partial);
            } catch {}
            tool(block);
            changed = true;
          }
        }
      } else if (event.type === 'assistant') {
        const parts = blocks(event.message?.id ?? current);
        for (const [index, block] of (event.message?.content ?? []).entries()) {
          if (!['text', 'tool_use'].includes(block.type)) continue;
          parts.set(index, block);
          if (block.type === 'tool_use') tool(block);
          changed = true;
        }
      } else if (event.type === 'user') {
        for (const block of event.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          const call = tools.get(block.tool_use_id);
          if (!call) continue;
          Object.assign(call, {
            status: block.is_error ? 'failed' : 'complete',
            finishedAt: new Date().toISOString(),
            output: (typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? '')
            ).slice(0, 4000),
          });
          changed = true;
        }
      } else if (event.type === 'result') final = event;
      if (changed) publish();
    },
    result() {
      return final;
    },
  };
}
