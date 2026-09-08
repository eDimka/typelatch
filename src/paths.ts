import { assertPackageName, assertExactVersion } from "./identity.js"
import { homedir } from "node:os"
import { join } from "node:path"

export const brainHome = (): string =>
  process.env.TYPELATCH_HOME ?? join(homedir(), ".typelatch")

export const installedPackageDirectory = (name: string): string => {
  assertPackageName(name)
  return join(brainHome(), "brains", encodeURIComponent(name))
}
export const packageDirectory = (name: string, version: string): string => {
  assertExactVersion(version)
  return join(installedPackageDirectory(name), version)
}

export const brainPath = (name: string, version: string): string =>
  join(packageDirectory(name, version), "brain.db")

export const usagePath = (): string => join(brainHome(), "usage.db")
