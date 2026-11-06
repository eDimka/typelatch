#!/usr/bin/env node
import { createService, settings } from './service.mjs'
const args=process.argv.slice(2),input={}
while(args.length){const key=args.shift();if(!['--question','--file'].includes(key)||!args.length)throw Error('Usage: --question TEXT [--file PATH]');input[key.slice(2)]=args.shift()}
const invoke=await createService(await settings()),{response}=await invoke(input)
process.stdout.write(response.structuredContent.text+'\n')
