import assert from 'node:assert/strict'

export function scriptPropertyEvidence(ts,text,script) {
  const source=ts.parseJsonText('package.json',text)
  assert.equal(source.parseDiagnostics.length,0,'Manifest JSON must parse')
  const root=source.statements[0]?.expression
  assert(root&&ts.isObjectLiteralExpression(root),'Manifest must be an object')
  const scripts=root.properties.filter(property=>ts.isPropertyAssignment(property)&&property.name.text==='scripts')
  assert.equal(scripts.length,1,'Exactly one scripts object required')
  assert(ts.isObjectLiteralExpression(scripts[0].initializer),'scripts must be an object')
  const matches=scripts[0].initializer.properties.filter(property=>ts.isPropertyAssignment(property)&&property.name.text===script)
  assert.equal(matches.length,1,'Exactly one script property required')
  const property=matches[0]
  assert(ts.isStringLiteral(property.initializer),'Script command must be a string')
  const start=property.getStart(source),end=property.getEnd()
  return {start,end,line:source.getLineAndCharacterOfPosition(start).line+1,endLine:source.getLineAndCharacterOfPosition(end-1).line+1,command:property.initializer.text,quote:text.slice(start,end),jsonPointer:`/scripts/${script.replaceAll('~','~0').replaceAll('/','~1')}`}
}
