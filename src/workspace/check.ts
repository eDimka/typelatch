import { dirname, resolve } from "node:path"
import { WorkspaceProject, type Overlay } from "./project.js"
import { runtimeSnapshot } from "./snapshot.js"

export type CheckRequest = { config: string; overlays?: Overlay[] | undefined; runtimeInputs?: string[] | undefined; snapshotExclude?: string[] | undefined; workspaceRoot?: string | undefined; captureRuntime?: boolean | undefined }
export function checkProject(request: CheckRequest) {
  const project = new WorkspaceProject(request.config, request.overlays)
  try {
    const typechecked = project.typecheck()
    return { typechecked, snapshot: project.snapshot(), runtime: request.captureRuntime ? runtimeSnapshot(resolve(request.workspaceRoot ?? dirname(request.config)), request.runtimeInputs, request.snapshotExclude) : null }
  } finally { project.dispose() }
}
