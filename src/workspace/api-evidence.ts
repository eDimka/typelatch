import type ts from "typescript"
import { sha256, type WorkspaceProject } from "./project.js"

const declarationLimit = 10
const headerLimit = 8000

export function counts(total: number, returned: number) {
  return { total, returned, omitted: total - returned }
}

type Header = {
  file: string
  start: number
  length: number
  sha256: string
  sourceKind: "source" | "declaration"
  header: string | null
  status: "complete" | "truncated" | "unsupported"
  elisions: string[]
  characters: ReturnType<typeof counts> | null
  reason?: string
}

function supportsDeclarationHeaders(T: typeof ts): boolean {
  const version = /^(\d+)\.(\d+)$/.exec(T.versionMajorMinor ?? "")
  // TypeScript 4.8 merged decorators into modifiers and changed factory arguments.
  // Older compiler resolution still works; only this syntax projection abstains.
  if (!version || Number(version[1]) < 4 || (Number(version[1]) === 4 && Number(version[2]) < 8)) return false
  const compilerFunctions = ["canHaveModifiers", "getModifiers", "isClassStaticBlockDeclaration", "createPrinter", "transform", "visitNode", "visitEachChild"] as const
  const factoryFunctions = ["createIdentifier", "createBlock", "createExpressionStatement", "createModuleBlock",
    "updateVariableDeclaration", "updateClassDeclaration", "updateModuleDeclaration", "updateClassExpression",
    "updateArrowFunction", "updateFunctionExpression", "updateFunctionDeclaration", "updateMethodDeclaration",
    "updateGetAccessorDeclaration", "updateSetAccessorDeclaration", "updateConstructorDeclaration", "updateClassStaticBlockDeclaration"] as const
  return compilerFunctions.every(name => typeof T[name] === "function") &&
    !!T.factory && factoryFunctions.every(name => typeof T.factory[name] === "function")
}

/** Normalized syntax only. All compiler formatting stays in separate fields. */
function declarationHeader(project: WorkspaceProject, declaration: ts.Declaration): Header {
  const T = project.ts
  const F = T.factory
  const source = declaration.getSourceFile()
  const start = declaration.getStart(source)
  const provenance = {
    file: source.fileName, start, length: declaration.getWidth(source), sha256: sha256(source.text),
    sourceKind: source.isDeclarationFile ? "declaration" as const : "source" as const
  }
  const unsupported = (reason: string): Header => ({ ...provenance, header: null, status: "unsupported", elisions: [], characters: null, reason })
  if (!supportsDeclarationHeaders(T)) return unsupported("Installed compiler lacks the modern modifier and declaration factory APIs required for normalized headers")
  if (project.program().getSyntacticDiagnostics(source).some(d => d.start !== undefined &&
      d.start <= declaration.end && d.start + (d.length ?? 0) >= start)) {
    return unsupported("Selected declaration intersects a compiler syntax diagnostic")
  }
  if ((T.canHaveModifiers(declaration) && T.getModifiers(declaration)?.some(m =>
      m.kind === T.SyntaxKind.PrivateKeyword || m.kind === T.SyntaxKind.ProtectedKeyword)) ||
      ("name" in declaration && declaration.name && T.isPrivateIdentifier(declaration.name as ts.Node))) {
    return unsupported("Private or protected member headers are not supported")
  }
  const elisions: string[] = []
  const elide = (kind: string) => { if (!elisions.includes(kind)) elisions.push(kind) }
  let node: ts.Node = declaration
  let prefix = ""
  let container = false
  let outerFunction: ts.Node | undefined
  if (T.isVariableDeclaration(declaration)) {
    const list = declaration.parent
    if (!T.isVariableDeclarationList(list)) return unsupported("Unsupported variable binding context")
    // AwaitUsing includes the Const bit, so resource bindings take precedence.
    prefix = (list.flags & T.NodeFlags.AwaitUsing) === T.NodeFlags.AwaitUsing ? "await using "
      : list.flags & T.NodeFlags.Using ? "using "
      : list.flags & T.NodeFlags.Const ? "const " : list.flags & T.NodeFlags.Let ? "let " : "var "
    let initializer = declaration.initializer
    while (initializer && T.isParenthesizedExpression(initializer)) initializer = initializer.expression
    if (!declaration.type && initializer && (T.isArrowFunction(initializer) || T.isFunctionExpression(initializer))) {
      outerFunction = initializer
      elide("function-body")
      node = F.updateVariableDeclaration(declaration, declaration.name, declaration.exclamationToken, declaration.type, initializer)
    } else {
      if (declaration.initializer) elide("initializer")
      node = F.updateVariableDeclaration(declaration, declaration.name, declaration.exclamationToken, declaration.type, undefined)
    }
  } else if (T.isFunctionDeclaration(declaration)) {
    outerFunction = declaration
    if (declaration.body) elide("function-body")
  } else if (T.isClassDeclaration(declaration)) {
    elide("class-members")
    container = true
    node = F.updateClassDeclaration(declaration, declaration.modifiers, declaration.name, declaration.typeParameters, declaration.heritageClauses, [])
  } else if (T.isModuleDeclaration(declaration)) {
    elide("namespace-members")
    container = true
    node = F.updateModuleDeclaration(declaration, declaration.modifiers, declaration.name, F.createModuleBlock([]))
  } else if (!T.isInterfaceDeclaration(declaration) && !T.isTypeAliasDeclaration(declaration)) {
    return unsupported("Selected declaration form has no supported normalized header")
  }

  const marker = () => F.createIdentifier("…")
  const emptyBody = () => F.createBlock([F.createExpressionStatement(marker())], false)
  const transformed = T.transform(node, [context => root => {
    const visit: ts.Visitor = original => {
      let current = original
      const label = original === outerFunction ? "function-body" : "nested-function-body"
      if (T.isClassExpression(original)) {
        elide("class-members")
        current = F.updateClassExpression(original, original.modifiers, original.name, original.typeParameters, original.heritageClauses, [])
      } else if (T.isArrowFunction(original)) {
        elide(label)
        current = F.updateArrowFunction(original, original.modifiers, original.typeParameters, original.parameters, original.type, original.equalsGreaterThanToken, marker())
      } else if (T.isFunctionExpression(original)) {
        elide(label)
        current = F.updateFunctionExpression(original, original.modifiers, original.asteriskToken, original.name, original.typeParameters, original.parameters, original.type, emptyBody())
      } else if (T.isFunctionDeclaration(original) && original.body) {
        elide(label)
        current = F.updateFunctionDeclaration(original, original.modifiers, original.asteriskToken, original.name, original.typeParameters, original.parameters, original.type, undefined)
      } else if (T.isMethodDeclaration(original) && original.body) {
        elide(label)
        current = F.updateMethodDeclaration(original, original.modifiers, original.asteriskToken, original.name, original.questionToken, original.typeParameters, original.parameters, original.type, emptyBody())
      } else if (T.isGetAccessorDeclaration(original) && original.body) {
        elide(label)
        current = F.updateGetAccessorDeclaration(original, original.modifiers, original.name, original.parameters, original.type, emptyBody())
      } else if (T.isSetAccessorDeclaration(original) && original.body) {
        elide(label)
        current = F.updateSetAccessorDeclaration(original, original.modifiers, original.name, original.parameters, emptyBody())
      } else if (T.isConstructorDeclaration(original) && original.body) {
        elide(label)
        current = F.updateConstructorDeclaration(original, original.modifiers, original.parameters, emptyBody())
      } else if (T.isClassStaticBlockDeclaration(original)) {
        elide("nested-static-block")
        current = F.updateClassStaticBlockDeclaration(original, emptyBody())
      }
      return T.visitEachChild(current, visit, context)
    }
    return T.visitNode(root, visit) as ts.Node
  }])
  try {
    const printer = T.createPrinter({ removeComments: true, newLine: T.NewLineKind.LineFeed })
    let full = prefix + printer.printNode(T.EmitHint.Unspecified, transformed.transformed[0]!, source).trim()
    // These containers were replaced by empty blocks before printing.
    if (container) full = full.replace(/\{\s*\}$/, "{ … }")
    const header = full.slice(0, headerLimit)
    return { ...provenance, header, status: full.length > header.length ? "truncated" : "complete", elisions, characters: counts(full.length, header.length) }
  } finally { transformed.dispose() }
}

export function installedApiEvidence(project: WorkspaceProject, symbol: ts.Symbol, strings: {
  type: string
  documentation: string
  signatures: string[]
  signatureCount: number
  signatureView: "value" | "declared-type"
}) {
  const checker = project.program().getTypeChecker()
  const T = project.ts
  const declarations = symbol.declarations ?? []
  const tags = symbol.getJsDocTags(checker)
  const items = tags.slice(0, 10).map(tag => {
    const text = T.displayPartsToString(tag.text)
    return {
      name: tag.name.slice(0, 256), text: text.slice(0, 4000),
      nameCharacters: counts(tag.name.length, Math.min(tag.name.length, 256)),
      textCharacters: counts(text.length, Math.min(text.length, 4000))
    }
  })
  return {
    characterUnit: "utf16-code-units" as const,
    type: { origin: "compiler" as const, ...counts(strings.type.length, Math.min(strings.type.length, 16000)) },
    documentation: { origin: "compiler-documentation" as const, ...counts(strings.documentation.length, Math.min(strings.documentation.length, 12000)) },
    signatures: { origin: "compiler" as const, view: strings.signatureView, ...counts(strings.signatureCount, strings.signatures.length),
      characters: strings.signatures.map(text => counts(text.length, Math.min(text.length, 8000))) },
    tags: { origin: "compiler-jsdoc-tags" as const, ...counts(tags.length, items.length), items },
    declarations: { origin: "declared-syntax" as const, ...counts(declarations.length, Math.min(declarations.length, declarationLimit)),
      headers: declarations.slice(0, declarationLimit).map(d => declarationHeader(project, d)) }
  }
}
