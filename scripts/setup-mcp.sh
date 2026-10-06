#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
prompt() {
  printf '%s' "$2"
  IFS= read -r "$1" || { printf '\nSetup cancelled.\n'; exit 1; }
}
require() { command -v "$1" >/dev/null 2>&1 || fail "$1 is not on PATH. Install it first, then run setup again."; }

package_version=''
if [[ "${1:-}" == '--package-version' ]]; then
  [[ $# -ge 2 ]] || fail 'Missing package version.'
  package_version=$2
  [[ "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || fail 'Invalid package version.'
  shift 2
fi

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  printf 'Usage: typelatch setup\n       npm run setup:mcp (source checkout)\n\nInteractively register Typelatch with Codex or Claude Code.\nNo global installation or repository clone is needed with npx typelatch@latest setup.\n'
  exit 0
fi
[[ $# -eq 0 ]] || fail 'Unknown argument. Use --help for usage.'

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
require node
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' \
  || fail 'Node.js 22.12 or newer is required.'

printf '\nTypelatch MCP setup\n\n1) Codex\n2) Claude Code\n'
while :; do
  prompt choice 'Client [1]: '
  case "${choice:-1}" in
    1) client=codex; break ;;
    2) client=claude; break ;;
    *) printf 'Choose 1 or 2.\n' ;;
  esac
done
require "$client"

if [[ -n "$package_version" ]]; then
  mode=package
  version=$package_version
  require npx
  launcher=("$(command -v npx)" --yes "--package=typelatch@$version" typelatch-mcp)
else
printf '\n1) This checkout (build current source)\n2) Installed typelatch-mcp\n3) npm package (no global installation)\n'
while :; do
  prompt choice 'Launch method [1]: '
  case "${choice:-1}" in
    1) mode=checkout; require npm; launcher=("$(command -v node)" "$root/dist/mcp.js"); break ;;
    2) mode=installed; require typelatch-mcp; launcher=("$(command -v typelatch-mcp)"); break ;;
    3)
      mode=npm
      require npx
      require npm
      printf 'Checking the published Typelatch version...\n'
      version=$(npm view typelatch version) || fail 'Could not read the published version from npm.'
      prompt answer "Exact Typelatch version [$version]: "
      version=${answer:-$version}
      [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] \
        || fail 'Enter an exact version such as 0.2.0.'
      launcher=("$(command -v npx)" --yes "--package=typelatch@$version" typelatch-mcp)
      break ;;
    *) printf 'Choose 1, 2 or 3.\n' ;;
  esac
done
fi

prompt name 'Server name [typelatch]: '
name=${name:-typelatch}
[[ "$name" =~ ^[A-Za-z0-9_-]+$ && "$name" != -* ]] \
  || fail 'Use letters, numbers, underscores or hyphens for the server name; do not start with a hyphen.'

if [[ "$client" == codex ]]; then
  registration=(codex mcp add "$name" -- "${launcher[@]}")
  printf '\nCodex registration applies to your user configuration. An existing entry with this name can be replaced.\n'
else
  registration=(claude mcp add --transport stdio --scope user "$name" -- "${launcher[@]}")
  printf '\nClaude Code registration applies to your user configuration. If the name already exists, choose a different name or remove it in Claude Code first.\n'
fi

if [[ "$mode" == checkout ]]; then
  printf 'Setup will build this checkout. If dependencies are missing, it will run npm ci first. Keep the checkout at this path.\n'
elif [[ "$mode" == npm || "$mode" == package ]]; then
  printf 'The first server start may download typelatch@%s and install its native dependency.\n' "$version"
fi
printf '\nCommand:'
printf ' %q' "${registration[@]}"
printf '\n\n'
prompt answer 'Register this MCP server? [y/N]: '
case "$answer" in
  y|Y|yes|YES) ;;
  *) printf 'Setup cancelled.\n'; exit 0 ;;
esac

if [[ "$mode" == npm ]]; then
  npm view "typelatch@$version" version >/dev/null \
    || fail "typelatch@$version is not available from npm. MCP registration was not changed."
fi

if [[ "$mode" == checkout ]]; then
  if [[ ! -d "$root/node_modules" ]]; then
    printf '\nInstalling checkout dependencies...\n'
    (cd -- "$root" && npm ci) || fail 'Dependency installation failed. MCP registration was not changed.'
  fi
  printf '\nBuilding Typelatch...\n'
  (cd -- "$root" && npm run build) || fail 'Build failed. MCP registration was not changed.'
  [[ -f "$root/dist/mcp.js" ]] || fail 'Build did not produce dist/mcp.js.'
fi

"${registration[@]}" || fail 'MCP registration failed. Check the client error above.'
printf '\nRegistered %s with %s. Restart the client or start a new session to load its tools.\n' "$name" "$client"
printf 'Registration alone does not verify that the server can start.\n'
printf '\nIn your project, ask your agent: Use workspace_search to explain how this project is organized.\n'
printf 'To prepare dependency indexes, run: npx typelatch@%s sync\n' "${version:-latest}"
