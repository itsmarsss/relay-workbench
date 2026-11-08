import { createInterface } from 'node:readline';
import { workspaceTools } from './workspace-agent.js';
import { githubReadTool, readGithub } from './side-provider.js';
const [origin, capability] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize')
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'relay-workspace', version: '1.0.0' },
      };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list')
      result = { tools: [...workspaceTools, githubReadTool] };
    else if (message.method === 'tools/call') {
      try {
        const { name, arguments: args = {} } = message.params;
        let value;
        if (name === 'github_read') value = await readGithub(args);
        else {
          const response = await fetch(`${origin}/api/workspace-agent/tool`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Relay-Workspace': capability },
            body: JSON.stringify({ name, args }),
            signal: AbortSignal.timeout(30000),
          });
          value = await response.json();
          if (!response.ok) throw Error(value.error);
        }
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    } else throw Error('Unsupported workspace protocol method');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch (error) {
    if (message?.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: error.message },
        }) + '\n',
      );
  }
}
