// Compares the SYNC-marked shared regions across the MAR1 Pine files and
// asserts the tail below each region only READS the machine's variables.
//
// Markers, inside a .pine file:
//   // SYNC:BEGIN <name>
//   ...shared lines...
//   // SYNC:END <name>
//
// Two assertions per block name:
//   1. the region between the markers is identical (per-line, after trimming
//      leading and trailing whitespace) in every registered file that carries
//      it - the inline copy in maRejection.pine can join later at a different
//      indent and still compare equal;
//   2. in each file, the TAIL - everything from the END marker to the end of
//      the enclosing top-level block (the next non-empty line at column 0) -
//      contains no write (:=, +=, -=, array.set) to any name the region
//      itself mutates. A tail that only reads cannot change the shared
//      machine's semantics; a write there is exactly the divergence this
//      checker exists to catch.
//
// Usage: node checks/block-sync.js
// Exit code 0 with BLOCK-SYNC: OK, 1 with the failures listed.
'use strict';
const fs = require('fs');
const path = require('path');

const files = ['maSweepPairs.pine', 'mar1Rotation.pine'];
const root = path.join(__dirname, '..');

let failures = 0;
const blocks = {}; // name -> [{file, body, tail, beginLine}]

for (const f of files) {
  const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\/\/ SYNC:BEGIN (\S+)/);
    if (!m) continue;
    const name = m[1];
    let j = i + 1;
    while (j < lines.length && !lines[j].includes('// SYNC:END ' + name)) j++;
    if (j >= lines.length) {
      console.error('FAIL ' + f + ': SYNC:BEGIN ' + name + ' at line ' + (i + 1) + ' has no END');
      failures++;
      break;
    }
    let k = j + 1;
    const tail = [];
    while (k < lines.length && !(lines[k].length > 0 && !/^\s/.test(lines[k]))) {
      tail.push(lines[k]);
      k++;
    }
    (blocks[name] = blocks[name] || []).push({
      file: f,
      body: lines.slice(i + 1, j).map((s) => s.trim()),
      tail,
      beginLine: i + 1,
    });
    i = j;
  }
}

for (const name of Object.keys(blocks)) {
  const entries = blocks[name];
  const ref = entries[0];
  for (const e of entries.slice(1)) {
    if (ref.body.length !== e.body.length) {
      console.error('FAIL ' + name + ': ' + ref.file + ' region has ' + ref.body.length +
        ' lines, ' + e.file + ' has ' + e.body.length);
      failures++;
    } else {
      for (let i = 0; i < ref.body.length; i++) {
        if (ref.body[i] !== e.body[i]) {
          console.error('FAIL ' + name + ': region line ' + (i + 1) + ' differs');
          console.error('  ' + ref.file + ': ' + ref.body[i]);
          console.error('  ' + e.file + ': ' + e.body[i]);
          failures++;
          break;
        }
      }
    }
  }
  for (const e of entries) {
    const mutated = new Set();
    for (const line of e.body) {
      const w = line.match(/^(?:var\s+\S+\s+)?(\w+)\s*(?::=|\+=|-=)/);
      if (w) mutated.add(w[1]);
      for (const am of line.matchAll(/array\.set\((\w+)/g)) mutated.add(am[1]);
    }
    for (const raw of e.tail) {
      const t = raw.trim();
      if (t.startsWith('//')) continue;
      const w = t.match(/^(\w+)\s*(?::=|\+=|-=)/);
      if (w && mutated.has(w[1])) {
        console.error('FAIL ' + name + ' in ' + e.file + ": tail writes '" + w[1] + "': " + t);
        failures++;
      }
      for (const am of t.matchAll(/array\.set\((\w+)/g)) {
        if (mutated.has(am[1])) {
          console.error('FAIL ' + name + ' in ' + e.file + ": tail writes array '" + am[1] + "': " + t);
          failures++;
        }
      }
    }
    console.log(name + ' @ ' + e.file + ': region ' + e.body.length + ' lines (from line ' +
      e.beginLine + '), tail ' + e.tail.length + ' lines, ' + mutated.size + ' guarded names');
  }
}

if (Object.keys(blocks).length === 0) {
  console.error('FAIL: no SYNC blocks found in any registered file');
  failures++;
}
console.log(failures ? 'BLOCK-SYNC: ' + failures + ' FAILURE(S)' : 'BLOCK-SYNC: OK');
process.exit(failures ? 1 : 0);
