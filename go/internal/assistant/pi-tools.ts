// Pi loads this private adapter with all other extensions and tools disabled.
// Tool execution stays behind the Go service's live permission checks.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(readFileSync(fileURLToPath(new URL('./tools.json', import.meta.url)), 'utf8'));
export default function (pi: any) {
  for (const tool of config.tools) {
    pi.registerTool({
      name: tool.name, label: tool.name.replaceAll('_', ' '),
      description: tool.description, parameters: tool.inputSchema,
      async execute(id: string, arguments_: unknown, signal: AbortSignal) {
        return await new Promise((resolve, reject) => {
          const body = JSON.stringify({jsonrpc:'2.0', id, method:'tools/call', params:{name:tool.name, arguments:arguments_}});
          const req = http.request({socketPath:config.socket, path:'/mcp', method:'POST', signal,
            headers:{Authorization:'Bearer '+config.capability, 'Content-Type':'application/json'}}, res => {
            const chunks: Buffer[] = []; let size = 0;
            res.on('data', chunk => {size += chunk.length; if (size > 16*1024*1024) req.destroy(new Error('Tool result exceeds limit')); else chunks.push(chunk)});
            res.on('error', reject);
            res.on('end', () => {
              try {
                if (res.statusCode !== 200) throw new Error('Relay tool bridge unavailable');
                const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (response.error) throw new Error(response.error.message);
                if (response.result.isError) throw new Error(response.result.content.map((b:any)=>b.text||'').join('\n'));
                resolve({content:response.result.content, details:{}});
              } catch (error) {reject(error)}
            });
          });
          req.setTimeout(40000, () => req.destroy(new Error('Relay tool request timed out')));
          req.on('error', reject); req.end(body);
        });
      }
    });
  }
}
