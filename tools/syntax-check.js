// Extracts every inline <script> block from an HTML file and parses it with
// the V8 parser so a stray typo cannot ship silently.
const fs = require('fs');
const vm = require('vm');

const file = process.argv[2] || 'index.html';
const html = fs.readFileSync(file, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

let m, index = 0, failed = 0;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  const code = m[2] || '';
  index++;
  if (/\bsrc\s*=/.test(attrs)) continue;
  if (/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/.test(attrs)) continue;
  if (!code.trim()) continue;
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new vm.Script(code, { filename: `${file}:script#${index}@L${line}` });
    console.log(`ok    script#${index} (line ${line}, ${code.length} chars)`);
  } catch (err) {
    failed++;
    console.error(`FAIL  script#${index} (line ${line}): ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  }
}
process.exit(failed ? 1 : 0);
