#!/usr/bin/env node
import {createService} from './service.mjs'
const [packageName,names,outputFile]=process.argv.slice(2)
if(!packageName||!names)throw Error('Use PACKAGE EXPORT1,EXPORT2 [NEW_REPORT.json] from the workspace root')
const invoke=await createService(),response=await invoke({package:packageName,exports:names.split(','),...(outputFile?{outputFile}:{})})
console.log(response.content[0].text)
