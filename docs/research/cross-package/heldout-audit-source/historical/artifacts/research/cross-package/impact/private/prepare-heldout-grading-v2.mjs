import { resolve,join } from 'node:path'
import { prepareV2 } from '../grading-v2/prepare.mjs'
const base=resolve('artifacts/research/cross-package/impact')
for(const [name,receipt,out] of [['heldout','vue-workspaces.json','heldout-grading-v2'],['heldout-runtime-v1','private/runtime-qualification/workspaces.json','heldout-runtime-grading-v2']]) {
 const previous=join(base,'private',name)
 prepareV2({previousDescriptor:join(previous,'descriptor.json'),previousTruth:join(previous,'truth.json'),previousGold:join(previous,'gold-answer.json'),workspaceReceipt:join(base,receipt),out:join(base,'private',out)})
}
console.log(JSON.stringify({privateCasesPrepared:2,sourceFixturesUnchanged:true}))
