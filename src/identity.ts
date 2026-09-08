export function assertPackageName(name: string): void {
  if (name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid npm package name: ${name}`)
}
export function assertExactVersion(version: string): void {
  if (version.length > 128 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) throw new Error(`Expected an exact package version, received: ${version}`)
}
export function assertRegistrySpec(spec: string): void {
  const separator = spec.lastIndexOf("@")
  const name = separator > 0 ? spec.slice(0, separator) : spec
  const version = separator > 0 ? spec.slice(separator + 1) : "latest"
  assertPackageName(name)
  if (!version || version.length > 128 || !/^[a-zA-Z0-9*^~][a-zA-Z0-9._*^~+-]*$/.test(version)) throw new Error("Expected a registry package name with an optional version or tag")
}
