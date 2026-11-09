// Deliberately small fixture provider: never connects to a model or remote host.
const mode = process.argv[2];
if (mode === 'exit') process.exit(17);
if (['stall', 'hold'].includes(mode)) {
  process.stdout.write(JSON.stringify({ providerPid: process.pid }) + '\n');
  await new Promise(() => setInterval(() => {}, 1000));
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(mode === 'malformed' ? 'not a structured handoff' : input);
