import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import ts from "typescript";

export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "variable" | "interface" | "type" | "method" | "property" | "enum";
  file: string;
  line: number;
  exported: boolean;
}

export interface FileTags {
  mtime: number;
  symbols: SymbolDef[];
}

export interface RepoMapResult {
  symbols: SymbolDef[];
  fileSymbolCount: Map<string, number>;
}

const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage", "__pycache__"]);
const MAX_FILES = 800;

function isSupported(filePath: string): boolean {
  return SUPPORTED_EXTS.some((ext) => filePath.endsWith(ext));
}

function extractSymbols(filePath: string, source: string): SymbolDef[] {
  const symbols: SymbolDef[] = [];
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  function visit(node: ts.Node): void {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());

    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.getText(sf);
      if (name) {
        symbols.push({
          name,
          kind: "function",
          file: filePath,
          line: line + 1,
          exported: hasExportModifier(node),
        });
      }
    } else if (ts.isClassDeclaration(node)) {
      const name = node.name?.getText(sf);
      if (name) {
        symbols.push({
          name,
          kind: "class",
          file: filePath,
          line: line + 1,
          exported: hasExportModifier(node),
        });
      }
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      const name = node.name?.getText(sf);
      if (name && node.parent && ts.isClassDeclaration(node.parent)) {
        symbols.push({
          name: `${(node.parent as ts.ClassDeclaration).name?.getText(sf) ?? "?"}.${name}`,
          kind: "method",
          file: filePath,
          line: line + 1,
          exported: false,
        });
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.parent &&
      ts.isVariableDeclarationList(node.parent)
    ) {
      const name = node.name.getText(sf);
      const parent = node.parent.parent;
      const isModuleLevel = parent && ts.isSourceFile(parent);
      if (isModuleLevel && name) {
        let exported = false;
        if (parent && ts.isVariableStatement(parent)) {
          exported = hasExportModifier(parent);
        }
        symbols.push({ name, kind: "variable", file: filePath, line: line + 1, exported });
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      const name = node.name?.getText(sf);
      if (name) {
        symbols.push({
          name,
          kind: "interface",
          file: filePath,
          line: line + 1,
          exported: hasExportModifier(node),
        });
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.getText(sf);
      symbols.push({
        name,
        kind: "type",
        file: filePath,
        line: line + 1,
        exported: hasExportModifier(node),
      });
    } else if (ts.isEnumDeclaration(node)) {
      const name = node.name.getText(sf);
      symbols.push({
        name,
        kind: "enum",
        file: filePath,
        line: line + 1,
        exported: hasExportModifier(node),
      });
    } else if (ts.isPropertyDeclaration(node) && node.parent && ts.isClassDeclaration(node.parent)) {
      const name = node.name.getText(sf);
      if (name) {
        symbols.push({
          name: `${(node.parent as ts.ClassDeclaration).name?.getText(sf) ?? "?"}.${name}`,
          kind: "property",
          file: filePath,
          line: line + 1,
          exported: false,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return symbols;
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  return ts.getModifiers(node)?.some(
    (mod) => mod.kind === ts.SyntaxKind.ExportKeyword || mod.kind === ts.SyntaxKind.DefaultKeyword,
  ) ?? false;
}

async function scanFiles(
  dir: string,
  files: string[],
  max: number,
): Promise<void> {
  if (files.length >= max) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= max) return;
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDE_DIRS.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanFiles(full, files, max);
    } else if (entry.isFile() && isSupported(entry.name)) {
      files.push(full);
    }
  }
}

export class RepoMap {
  private cache: Map<string, FileTags> = new Map();
  private workspaceDir: string;

  constructor(workspaceDir?: string) {
    this.workspaceDir = resolve(workspaceDir ?? process.cwd());
  }

  async build(): Promise<RepoMapResult> {
    const files: string[] = [];
    await scanFiles(this.workspaceDir, files, MAX_FILES);

    const symbols: SymbolDef[] = [];
    const fileSymbolCount = new Map<string, number>();

    for (const filePath of files) {
      const relPath = relative(this.workspaceDir, filePath);

      let mtime = 0;
      try {
        const s = await stat(filePath);
        mtime = s.mtimeMs;
      } catch {
        continue;
      }

      const cached = this.cache.get(relPath);
      if (cached && cached.mtime === mtime) {
        for (const sym of cached.symbols) {
          symbols.push(sym);
        }
        fileSymbolCount.set(relPath, cached.symbols.length);
        continue;
      }

      let source: string;
      try {
        source = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      const extracted = extractSymbols(relPath, source);
      this.cache.set(relPath, { mtime, symbols: extracted });

      for (const sym of extracted) {
        symbols.push(sym);
      }
      fileSymbolCount.set(relPath, extracted.length);
    }

    return { symbols, fileSymbolCount };
  }

  getCachedSymbols(): SymbolDef[] {
    const result: SymbolDef[] = [];
    for (const [, tags] of this.cache) {
      for (const sym of tags.symbols) {
        result.push(sym);
      }
    }
    return result;
  }
}
