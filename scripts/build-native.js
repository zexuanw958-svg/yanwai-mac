'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'native', '.module-cache');
fs.mkdirSync(cache, { recursive: true });
for (const name of ['notch-metrics', 'watch-chat', 'fill-text']) {
  const inputs = name === 'notch-metrics' ? [`native/${name}.swift`] : ['-parse-as-library', 'native/chat-support.swift', `native/${name}.swift`];
  execFileSync('xcrun', ['swiftc', ...inputs, '-O', '-target', 'arm64-apple-macos13.0', '-module-cache-path', cache, '-o', `native/${name}`], { cwd: root, stdio: 'inherit' });
}
