import assert from 'node:assert/strict';
import ansiStyles from 'ansi-styles';
const warning = ansiStyles.yellow.open + 'warning' + ansiStyles.yellow.close;
assert.equal(warning, '\u001b[33mwarning\u001b[39m');
const brandColor = ansiStyles.hexToRgb('#FF8800');
assert.deepEqual(brandColor, [255, 136, 0]);
