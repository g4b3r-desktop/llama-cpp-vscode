const test=require('node:test');const assert=require('node:assert/strict');const{unifiedDiff}=require('../src/workspace/diff');
test('generates a useful unified diff',()=>{const diff=unifiedDiff('a.js','one\ntwo\nthree\n','one\nTWO\nthree\n');assert.match(diff,/--- a\/a\.js/);assert.match(diff,/-two/);assert.match(diff,/\+TWO/);});
