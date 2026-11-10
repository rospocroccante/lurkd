// Preloaded into `lurkd mcp` by test/unit/mcp.test.ts: once the MCP server has taken stdout for
// the protocol, write to stdout the ways a library would. None of it may reach the protocol.
const original = process.stdout.write;
const timer = setInterval(() => {
  if (process.stdout.write === original) return;
  clearInterval(timer);
  console.log('NOISE-A from console.log');
  process.stdout.write('NOISE-B from process.stdout.write\n');
}, 5);
timer.unref();
