import { createInterface } from 'node:readline';
import { createInspector, inspectionTools } from './side-inspection.js';
const inspect = createInspector(JSON.parse(process.argv[2]));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize')
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'relay-source-inspection', version: '1.0.0' },
      };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools: inspectionTools };
    else if (message.method === 'tools/call') {
      try {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await inspect(message.params.name, message.params.arguments)),
            },
          ],
        };
      } catch (error) {
        result = { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    } else throw Error('Unsupported read-only protocol method');
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
