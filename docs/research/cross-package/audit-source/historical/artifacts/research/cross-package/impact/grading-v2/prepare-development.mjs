import { resolve,join } from 'node:path'
import { prepareV2 } from './prepare.mjs'
const base=resolve('artifacts/research/cross-package/impact')
console.log(JSON.stringify(prepareV2({previousDescriptor:join(base,'development/descriptor.json'),previousTruth:join(base,'development/truth.json'),previousGold:join(base,'development/gold-answer.json'),workspaceReceipt:join(base,'pnpm-workspaces.json'),out:join(base,'development-v2')})))
