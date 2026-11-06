#!/usr/bin/env node
import {createService} from '../impact-prototype/service.mjs'
const [packageName,names,outputFile,...extra]=process.argv.slice(2)
if(!packageName||!names||!outputFile||extra.length)throw Error('Use PACKAGE EXPORT1,EXPORT2 NEW_REPORT.json from the workspace root')
const invoke=await createService(),response=await invoke({package:packageName,exports:names.split(','),outputFile,maxBytes:8000})
console.log(response.content[0].text)
