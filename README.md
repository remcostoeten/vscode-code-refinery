# Code Refinery

VS Code extension for small TypeScript/TSX refactors and file-structure cleanup.

## What It Does

This extension currently ships 7 explorer commands:

1. `Convert Filename to kebab-case`
2. `Generate index.ts with exports`
3. `Rename Local Type/Interface to Props`
4. `Convert Default Export to Named Export`
5. `Convert Named Export to Default Export`
6. `Remove Unused from Current TS/TSX File`
7. `Convert Interfaces to Types`

## Features

### Convert Filename to kebab-case

- Renames one file or a multi-selection of files to kebab-case.
- Skips files that are already kebab-case.
- Skips renames when the target file already exists.
- Runs in a cancellable progress notification for batch operations.
- Can reveal the renamed file in the Explorer.
- Can update relative import specifiers across workspace source files after the rename.
- Import updates cover `from '...'`, `require('...')`, and dynamic `import('...')` references.
- Import update scanning covers `ts`, `tsx`, `js`, `jsx`, `mts`, `cts`, `mjs`, and `cjs` files.

### Generate `index.ts` with exports

- Works on a selected folder from the Explorer.
- Generates barrel exports for sibling `.ts` and `.tsx` files.
- Sorts export lines alphabetically.
- Skips:
  `index.ts`, `index.tsx`, `.d.ts`, `*.test.ts`, `*.spec.ts`, `*.stories.ts`, and TSX variants.
- Detects when `index.ts` is already up to date.
- Prompts before overwriting an existing `index.ts`.
- Opens the generated file after writing.

### Rename Local Type/Interface to `Props`

- Runs only on `.ts` and `.tsx` files.
- Uses the TypeScript rename provider, so references in the file/workspace are updated through TS tooling.
- Intended for React-style component files where a local props shape has a custom name like `ButtonProps`, `CardInput`, or `WidgetOptions`, but you want the file standardized to `Props`.
- Only runs when the file contains exactly one top-level type-like declaration and it is not exported.
- Refuses to run if `Props` already exists.
- If the target is an `interface`, it renames it and converts it to `type Props = ...`.

Example:

```tsx
interface ButtonProps {
    label: string
}

export function Button(props: ButtonProps) {
    return <button>{props.label}</button>
}
```

becomes:

```tsx
type Props = {
    label: string
}

export function Button(props: Props) {
    return <button>{props.label}</button>
}
```

This is useful when you prefer a consistent `Props` convention inside component files instead of repeating file-specific prop type names everywhere.

### Convert Default Export to Named Export

- Runs only on `.ts` and `.tsx` files.
- Previews the file/workspace changes before applying them.
- Updates workspace import and re-export sites that reference the file.
- Useful when you want a file to follow named-export conventions across a codebase.
- Supports:
  `export default function Named() {}`
- Supports:
  `export default class Named {}`
- Supports:
  `export default Foo`
- Supports:
  `export { Foo as default }`

### Convert Named Export to Default Export

- Runs only on `.ts` and `.tsx` files.
- Previews the file/workspace changes before applying them.
- Updates workspace import and re-export sites that reference the file.
- Only runs when the file has exactly one supported named value export with no ambiguity.
- Supports named exported functions, classes, single exported variables, and single-item local export lists.

Example:

```ts
export function Widget() {}
```

with imports like:

```ts
import { Widget } from './widget'
```

becomes:

```ts
export default function Widget() {}
```

and workspace imports are rewritten to:

```ts
import Widget from './widget'
```

### Remove Unused from Current TS/TSX File

- Runs only on `.ts` and `.tsx` files.
- Uses TypeScript diagnostics/code fixes for unused cleanup.
- Shows a preview before edits are applied.
- Lets you target one category at a time or clean everything.
- Supported cleanup scopes:
  `All`, `Imports`, `Types/Interfaces`, `Exports`, `Functions`, `Variables`
- Export cleanup also removes unused exported declarations or strips the `export` modifier when the symbol is only used locally.

This is meant for focused cleanup of the current file instead of running a project-wide linter autofix and hoping it does the right thing.

### Convert Interfaces to Types

- Runs only on `.ts` and `.tsx` files.
- Converts safe top-level `interface` declarations to `type` aliases.
- Preserves `export` when present.
- Skips merged interfaces.
- Skips default-exported interfaces.
- Converts every safe interface in the selected file in one pass.

Example:

```ts
export interface User {
    id: string
    name: string
}
```

becomes:

```ts
export type User = {
    id: string
    name: string
}
```

## Settings

The extension contributes 3 settings:

- `codeRefinery.rename.updateImports`
  Update TS/JS relative import specifiers in the workspace after file rename.
  Default: `true`
- `codeRefinery.rename.showSummary`
  Show a rename summary after batch operations.
  Default: `true`
- `codeRefinery.rename.revealInExplorer`
  Reveal the renamed file in the Explorer after rename.
  Default: `true`

## Where Commands Appear

- Explorer context menu on files:
  `Convert Filename to kebab-case`
- Explorer context menu on folders:
  `Generate index.ts with exports`
- Explorer context menu on `.ts` / `.tsx` files:
  `Rename Local Type/Interface to Props`
  `Convert Default Export to Named Export`
  `Convert Named Export to Default Export`
  `Remove Unused from Current TS/TSX File`
  `Convert Interfaces to Types`
- Command Palette:
  all contributed commands are available by title

## Keybindings

- `Ctrl+Alt+K`
  Convert filename to kebab-case
- `Ctrl+Alt+I`
  Generate `index.ts` with exports

## Development

### Requirements

- Node.js
- npm
- VS Code

### Scripts

- `npm run compile`
  Compile the extension
- `npm run watch`
  Watch and compile on changes
- `npm run lint`
  Lint with `oxlint`
- `npm run format`
  Format with `oxfmt`
- `npm run format:check`
  Check formatting without writing files
- `npm run test:unit`
  Run unit tests
- `npm run test:e2e`
  Run VS Code integration tests
- `npm run test`
  Run unit and E2E suites
- `npm run package`
  Build a `.vsix`

### Local Run

```bash
npm install
npm run compile
```

Open the folder in VS Code and press `F5` to launch the Extension Development Host.

## Install the VSIX Manually

Build the package:

```bash
npm run package
```

That produces:

```text
code-refinery-0.10.0.vsix
```

Install it in VS Code with `Extensions: Install from VSIX...` and select the generated file.
