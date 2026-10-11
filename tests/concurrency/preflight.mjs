/* global console, process */
const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);

if (!supported) {
  console.error(`test:concurrency requires Node 22.18+ or 23.6+ to run TypeScript directly; current Node is ${process.versions.node}.`);
  process.exit(1);
}
