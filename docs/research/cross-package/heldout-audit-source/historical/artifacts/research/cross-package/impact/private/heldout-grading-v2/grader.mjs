import { readFileSync } from 'node:fs'
import { gradeFixture } from "../../grading-v2/grade-answer.mjs"
const truth=JSON.parse(readFileSync(new URL('./truth.json',import.meta.url)))
export function gradeWorkspace(workspace,initial) { return gradeFixture(workspace,initial,truth,'impact-answer.json') }
