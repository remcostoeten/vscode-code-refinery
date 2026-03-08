import * as ts from 'typescript';

export type TTypeLikeDecl = {
  kind: 'type' | 'interface';
  name: string;
  exported: boolean;
  keywordOffset: number;
  nameOffset: number;
};

export type TExportRewrite = {
  start: number;
  end: number;
  replacement: string;
};

export function getTopLevelTypeLikeDecls(text: string): TTypeLikeDecl[] {
  const decls: TTypeLikeDecl[] = [];
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
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (quote === '`' && c === '$' && text[i + 1] === '{') {
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
    const oldI = i;
    i = startIdx;
    skipWs();
    if (text[i] !== '{') {
      i = oldI;
      return;
    }
    i++;
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
        skipWs();
        const nameIdent = readIdent();
        if (nameIdent) {
          decls.push({
            kind: maybeType.kind,
            name: nameIdent.value,
            exported: true,
            keywordOffset: word.start,
            nameOffset: nameIdent.start
          });
          exportedNames.add(nameIdent.value);
        }
      } else {
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
          decls.push({
            kind: next.value,
            name: nameIdent.value,
            exported: false,
            keywordOffset: next.start,
            nameOffset: nameIdent.start
          });
        }
      }
      continue;
    }

    if (wordValue === 'type' || wordValue === 'interface') {
      skipWs();
      const nameIdent = readIdent();
      if (nameIdent) {
        decls.push({
          kind: wordValue,
          name: nameIdent.value,
          exported: false,
          keywordOffset: word.start,
          nameOffset: nameIdent.start
        });
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

export function findMatchingIndex(
  text: string,
  start: number,
  openChar: string,
  closeChar: string
): number | undefined {
  let depth = 0;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return undefined;
}

export function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depthAngle = 0;
  let depthParen = 0;
  let depthBracket = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '<') depthAngle++;
    else if (char === '>') depthAngle = Math.max(0, depthAngle - 1);
    else if (char === '(') depthParen++;
    else if (char === ')') depthParen = Math.max(0, depthParen - 1);
    else if (char === '[') depthBracket++;
    else if (char === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (char === ',' && depthAngle === 0 && depthParen === 0 && depthBracket === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

export function buildTypeAliasFromInterface(
  text: string,
  decl: TTypeLikeDecl,
  replacementName = decl.name
): { start: number; end: number; replacement: string } | undefined {
  if (decl.kind !== 'interface') {
    return undefined;
  }

  let cursor = decl.nameOffset + decl.name.length;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;

  let typeParams = '';
  if (text[cursor] === '<') {
    const endTypeParams = findMatchingIndex(text, cursor, '<', '>');
    if (endTypeParams === undefined) {
      return undefined;
    }
    typeParams = text.slice(cursor, endTypeParams + 1);
    cursor = endTypeParams + 1;
  }

  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;

  const bodyStart = text.indexOf('{', cursor);
  if (bodyStart === -1) {
    return undefined;
  }

  const bodyEnd = findMatchingIndex(text, bodyStart, '{', '}');
  if (bodyEnd === undefined) {
    return undefined;
  }

  const heritageText = text.slice(cursor, bodyStart).trim();
  const bodyText = text.slice(bodyStart, bodyEnd + 1);
  const heritageTypes = heritageText.startsWith('extends ')
    ? splitTopLevelCommas(heritageText.slice('extends '.length)).join(' & ')
    : '';

  const aliasRightHandSide = heritageTypes ? `${heritageTypes} & ${bodyText}` : bodyText;

  return {
    start: decl.keywordOffset,
    end: bodyEnd + 1,
    replacement: `type ${replacementName}${typeParams} = ${aliasRightHandSide};`
  };
}

export function createSourceFile(filePath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function buildImportDeclarationText(
  sourceFile: ts.SourceFile,
  node: ts.ImportDeclaration,
  options: {
    defaultImport?: string;
    namedImports?: string[];
    isTypeOnly?: boolean;
  }
): string {
  const moduleText = node.moduleSpecifier.getText(sourceFile);
  const pieces: string[] = ['import'];

  if (options.isTypeOnly) {
    pieces.push('type');
  }

  if (options.defaultImport) {
    pieces.push(options.defaultImport);
  }

  if (options.namedImports && options.namedImports.length > 0) {
    const namedText = `{ ${options.namedImports.join(', ')} }`;
    if (options.defaultImport) {
      pieces[pieces.length - 1] = `${pieces[pieces.length - 1]},`;
    }
    pieces.push(namedText);
  }

  pieces.push('from', moduleText);
  return `${pieces.join(' ')};`;
}

export function buildExportDeclarationText(
  sourceFile: ts.SourceFile,
  node: ts.ExportDeclaration,
  specifiers: string[]
): string {
  const moduleText = node.moduleSpecifier?.getText(sourceFile);
  const typePrefix = node.isTypeOnly ? ' type' : '';
  const fromPart = moduleText ? ` from ${moduleText}` : '';
  return `export${typePrefix} { ${specifiers.join(', ')} }${fromPart};`;
}

export function collectDefaultToNamedReferenceRewrites(
  sourceFile: ts.SourceFile,
  moduleSpecifiers: Set<string>,
  exportName: string
): TExportRewrite[] {
  const rewrites: TExportRewrite[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifierText = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      if (!specifierText || !moduleSpecifiers.has(specifierText)) {
        continue;
      }

      const clause = statement.importClause;
      if (!clause?.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
        continue;
      }

      const aliasText = clause.name.text === exportName ? exportName : `${exportName} as ${clause.name.text}`;
      const existingNamed = clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.map((element) => element.getText(sourceFile))
        : [];

      if (!existingNamed.includes(aliasText) && !existingNamed.includes(exportName)) {
        existingNamed.unshift(aliasText);
      }

      rewrites.push({
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
        replacement: buildImportDeclarationText(sourceFile, statement, {
          namedImports: existingNamed,
          isTypeOnly: clause.isTypeOnly
        })
      });
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifierText = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      if (!specifierText || !moduleSpecifiers.has(specifierText) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        continue;
      }

      let changed = false;
      const specifiers = statement.exportClause.elements.map((element) => {
        const localName = element.propertyName?.text ?? element.name.text;
        if (localName !== 'default') {
          return element.getText(sourceFile);
        }

        changed = true;
        return element.name.text === exportName ? exportName : `${exportName} as ${element.name.text}`;
      });

      if (!changed) {
        continue;
      }

      rewrites.push({
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
        replacement: buildExportDeclarationText(sourceFile, statement, specifiers)
      });
    }
  }

  return rewrites;
}

export function collectNamedToDefaultReferenceRewrites(
  sourceFile: ts.SourceFile,
  moduleSpecifiers: Set<string>,
  exportName: string
): TExportRewrite[] {
  const rewrites: TExportRewrite[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifierText = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      if (!specifierText || !moduleSpecifiers.has(specifierText)) {
        continue;
      }

      const clause = statement.importClause;
      if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.isTypeOnly) {
        continue;
      }

      const targetSpecifier = clause.namedBindings.elements.find((element) => (element.propertyName?.text ?? element.name.text) === exportName);
      if (!targetSpecifier) {
        continue;
      }

      if (clause.name && clause.name.text !== targetSpecifier.name.text) {
        continue;
      }

      const remaining = clause.namedBindings.elements
        .filter((element) => element !== targetSpecifier)
        .map((element) => element.getText(sourceFile));

      rewrites.push({
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
        replacement: buildImportDeclarationText(sourceFile, statement, {
          defaultImport: clause.name?.text ?? targetSpecifier.name.text,
          namedImports: remaining.length > 0 ? remaining : undefined
        })
      });
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifierText = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      if (!specifierText || !moduleSpecifiers.has(specifierText) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        continue;
      }

      let changed = false;
      const specifiers = statement.exportClause.elements.map((element) => {
        const localName = element.propertyName?.text ?? element.name.text;
        if (localName !== exportName) {
          return element.getText(sourceFile);
        }

        changed = true;
        return `default as ${element.name.text}`;
      });

      if (!changed) {
        continue;
      }

      rewrites.push({
        start: statement.getStart(sourceFile),
        end: statement.getEnd(),
        replacement: buildExportDeclarationText(sourceFile, statement, specifiers)
      });
    }
  }

  return rewrites;
}
