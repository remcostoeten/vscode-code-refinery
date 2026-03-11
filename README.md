# Code Refinery

TypeScript refactors for imports, barrels, props, exports, and cleanup in VS Code.

## What It Does

This extension currently ships 9 commands:

1. `Convert Filename to kebab-case`
2. `Generate index.ts with exports`
3. `Consolidate Imports via Folder Barrel`
4. `Consolidate Current File Imports to Detected UI Barrel`
5. `Rename Local Type/Interface to Props`
6. `Convert Default Export to Named Export`
7. `Convert Named Export to Default Export`
8. `Remove Unused from Current TS/TSX File`
9. `Convert Interfaces to Types`

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

### Consolidate Imports via Folder Barrel

- Works on a selected folder that contains `index.ts` or `index.tsx`.
- Runs only for configured UI-folder paths such as `components/ui`, `crc/components/ui`, `shared/ui`, `src/shared/ui`, or `src/shared/components/ui`.
- Prompts for `Current file` or `Workspace` scope.
- The default scope can be configured so you do not have to choose every time.
- Scans imports that target files inside that folder and rewrites them to import from the folder barrel instead.
- Only moves symbols that are actually exported by the folder barrel.
- Leaves non-barreled imports untouched when the symbol is not exported from `index.ts`.
- Ignores anything under `node_modules`.
- Only resolves `.ts` and `.tsx` modules for this refactor.
- Skips test-style targets by default such as `*.test.ts(x)`, `*.spec.ts(x)`, `*.stories.ts(x)`, and common `test` / `tests` / `__tests__` folders.
- Can skip gitignored files during workspace-wide consolidation.
- Supports path-alias imports such as `@/components/ui/button` as well as relative imports.

Example:

```ts
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
```

with a barrel like:

```ts
export { Button } from './button'
export { Label } from './label'
```

becomes:

```ts
import { Button, Label } from '@/components/ui'
import { Card } from '@/components/ui/card'
```

This is mainly intended for `shadcn/ui`-style folders where you want consumers to converge on the barrel import whenever that barrel already exposes the symbol, without touching tests or ignored files unless you opt into that.

### Consolidate Current File Imports to Detected UI Barrel

- Runs from the active `.ts` or `.tsx` file.
- Detects eligible configured UI barrel folders directly from that file's imports.
- If exactly one UI barrel is detected, it uses it immediately.
- If multiple candidate UI barrels are detected, it lets you choose one.
- Reuses the same safety rules as the folder-based barrel consolidation command.

This is the faster option when you are editing one file and do not want to switch back to the Explorer to select a folder first.

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

The extension contributes 6 settings:

- `codeRefinery.rename.updateImports`
  Update TS/JS relative import specifiers in the workspace after file rename.
  Default: `true`
- `codeRefinery.rename.showSummary`
  Show a rename summary after batch operations.
  Default: `true`
- `codeRefinery.rename.revealInExplorer`
  Reveal the renamed file in the Explorer after rename.
  Default: `true`
- `codeRefinery.barrelImports.allowedUiFolders`
  Workspace-relative folder paths that are allowed targets for barrel import consolidation.
  Default: `components/ui`, `crc/components/ui`, `shared/ui`, `src/shared/ui`, `src/shared/components/ui`
- `codeRefinery.barrelImports.excludePatterns`
  Workspace-relative glob patterns excluded from barrel import consolidation.
  Default: `**/__tests__/**`, `**/test/**`, `**/tests/**`, `**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.ts`, `**/*.spec.tsx`, `**/*.stories.ts`, `**/*.stories.tsx`
- `codeRefinery.barrelImports.respectGitIgnore`
  Skip gitignored files during workspace-wide barrel import consolidation.
  Default: `true`
- `codeRefinery.barrelImports.defaultScope`
  Default scope for barrel import consolidation when both `Current file` and `Workspace` are available.
  Default: `ask`

## Where Commands Appear

- Explorer context menu on files:
  `Convert Filename to kebab-case`
- Explorer context menu on folders:
  `Generate index.ts with exports`
  `Consolidate Imports via Folder Barrel`
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
