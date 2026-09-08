import assert from 'node:assert/strict';
import stringWidth from 'string-width';
assert.equal(stringWidth('\u001b[32m古\u001b[39m'), 2);
assert.equal(stringWidth('·', { ambiguousIsNarrow: false }), 2);
assert.equal(stringWidth('·'), 1);
