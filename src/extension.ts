import * as vscode from 'vscode';
import * as path from 'path';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Code Refinery');
  }
  return outputChannel;
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z0-9])/g, '$1-$2')
    .replace(/([0-9])([a-zA-Z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/[\s_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function splitFileName(fileName: string) {
  if (fileName.startsWith('.') && fileName.indexOf('.', 1) === -1) {
    return { baseName: fileName, ext: '' };
  }

  const ext = path.extname(fileName);
  return {
    baseName: fileName.slice(0, fileName.length - ext.length),
    ext
  };
}

function normalizeFileName(fileName: string): string {
  const { baseName, ext } = splitFileName(fileName);
  const match = baseName.match(/^(\.+)(.*)$/);
  const leadingDots = match?.[1] ?? '';
  const rawName = match?.[2] ?? baseName;
  const normalizedBaseName = toKebabCase(rawName);

  if (!normalizedBaseName) {
    return fileName;
  }

  return `${leadingDots}${normalizedBaseName}${ext.toLowerCase()}`;
}

async function getResourceType(uri: vscode.Uri): Promise<vscode.FileType | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type;
  } catch {
    return undefined;
  }
}

function getRenameConfig() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    updateImports: cfg.get<boolean>('codeRefinery.rename.updateImports', true),
    showSummary: cfg.get<boolean>('codeRefinery.rename.showSummary', true),
    revealInExplorer: cfg.get<boolean>('codeRefinery.rename.revealInExplorer', true)
  };
}

function normalizeRelativeImportPath(p: string): string {
  const posix = p.split(path.sep).join('/');
  if (posix.startsWith('.')) return posix;
  return `./${posix}`;
}

function stripKnownScriptExtension(p: string): string {
  return p.replace(/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, '');
}

function getImportCandidateSpecifiers(fromFilePath: string, targetFilePath: string): string[] {
  const rel = normalizeRelativeImportPath(path.relative(path.dirname(fromFilePath), targetFilePath));
  const relNoExt = stripKnownScriptExtension(rel);
  const out = new Set<string>([rel, relNoExt]);
  return Array.from(out);
}

function isTextLikeFile(filePath: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(filePath);
}

type TTypeLikeDecl = {
  name: string;
  exported: boolean;
  nameOffset: number;
};

function getTopLevelTypeLikeDecls(text: string): TTypeLikeDecl[] {
  const decls: Array<{ name: string; exported: boolean; nameOffset: number }> = [];
  const exportedNames = new Set<string>();

  let i = 0;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const readIdent = () => {
    if (!isIdentStart(text[i] ?? '')) return undefined;
    const start = i;
    i++;
    while (i < text.length && isIdentPart(text[i])) i++;
    return { value: text.slice(start, i), start };
  };
  const atTopLevel = () => depthParen === 0 && depthBrace === 0 && depthBracket === 0;

  const consumeStringLike = (quote: "'" | '"' | '`') => {
    // Caller has already observed starting quote at text[i].
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (quote === '`' && c === '$' && text[i + 1] === '{') {
        // Enter template expression. We treat it as normal code.
        i += 2;
        depthBrace++;
        return;
      }
      if (c === quote) {
        i++;
        return;
      }
      i++;
    }
  };

  const scanExportListAt = (startIdx: number) => {
    // startIdx points right after "export" (and optional "type").
    const oldI = i;
    i = startIdx;
    skipWs();
    if (text[i] !== '{') {
      i = oldI;
      return;
    }
    i++; // '{'
    while (i < text.length) {
      skipWs();
      if (text[i] === '}') {
        i++;
        break;
      }
      const ident = readIdent();
      if (!ident) {
        i++;
        continue;
      }
      exportedNames.add(ident.value);
      skipWs();
      if (text.slice(i, i + 2) === 'as') {
        // export { Foo as Bar } exports Bar, but the local symbol is Foo. We care about whether Foo is exported.
        // Foo is already added above; ignore Bar.
        i += 2;
        skipWs();
        readIdent();
      }
      while (i < text.length && text[i] !== ',' && text[i] !== '}') i++;
      if (text[i] === ',') i++;
    }
    i = oldI;
  };

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && n === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inSingleQuote) {
      inSingleQuote = false;
      consumeStringLike("'");
      continue;
    }
    if (inDoubleQuote) {
      inDoubleQuote = false;
      consumeStringLike('"');
      continue;
    }
    if (inTemplate) {
      inTemplate = false;
      consumeStringLike('`');
      continue;
    }

    if (c === '/' && n === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingleQuote = true;
      continue;
    }
    if (c === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      continue;
    }

    if (c === '(') depthParen++;
    else if (c === ')') depthParen = Math.max(0, depthParen - 1);
    else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (c === '[') depthBracket++;
    else if (c === ']') depthBracket = Math.max(0, depthBracket - 1);

    if (!atTopLevel()) {
      i++;
      continue;
    }

    if (!isIdentStart(c)) {
      i++;
      continue;
    }

    const word = readIdent();
    if (!word) {
      i++;
      continue;
    }

    const wordValue = word.value;

    if (wordValue === 'export') {
      const exportStart = i;
      skipWs();
      const maybeType = (() => {
        const saved = i;
        const w = readIdent();
        if (!w) return { kind: 'none' as const, idx: saved };
        return { kind: w.value, idx: i };
      })();

      if (maybeType.kind === 'type' || maybeType.kind === 'interface') {
        // export type Foo ...
        // export interface Foo ...
        skipWs();
        const nameIdent = readIdent();
        if (nameIdent) {
          decls.push({ name: nameIdent.value, exported: true, nameOffset: nameIdent.start });
          exportedNames.add(nameIdent.value);
        }
      } else {
        // export { Foo, Bar as Baz }
        // export type { Foo }
        // Handle optional "type" keyword (TypeScript export type { ... }).
        if (maybeType.kind === 'type') {
          scanExportListAt(maybeType.idx);
        } else {
          scanExportListAt(exportStart);
        }
      }

      i++;
      continue;
    }

    if (wordValue === 'declare') {
      skipWs();
      const next = readIdent();
      if (next?.value === 'type' || next?.value === 'interface') {
        skipWs();
        const nameIdent = readIdent();
        if (nameIdent) {
          decls.push({ name: nameIdent.value, exported: false, nameOffset: nameIdent.start });
        }
      }
      continue;
    }

    if (wordValue === 'type' || wordValue === 'interface') {
      skipWs();
      const nameIdent = readIdent();
      if (nameIdent) {
        decls.push({ name: nameIdent.value, exported: false, nameOffset: nameIdent.start });
      }
      continue;
    }
  }

  for (const d of decls) {
    if (!d.exported && exportedNames.has(d.name)) {
      d.exported = true;
    }
  }

  return decls;
}

async function fixPropsType(uri: vscode.Uri) {
  if (!uri) {
    vscode.window.showErrorMessage('No file selected');
    return;
  }

  const resourceType = await getResourceType(uri);
  if (resourceType !== vscode.FileType.File) {
    vscode.window.showErrorMessage('Please select a file.');
    return;
  }

  if (!/\.(ts|tsx)$/.test(uri.fsPath)) {
    vscode.window.showErrorMessage('Please select a .ts or .tsx file.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const decls = getTopLevelTypeLikeDecls(text);

  if (decls.length === 0) {
    vscode.window.showInformationMessage('No top-level type/interface declarations found.');
    return;
  }

  if (decls.some((d) => d.name === 'Props')) {
    vscode.window.showInformationMessage('Props already exists in this file.');
    return;
  }

  const nonExported = decls.filter((d) => !d.exported);
  const exported = decls.filter((d) => d.exported);

  // Rules:
  // - total == 1 and it is non-exported -> rename to Props
  // - total == 2 and exactly one is non-exported and one is exported -> rename the non-exported to Props
  let target: TTypeLikeDecl | undefined;
  if (decls.length === 1 && nonExported.length === 1) {
    target = nonExported[0];
  } else if (decls.length === 2 && nonExported.length === 1 && exported.length === 1) {
    target = nonExported[0];
  }

  if (!target) {
    vscode.window.showInformationMessage(
      'No eligible local type/interface to rename. This runs only when the file has exactly 1 local type/interface, or exactly 2 where 1 is exported and 1 is local.'
    );
    return;
  }

  if (target.name === 'Props') {
    vscode.window.showInformationMessage('Already named Props.');
    return;
  }

  const position = doc.positionAt(target.nameOffset);
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
    'vscode.executeDocumentRenameProvider',
    uri,
    position,
    'Props'
  );

  if (!edit) {
    vscode.window.showErrorMessage('Rename provider did not return edits. Is TypeScript language support enabled?');
    return;
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage('Failed to apply rename edits.');
    return;
  }

  await doc.save();
  vscode.window.showInformationMessage(`Renamed ${target.name} to Props.`);
}

async function updateImportsForRename(oldUri: vscode.Uri, newUri: vscode.Uri, token: vscode.CancellationToken) {
  await updateImportsForRenames(
    [{ oldPath: oldUri.fsPath, newPath: newUri.fsPath }],
    token
  );
}

async function updateImportsForRenames(
  renames: Array<{ oldPath: string; newPath: string }>,
  token: vscode.CancellationToken
) {
  if (renames.length === 0) return;

  const channel = getOutputChannel();
  const relevant = renames.filter((r) => isTextLikeFile(r.oldPath) || isTextLikeFile(r.newPath));
  if (relevant.length === 0) return;

  // Only attempt import updates for script-ish files; skip assets.
  const include = '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';
  const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**}';

  const files = await vscode.workspace.findFiles(include, exclude);
  const workspaceEdit = new vscode.WorkspaceEdit();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  for (const fileUri of files) {
    if (token.isCancellationRequested) return;

    const filePath = fileUri.fsPath;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(fileUri);
    } catch {
      continue;
    }
    const text = new TextDecoder().decode(bytes);

    // Per-file mapping from old specifier -> new specifier.
    const specMap = new Map<string, string>();
    for (const r of relevant) {
      const oldCandidates = getImportCandidateSpecifiers(filePath, r.oldPath);
      const newCandidates = getImportCandidateSpecifiers(filePath, r.newPath);
      for (let i = 0; i < oldCandidates.length; i++) {
        const oldSpec = oldCandidates[i];
        const newSpec = newCandidates[i];
        if (oldSpec && newSpec && oldSpec !== newSpec) {
          specMap.set(oldSpec, newSpec);
        }
      }
    }

    if (specMap.size === 0) continue;

    // Quick pre-filter: avoid opening/parsing most files.
    const needles = new Set<string>();
    for (const oldSpec of specMap.keys()) {
      needles.add(path.basename(oldSpec));
    }
    if (!Array.from(needles).some((n) => n && text.includes(n))) continue;

    // Match common module specifier sites: from 'x', require('x'), import('x')
    const pattern = /(\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;
    const matches: Array<{ start: number; end: number; replacement: string }> = [];

    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const spec = match[3];
      if (!spec.startsWith('.')) continue;

      const replacement = specMap.get(spec);
      if (!replacement) continue;

      const full = match[0];
      const prefixLen = match[1].length + 1; // includes opening quote
      const specStart = match.index + prefixLen;
      const specEnd = specStart + spec.length;

      if (full.slice(prefixLen, prefixLen + spec.length) !== spec) continue;
      if (replacement === spec) continue;

      matches.push({ start: specStart, end: specEnd, replacement });
    }

    if (matches.length === 0) continue;

    const doc = await vscode.workspace.openTextDocument(fileUri);
    for (const m of matches) {
      const range = new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end));
      workspaceEdit.replace(fileUri, range, m.replacement);
    }
    channel.appendLine(`[imports] ${path.relative(root, filePath)}: ${matches.length} update(s)`);
  }

  if (workspaceEdit.size > 0) {
    await vscode.workspace.applyEdit(workspaceEdit);
  }
}

async function renameOneFileToKebab(uri: vscode.Uri, config: ReturnType<typeof getRenameConfig>, token: vscode.CancellationToken) {
  const resourceType = await getResourceType(uri);
  if (resourceType !== vscode.FileType.File) {
    return { kind: 'skipped' as const, reason: 'not a file' };
  }

  const oldPath = uri.fsPath;
  const oldName = path.basename(oldPath);
  const dir = path.dirname(oldPath);
  const kebabName = normalizeFileName(oldName);

  if (kebabName === oldName) {
    return { kind: 'skipped' as const, reason: 'already kebab-case' };
  }

  const newPath = path.join(dir, kebabName);
  const newUri = vscode.Uri.file(newPath);

  try {
    await vscode.workspace.fs.stat(newUri);
    return { kind: 'skipped' as const, reason: 'target exists', target: kebabName };
  } catch {
    // ok
  }

  await vscode.workspace.fs.rename(uri, newUri);

  if (config.revealInExplorer) {
    await vscode.commands.executeCommand('revealInExplorer', newUri);
  }

  return { kind: 'renamed' as const, from: oldName, to: kebabName, oldUri: uri, newUri };
}

async function renameFileToKebab(uri: vscode.Uri | vscode.Uri[], selectedUris?: vscode.Uri[]) {
  const config = getRenameConfig();
  const channel = getOutputChannel();
  channel.clear();

  const targets: vscode.Uri[] = Array.isArray(uri) ? uri : selectedUris && selectedUris.length ? selectedUris : uri ? [uri] : [];
  if (targets.length === 0) {
    vscode.window.showErrorMessage('No file selected');
    return;
  }

  const results = { renamed: 0, skipped: 0, errors: 0 };
  const successfulRenames: Array<{ oldUri: vscode.Uri; newUri: vscode.Uri; from: string; to: string }> = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
      title: targets.length > 1 ? `Renaming ${targets.length} files to kebab-case` : 'Renaming file to kebab-case'
    },
    async (progress, token) => {
      for (let i = 0; i < targets.length; i++) {
        if (token.isCancellationRequested) break;
        const target = targets[i];
        progress.report({ message: `${i + 1}/${targets.length}` });

        try {
          const r = await renameOneFileToKebab(target, config, token);
          if (r.kind === 'renamed') {
            results.renamed++;
            channel.appendLine(`[rename] ${r.from} -> ${r.to}`);
            successfulRenames.push({ oldUri: r.oldUri, newUri: r.newUri, from: r.from, to: r.to });
          } else {
            results.skipped++;
            channel.appendLine(`[skip] ${path.basename(target.fsPath)} (${r.reason}${r.target ? `: ${r.target}` : ''})`);
          }
        } catch (err) {
          results.errors++;
          channel.appendLine(`[error] ${path.basename(target.fsPath)}: ${(err as Error).message}`);
        }
      }

      if (!token.isCancellationRequested && config.updateImports && successfulRenames.length > 0) {
        progress.report({ message: `Updating imports...` });
        await updateImportsForRenames(
          successfulRenames.map((r) => ({ oldPath: r.oldUri.fsPath, newPath: r.newUri.fsPath })),
          token
        );
      }
    }
  );

  if (config.showSummary) {
    const msg = `Renamed ${results.renamed}, skipped ${results.skipped}, errors ${results.errors}.`;
    const action = await vscode.window.showInformationMessage(msg, 'Show details');
    if (action === 'Show details') channel.show(true);
  }
}

async function generateIndexFile(uri: vscode.Uri) {
  if (!uri) {
    vscode.window.showErrorMessage('No folder selected');
    return;
  }

  const resourceType = await getResourceType(uri);
  if (resourceType !== vscode.FileType.Directory) {
    vscode.window.showErrorMessage('Please select a folder.');
    return;
  }

  const folderPath = uri.fsPath;

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch (err) {
    vscode.window.showErrorMessage('Failed to read directory: ' + (err as Error).message);
    return;
  }

  const exportLines: string[] = [];
  const barrelExclusionPattern = /(?:^index\.(?:ts|tsx)$|\.d\.ts$|\.(?:test|spec)\.(?:ts|tsx)$|\.stories\.(?:ts|tsx)$)/i;

  for (const [name, type] of entries) {
    if (
      type === vscode.FileType.File &&
      (name.endsWith('.ts') || name.endsWith('.tsx')) &&
      !barrelExclusionPattern.test(name)
    ) {
      const baseName = name.replace(/\.(ts|tsx)$/, '');
      exportLines.push(`export * from './${baseName}';`);
    }
  }

  if (exportLines.length === 0) {
    vscode.window.showInformationMessage('No .ts or .tsx files found to export.');
    return;
  }

  exportLines.sort((left, right) => left.localeCompare(right));

  const content = exportLines.join('\n') + '\n';
  const indexUri = vscode.Uri.file(path.join(folderPath, 'index.ts'));

  try {
    let existingContent: string | undefined;
    try {
      const existingBytes = await vscode.workspace.fs.readFile(indexUri);
      existingContent = new TextDecoder().decode(existingBytes);
    } catch {
      existingContent = undefined;
    }

    if (existingContent === content) {
      vscode.window.showInformationMessage('index.ts is already up to date.');
      await vscode.commands.executeCommand('revealInExplorer', indexUri);
      return;
    }

    if (existingContent !== undefined) {
      const overwrite = await vscode.window.showWarningMessage(
        'index.ts already exists. Do you want to replace it?',
        { modal: true },
        'Replace'
      );

      if (overwrite !== 'Replace') {
        return;
      }
    }

    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(indexUri, encoder.encode(content));
    await vscode.window.showTextDocument(indexUri, { preview: false });
    vscode.window.showInformationMessage('index.ts generated successfully!');
  } catch (err) {
    vscode.window.showErrorMessage('Failed to write index.ts: ' + (err as Error).message);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const renameDisposable = vscode.commands.registerCommand('file-utils.renameFile', renameFileToKebab);
  const exportDisposable = vscode.commands.registerCommand('file-utils.exportIndex', generateIndexFile);
  const fixPropsDisposable = vscode.commands.registerCommand('file-utils.fixPropsType', fixPropsType);

  context.subscriptions.push(renameDisposable, exportDisposable, fixPropsDisposable);
}

export function deactivate() {
  outputChannel?.dispose();
  outputChannel = undefined;
}
