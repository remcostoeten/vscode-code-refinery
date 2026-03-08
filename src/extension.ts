import * as vscode from 'vscode';
import * as path from 'path';
import * as ts from 'typescript';
import {
  buildExportDeclarationText,
  buildTypeAliasFromInterface,
  collectDefaultToNamedReferenceRewrites,
  collectNamedToDefaultReferenceRewrites,
  createSourceFile,
  getTopLevelTypeLikeDecls,
  type TExportRewrite,
  type TTypeLikeDecl
} from './refactor-core';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Code Refinery');
  }
  return outputChannel;
}

async function showCommandSummary(message: string, detailLines: string[] = []) {
  const channel = getOutputChannel();
  if (detailLines.length > 0) {
    channel.clear();
    for (const line of detailLines) {
      channel.appendLine(line);
    }
  }

  const action = await vscode.window.showInformationMessage(message, ...(detailLines.length > 0 ? ['Show details'] : []));
  if (action === 'Show details') {
    channel.show(true);
  }
}

async function confirmCommandPreview(message: string, detailLines: string[] = []) {
  if (detailLines.length === 0) {
    const action = await vscode.window.showWarningMessage(message, { modal: true }, 'Apply');
    return action === 'Apply';
  }

  const channel = getOutputChannel();
  channel.clear();
  for (const line of detailLines) {
    channel.appendLine(line);
  }

  let action = await vscode.window.showWarningMessage(message, { modal: true }, 'Apply', 'Show details');
  if (action === 'Show details') {
    channel.show(true);
    action = await vscode.window.showWarningMessage(message, { modal: true }, 'Apply');
  }

  return action === 'Apply';
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

const workspaceTsInclude = '**/*.{ts,tsx}';
const workspaceTsExclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**}';
const unusedDiagnosticCodes = new Set([6133, 6192, 6196, 6198]);

type TTsServiceContext = {
  languageService: ts.LanguageService;
  rootPath: string;
};

type TUnusedCategory = 'imports' | 'types' | 'interfaces' | 'exports' | 'functions' | 'variables';

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === kind));
}

function resolveTargetUri(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri) {
    return uri;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return activeUri?.scheme === 'file' ? activeUri : undefined;
}

async function findWorkspaceTypeScriptFiles(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(workspaceTsInclude, workspaceTsExclude);
  return uris.map((uri) => uri.fsPath);
}

async function createTypeScriptLanguageService(targetFilePath: string): Promise<TTsServiceContext> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetFilePath))
    ?? vscode.workspace.workspaceFolders?.[0];
  const rootPath = workspaceFolder?.uri.fsPath ?? path.dirname(targetFilePath);

  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowJs: false,
    skipLibCheck: true
  };

  let fileNames: string[] = [];
  const configPath = ts.findConfigFile(rootPath, ts.sys.fileExists, 'tsconfig.json');
  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
      options = { ...options, ...parsed.options };
      fileNames = parsed.fileNames.filter((fileName) => /\.(ts|tsx)$/.test(fileName));
    }
  }

  if (fileNames.length === 0) {
    fileNames = await findWorkspaceTypeScriptFiles();
  }

  if (!fileNames.includes(targetFilePath)) {
    fileNames.push(targetFilePath);
  }

  const openDocs = new Map<string, string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file' && /\.(ts|tsx)$/.test(doc.uri.fsPath)) {
      openDocs.set(doc.uri.fsPath, doc.getText());
    }
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getCurrentDirectory: () => rootPath,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    getNewLine: () => ts.sys.newLine,
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (fileName) => {
      const text = openDocs.get(fileName) ?? ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
  };

  return {
    languageService: ts.createLanguageService(host, ts.createDocumentRegistry()),
    rootPath
  };
}

async function applyFileTextChanges(edit: vscode.WorkspaceEdit, uri: vscode.Uri, changes: readonly ts.TextChange[]): Promise<number> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const accepted: ts.TextChange[] = [];
  let nextExclusiveEnd = Number.POSITIVE_INFINITY;

  for (const change of [...changes].sort((left, right) => right.span.start - left.span.start)) {
    const end = change.span.start + change.span.length;
    if (end > nextExclusiveEnd) {
      continue;
    }

    accepted.push(change);
    nextExclusiveEnd = change.span.start;
  }

  for (const change of accepted) {
    edit.replace(
      uri,
      new vscode.Range(
        doc.positionAt(change.span.start),
        doc.positionAt(change.span.start + change.span.length)
      ),
      change.newText
    );
  }

  return accepted.length;
}

async function applyTsFileChanges(fileChanges: readonly ts.FileTextChanges[]): Promise<number> {
  const workspaceEdit = new vscode.WorkspaceEdit();
  let total = 0;

  for (const fileChange of fileChanges) {
    total += await applyFileTextChanges(workspaceEdit, vscode.Uri.file(fileChange.fileName), fileChange.textChanges);
  }

  if (total === 0) {
    return 0;
  }

  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  return applied ? total : 0;
}

function getSourceFileFromService(languageService: ts.LanguageService, filePath: string): ts.SourceFile | undefined {
  return languageService.getProgram()?.getSourceFile(filePath);
}

function getLocalSymbolName(node: ts.NamedDeclaration): ts.Identifier | undefined {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name;
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name;
  }

  return undefined;
}

function getImportSpecifierCandidates(fromFilePath: string, targetFilePath: string): Set<string> {
  return new Set(getImportCandidateSpecifiers(fromFilePath, targetFilePath));
}

function findDeepestNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  let found: ts.Node | undefined;

  const visit = (node: ts.Node) => {
    if (position < node.getFullStart() || position >= node.getEnd()) {
      return;
    }

    found = node;
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function classifyUnusedDiagnostic(sourceFile: ts.SourceFile, start: number): Exclude<TUnusedCategory, 'exports'> | undefined {
  let node = findDeepestNodeAtPosition(sourceFile, start);
  while (node) {
    if (
      ts.isImportClause(node)
      || ts.isImportSpecifier(node)
      || ts.isNamespaceImport(node)
      || ts.isImportEqualsDeclaration(node)
      || ts.isImportDeclaration(node)
    ) {
      return 'imports';
    }
    if (ts.isInterfaceDeclaration(node)) {
      return 'interfaces';
    }
    if (ts.isTypeAliasDeclaration(node)) {
      return 'types';
    }
    if (ts.isFunctionDeclaration(node)) {
      return 'functions';
    }
    if (ts.isVariableDeclaration(node)) {
      return 'variables';
    }
    node = node.parent;
  }

  return undefined;
}

function isExportReferenceNode(node: ts.Node | undefined): boolean {
  let current = node;
  while (current) {
    if (ts.isExportSpecifier(current) || ts.isExportAssignment(current) || ts.isExportDeclaration(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function collectReferenceUsage(
  languageService: ts.LanguageService,
  filePath: string,
  sourceFile: ts.SourceFile,
  identifier: ts.Identifier
): { external: number; local: number } {
  const refs = languageService.findReferences(filePath, identifier.getStart(sourceFile)) ?? [];
  const definitionStart = identifier.getStart(sourceFile);
  const definitionLength = identifier.getWidth(sourceFile);

  let external = 0;
  let local = 0;

  for (const refGroup of refs) {
    for (const ref of refGroup.references) {
      if (ref.fileName !== filePath) {
        external++;
        continue;
      }

      const isDefinition = ref.textSpan.start === definitionStart && ref.textSpan.length === definitionLength;
      if (isDefinition) {
        continue;
      }

      const localNode = findDeepestNodeAtPosition(sourceFile, ref.textSpan.start);
      if (isExportReferenceNode(localNode)) {
        continue;
      }

      local++;
    }
  }

  return { external, local };
}

function getDeletionRange(sourceFile: ts.SourceFile, node: ts.Node): { start: number; end: number } {
  const text = sourceFile.getFullText();
  let start = node.getFullStart();
  let end = node.getEnd();

  while (end < text.length && (text[end] === '\r' || text[end] === '\n')) {
    end++;
  }

  return { start, end };
}

function getExportModifierRemovalRange(sourceFile: ts.SourceFile, node: ts.Node): { start: number; end: number } | undefined {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  const exportModifier = modifiers?.find((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  if (!exportModifier) {
    return undefined;
  }

  let start = exportModifier.getStart(sourceFile);
  let end = exportModifier.getEnd();
  const defaultModifier = modifiers?.find((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  if (defaultModifier) {
    end = defaultModifier.getEnd();
  }

  const text = sourceFile.getFullText();
  while (end < text.length && /\s/.test(text[end])) {
    end++;
  }

  return { start, end };
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

  // Rule:
  // - total == 1 and it is non-exported -> rename to Props
  let target: TTypeLikeDecl | undefined;
  if (decls.length === 1 && nonExported.length === 1) {
    target = nonExported[0];
  }

  if (!target) {
    vscode.window.showInformationMessage(
      'No eligible local type/interface to rename. This runs only when the file has exactly 1 top-level type/interface declaration and it is not exported.'
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

  if (target.kind === 'interface') {
    const updatedDoc = await vscode.workspace.openTextDocument(uri);
    const updatedDecls = getTopLevelTypeLikeDecls(updatedDoc.getText());
    const propsDecl = updatedDecls.find((decl) => !decl.exported && decl.name === 'Props');
    const conversion = propsDecl ? buildTypeAliasFromInterface(updatedDoc.getText(), propsDecl) : undefined;

    if (!conversion) {
      vscode.window.showErrorMessage('Renamed to Props, but failed to convert the interface to a type alias.');
      return;
    }

    const interfaceEdit = new vscode.WorkspaceEdit();
    interfaceEdit.replace(
      uri,
      new vscode.Range(
        updatedDoc.positionAt(conversion.start),
        updatedDoc.positionAt(conversion.end)
      ),
      conversion.replacement
    );

    const converted = await vscode.workspace.applyEdit(interfaceEdit);
    if (!converted) {
      vscode.window.showErrorMessage('Renamed to Props, but failed to convert the interface to a type alias.');
      return;
    }
  }

  await doc.save();
  await showCommandSummary(`Renamed ${target.name} to Props as a type.`, [
    `[props] ${path.basename(uri.fsPath)}: ${target.kind} ${target.name} -> type Props`
  ]);
}

async function collectWorkspaceReferenceUpdatesForExportConversion(
  targetFilePath: string,
  exportName: string,
  mode: 'default-to-named' | 'named-to-default'
): Promise<{ workspaceEdit: vscode.WorkspaceEdit; changedUris: vscode.Uri[]; filesChanged: number; editsApplied: number; detailLines: string[] }> {
  const files = await findWorkspaceTypeScriptFiles();
  const workspaceEdit = new vscode.WorkspaceEdit();
  const changedUris: vscode.Uri[] = [];
  const detailLines: string[] = [];
  let filesChanged = 0;
  let editsApplied = 0;

  for (const filePath of files) {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const sourceFile = createSourceFile(filePath, text);
    const moduleSpecifiers = getImportSpecifierCandidates(filePath, targetFilePath);
    const rewrites = mode === 'default-to-named'
      ? collectDefaultToNamedReferenceRewrites(sourceFile, moduleSpecifiers, exportName)
      : collectNamedToDefaultReferenceRewrites(sourceFile, moduleSpecifiers, exportName);

    if (rewrites.length === 0) {
      continue;
    }

    filesChanged++;
    editsApplied += rewrites.length;
    changedUris.push(uri);

    for (const rewrite of rewrites.sort((left, right) => right.start - left.start)) {
      workspaceEdit.replace(
        uri,
        new vscode.Range(doc.positionAt(rewrite.start), doc.positionAt(rewrite.end)),
        rewrite.replacement
      );
    }

    detailLines.push(
      `[exports] ${path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', filePath)}: ${rewrites.length} update(s)`
    );
  }

  return { workspaceEdit, changedUris, filesChanged, editsApplied, detailLines };
}

async function applyWorkspaceEditAndSave(workspaceEdit: vscode.WorkspaceEdit, urisToSave: vscode.Uri[]) {
  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  if (!applied) {
    return false;
  }

  const seen = new Set<string>();
  for (const uri of urisToSave) {
    if (seen.has(uri.toString())) {
      continue;
    }
    seen.add(uri.toString());
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
  }

  return true;
}

async function convertDefaultExportToNamed(uri?: vscode.Uri) {
  const targetUri = resolveTargetUri(uri);
  if (!targetUri) {
    vscode.window.showErrorMessage('No file selected.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(targetUri);
  if (!/\.(ts|tsx)$/.test(doc.uri.fsPath)) {
    vscode.window.showErrorMessage('Please select a .ts or .tsx file.');
    return;
  }

  const sourceFile = createSourceFile(doc.uri.fsPath, doc.getText());
  let exportName: string | undefined;
  let rewrite: TExportRewrite | undefined;

  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      && statement.name
    ) {
      const defaultModifier = ts.getModifiers(statement)?.find((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (!defaultModifier) {
        continue;
      }

      exportName = statement.name.text;
      let end = defaultModifier.getEnd();
      const text = sourceFile.getFullText();
      while (end < text.length && /\s/.test(text[end])) {
        end++;
      }

      rewrite = {
        start: defaultModifier.getStart(sourceFile),
        end,
        replacement: ''
      };
      break;
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      exportName = statement.expression.text;
      rewrite = {
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
        replacement: `export { ${exportName} };`
      };
      break;
    }

    if (
      ts.isExportDeclaration(statement)
      && !statement.moduleSpecifier
      && statement.exportClause
      && ts.isNamedExports(statement.exportClause)
    ) {
      const defaultSpecifier = statement.exportClause.elements.find((element) => element.name.text === 'default');
      if (!defaultSpecifier) {
        continue;
      }

      const localName = defaultSpecifier.propertyName?.text;
      if (!localName) {
        continue;
      }

      exportName = localName;
      const specifiers = statement.exportClause.elements.map((element) => {
        if (element !== defaultSpecifier) {
          return element.getText(sourceFile);
        }
        return localName;
      });
      rewrite = {
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
        replacement: buildExportDeclarationText(sourceFile, statement, specifiers)
      };
      break;
    }
  }

  if (!exportName || !rewrite) {
    vscode.window.showInformationMessage(
      'No supported default export found. Supported cases: named default function/class, `export default Foo`, or `export { Foo as default }`.'
    );
    return;
  }

  const summary = await collectWorkspaceReferenceUpdatesForExportConversion(doc.uri.fsPath, exportName, 'default-to-named');
  const detailLines = [
    `[exports] ${path.basename(doc.uri.fsPath)}: default -> named ${exportName}`,
    ...summary.detailLines
  ];

  const shouldApply = await confirmCommandPreview(
    `Apply default-to-named export conversion for \`${exportName}\` with ${summary.editsApplied} workspace reference update(s)?`,
    detailLines
  );
  if (!shouldApply) {
    return;
  }

  summary.workspaceEdit.replace(
    targetUri,
    new vscode.Range(doc.positionAt(rewrite.start), doc.positionAt(rewrite.end)),
    rewrite.replacement
  );

  const applied = await applyWorkspaceEditAndSave(summary.workspaceEdit, [targetUri, ...summary.changedUris]);
  if (!applied) {
    vscode.window.showErrorMessage('Failed to apply the export conversion edits.');
    return;
  }

  await showCommandSummary(
    `Converted default export to named export \`${exportName}\`. Updated ${summary.editsApplied} reference(s) in ${summary.filesChanged} file(s).`,
    detailLines
  );
}

async function convertNamedExportToDefault(uri?: vscode.Uri) {
  const targetUri = resolveTargetUri(uri);
  if (!targetUri) {
    vscode.window.showErrorMessage('No file selected.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(targetUri);
  if (!/\.(ts|tsx)$/.test(doc.uri.fsPath)) {
    vscode.window.showErrorMessage('Please select a .ts or .tsx file.');
    return;
  }

  const sourceFile = createSourceFile(doc.uri.fsPath, doc.getText());
  const candidates: Array<{ exportName: string; rewrite: TExportRewrite }> = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      && !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      && statement.name
    ) {
      const exportModifier = ts.getModifiers(statement)?.find((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!exportModifier) {
        continue;
      }

      let end = exportModifier.getEnd();
      const text = sourceFile.getFullText();
      while (end < text.length && /\s/.test(text[end])) {
        end++;
      }

      candidates.push({
        exportName: statement.name.text,
        rewrite: {
          start: exportModifier.getStart(sourceFile),
          end,
          replacement: 'export default '
        }
      });
      continue;
    }

    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (statement.declarationList.declarations.length !== 1) {
        continue;
      }

      const declaration = statement.declarationList.declarations[0];
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }

      const removal = getExportModifierRemovalRange(sourceFile, statement);
      if (!removal) {
        continue;
      }

      const statementText = sourceFile.getFullText().slice(removal.end, statement.getEnd());
      candidates.push({
        exportName: declaration.name.text,
        rewrite: {
          start: statement.getStart(sourceFile),
          end: statement.getEnd(),
          replacement: `${statementText}\nexport default ${declaration.name.text};`
        }
      });
      continue;
    }

    if (
      ts.isExportDeclaration(statement)
      && !statement.moduleSpecifier
      && statement.exportClause
      && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.length === 1
    ) {
      const element = statement.exportClause.elements[0];
      const localName = element.propertyName?.text ?? element.name.text;
      candidates.push({
        exportName: localName,
        rewrite: {
          start: statement.getStart(sourceFile),
          end: statement.getEnd(),
          replacement: `export default ${localName};`
        }
      });
    }
  }

  if (candidates.length !== 1) {
    vscode.window.showInformationMessage(
      'Named-to-default conversion runs only when the file has exactly 1 supported named value export and no ambiguity.'
    );
    return;
  }

  const candidate = candidates[0];
  const summary = await collectWorkspaceReferenceUpdatesForExportConversion(doc.uri.fsPath, candidate.exportName, 'named-to-default');
  const detailLines = [
    `[exports] ${path.basename(doc.uri.fsPath)}: named ${candidate.exportName} -> default`,
    ...summary.detailLines
  ];

  const shouldApply = await confirmCommandPreview(
    `Apply named-to-default export conversion for \`${candidate.exportName}\` with ${summary.editsApplied} workspace reference update(s)?`,
    detailLines
  );
  if (!shouldApply) {
    return;
  }

  summary.workspaceEdit.replace(
    targetUri,
    new vscode.Range(doc.positionAt(candidate.rewrite.start), doc.positionAt(candidate.rewrite.end)),
    candidate.rewrite.replacement
  );

  const applied = await applyWorkspaceEditAndSave(summary.workspaceEdit, [targetUri, ...summary.changedUris]);
  if (!applied) {
    vscode.window.showErrorMessage('Failed to apply the export conversion edits.');
    return;
  }

  await showCommandSummary(
    `Converted named export \`${candidate.exportName}\` to default export. Updated ${summary.editsApplied} reference(s) in ${summary.filesChanged} file(s).`,
    detailLines
  );
}

async function collectUnusedExportChanges(uri: vscode.Uri): Promise<{ rewrites: TExportRewrite[]; details: string[] }> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const context = await createTypeScriptLanguageService(uri.fsPath);
  const sourceFile = getSourceFileFromService(context.languageService, uri.fsPath);
  if (!sourceFile) {
    return { rewrites: [], details: [] };
  }

  const rewrites: TExportRewrite[] = [];
  const details: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isInterfaceDeclaration(statement))
      && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      && statement.name
    ) {
      const usage = collectReferenceUsage(context.languageService, uri.fsPath, sourceFile, statement.name);
      if (usage.external > 0) {
        continue;
      }

      if (usage.local === 0) {
        const range = getDeletionRange(sourceFile, statement);
        rewrites.push({ start: range.start, end: range.end, replacement: '' });
        details.push(`[unused:exports] ${path.basename(uri.fsPath)}: removed export ${statement.name.text}`);
      } else {
        const range = getExportModifierRemovalRange(sourceFile, statement);
        if (range) {
          rewrites.push({ start: range.start, end: range.end, replacement: '' });
          details.push(`[unused:exports] ${path.basename(uri.fsPath)}: removed export modifier from ${statement.name.text}`);
        }
      }
      continue;
    }

    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (statement.declarationList.declarations.length !== 1) {
        continue;
      }

      const declaration = statement.declarationList.declarations[0];
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }

      const usage = collectReferenceUsage(context.languageService, uri.fsPath, sourceFile, declaration.name);
      if (usage.external > 0) {
        continue;
      }

      if (usage.local === 0) {
        const range = getDeletionRange(sourceFile, statement);
        rewrites.push({ start: range.start, end: range.end, replacement: '' });
        details.push(`[unused:exports] ${path.basename(uri.fsPath)}: removed export ${declaration.name.text}`);
      } else {
        const range = getExportModifierRemovalRange(sourceFile, statement);
        if (range) {
          rewrites.push({ start: range.start, end: range.end, replacement: '' });
          details.push(`[unused:exports] ${path.basename(uri.fsPath)}: removed export modifier from ${declaration.name.text}`);
        }
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement)
      && !statement.moduleSpecifier
      && statement.exportClause
      && ts.isNamedExports(statement.exportClause)
    ) {
      const kept = statement.exportClause.elements.filter((element) => {
        const localIdentifier = element.propertyName ?? element.name;
        if (!ts.isIdentifier(localIdentifier)) {
          return true;
        }
        const usage = collectReferenceUsage(context.languageService, uri.fsPath, sourceFile, localIdentifier);
        return usage.external > 0;
      });

      if (kept.length === statement.exportClause.elements.length) {
        continue;
      }

      if (kept.length === 0) {
        const range = getDeletionRange(sourceFile, statement);
        rewrites.push({ start: range.start, end: range.end, replacement: '' });
        details.push(`[unused:exports] ${path.basename(uri.fsPath)}: removed export list`);
      } else {
        rewrites.push({
          start: statement.getStart(sourceFile),
          end: statement.getEnd(),
          replacement: buildExportDeclarationText(sourceFile, statement, kept.map((element) => element.getText(sourceFile)))
        });
        details.push(`[unused:exports] ${path.basename(uri.fsPath)}: pruned export list`);
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      const usage = collectReferenceUsage(context.languageService, uri.fsPath, sourceFile, statement.expression);
      if (usage.external > 0) {
        continue;
      }

      const range = getDeletionRange(sourceFile, statement);
      rewrites.push({ start: range.start, end: range.end, replacement: '' });
      details.push(`[unused:exports] ${path.basename(uri.fsPath)}: removed default export ${statement.expression.text}`);
    }
  }

  return { rewrites, details };
}

async function applyUnusedExportChanges(uri: vscode.Uri, rewrites: TExportRewrite[]) {
  if (rewrites.length === 0) {
    return 0;
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  for (const rewrite of rewrites.sort((left, right) => right.start - left.start)) {
    edit.replace(uri, new vscode.Range(doc.positionAt(rewrite.start), doc.positionAt(rewrite.end)), rewrite.replacement);
  }

  const applied = await applyWorkspaceEditAndSave(edit, [uri]);
  return applied ? rewrites.length : 0;
}

async function removeUnusedFromFile(uri?: vscode.Uri) {
  const targetUri = resolveTargetUri(uri);
  if (!targetUri) {
    vscode.window.showErrorMessage('No file selected.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(targetUri);
  if (!/\.(ts|tsx)$/.test(doc.uri.fsPath)) {
    vscode.window.showErrorMessage('Please select a .ts or .tsx file.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      { label: 'All', value: 'all' },
      { label: 'Imports', value: 'imports' },
      { label: 'Types/Interfaces', value: 'types-and-interfaces' },
      { label: 'Exports', value: 'exports' },
      { label: 'Functions', value: 'functions' },
      { label: 'Variables', value: 'variables' }
    ],
    { placeHolder: 'Choose what to remove from the current file' }
  );

  if (!picked) {
    return;
  }

  const selectedCategories: TUnusedCategory[] = picked.value === 'all'
    ? ['imports', 'types', 'interfaces', 'exports', 'functions', 'variables']
    : picked.value === 'types-and-interfaces'
      ? ['types', 'interfaces']
      : [picked.value as TUnusedCategory];

  const context = await createTypeScriptLanguageService(doc.uri.fsPath);
  const sourceFile = getSourceFileFromService(context.languageService, doc.uri.fsPath);
  if (!sourceFile) {
    vscode.window.showErrorMessage('Failed to analyze this file with TypeScript.');
    return;
  }

  const detailLines: string[] = [];
  const tsCategories = selectedCategories.filter((category) => category !== 'exports');
  const changes: ts.FileTextChanges[] = [];
  if (tsCategories.length > 0) {
    const diagnostics = context.languageService.getSuggestionDiagnostics(doc.uri.fsPath);

    for (const diagnostic of diagnostics) {
      if (diagnostic.start === undefined || !unusedDiagnosticCodes.has(diagnostic.code)) {
        continue;
      }

      const category = classifyUnusedDiagnostic(sourceFile, diagnostic.start);
      if (!category || !tsCategories.includes(category)) {
        continue;
      }

      const fixes = context.languageService.getCodeFixesAtPosition(
        doc.uri.fsPath,
        diagnostic.start,
        diagnostic.start + (diagnostic.length ?? 0),
        [diagnostic.code],
        {},
        {}
      );
      const fix = fixes.find((candidate) => candidate.changes.length > 0);
      if (fix) {
        changes.push(...fix.changes);
        detailLines.push(`[unused:${category}] ${path.basename(doc.uri.fsPath)}: ${fix.description}`);
      }
    }
  }

  let exportRewrites: TExportRewrite[] = [];
  if (selectedCategories.includes('exports')) {
    const exportResult = await collectUnusedExportChanges(doc.uri);
    exportRewrites = exportResult.rewrites;
    detailLines.push(...exportResult.details);
  }

  const plannedChanges = changes.reduce((count, fileChange) => count + fileChange.textChanges.length, 0) + exportRewrites.length;
  const totalChanges = plannedChanges;
  if (totalChanges === 0) {
    vscode.window.showInformationMessage('No matching unused code found to remove.');
    return;
  }

  const shouldApply = await confirmCommandPreview(
    `Apply unused cleanup with ${totalChanges} planned change(s) in ${path.basename(doc.uri.fsPath)}?`,
    detailLines
  );
  if (!shouldApply) {
    return;
  }

  const appliedFixes = await applyTsFileChanges(changes);
  const removedExports = await applyUnusedExportChanges(doc.uri, exportRewrites);
  const appliedChanges = appliedFixes + removedExports;
  if (appliedChanges === 0) {
    vscode.window.showErrorMessage('Failed to apply the unused cleanup edits.');
    return;
  }

  await doc.save();
  await showCommandSummary(`Removed unused code with ${appliedChanges} change(s).`, detailLines);
}

async function convertInterfacesToTypes(uri?: vscode.Uri) {
  const targetUri = resolveTargetUri(uri);
  if (!targetUri) {
    vscode.window.showErrorMessage('No file selected.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(targetUri);
  if (!/\.(ts|tsx)$/.test(doc.uri.fsPath)) {
    vscode.window.showErrorMessage('Please select a .ts or .tsx file.');
    return;
  }

  const text = doc.getText();
  const sourceFile = createSourceFile(doc.uri.fsPath, text);
  const decls = getTopLevelTypeLikeDecls(text).filter((decl) => decl.kind === 'interface');
  const nameCounts = new Map<string, number>();
  for (const decl of decls) {
    nameCounts.set(decl.name, (nameCounts.get(decl.name) ?? 0) + 1);
  }

  const defaultExportedNames = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      defaultExportedNames.add(statement.name.text);
    }
  }

  const conversions = decls
    .filter((decl) => (nameCounts.get(decl.name) ?? 0) === 1 && !defaultExportedNames.has(decl.name))
    .map((decl) => buildTypeAliasFromInterface(text, decl, decl.name))
    .filter((conversion): conversion is NonNullable<typeof conversion> => Boolean(conversion))
    .sort((left, right) => right.start - left.start);

  if (conversions.length === 0) {
    vscode.window.showInformationMessage(
      'No convertible interfaces found. This skips merged interfaces and default-exported interfaces.'
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const conversion of conversions) {
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(conversion.start), doc.positionAt(conversion.end)),
      conversion.replacement
    );
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage('Failed to convert interfaces to types.');
    return;
  }

  await doc.save();
  await showCommandSummary(
    `Converted ${conversions.length} interface(s) to type aliases.`,
    conversions.map((conversion) => `[interfaces] ${path.basename(doc.uri.fsPath)}: ${conversion.replacement}`)
  );
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
  const defaultToNamedDisposable = vscode.commands.registerCommand('file-utils.convertDefaultToNamed', convertDefaultExportToNamed);
  const namedToDefaultDisposable = vscode.commands.registerCommand('file-utils.convertNamedToDefault', convertNamedExportToDefault);
  const removeUnusedDisposable = vscode.commands.registerCommand('file-utils.removeUnused', removeUnusedFromFile);
  const convertInterfacesDisposable = vscode.commands.registerCommand('file-utils.convertInterfacesToTypes', convertInterfacesToTypes);

  context.subscriptions.push(
    renameDisposable,
    exportDisposable,
    fixPropsDisposable,
    defaultToNamedDisposable,
    namedToDefaultDisposable,
    removeUnusedDisposable,
    convertInterfacesDisposable
  );
}

export function deactivate() {
  outputChannel?.dispose();
  outputChannel = undefined;
}
