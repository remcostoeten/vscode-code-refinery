# VSCode Personal Utilities

Rename files to kebab-case and generate an `index.ts` barrel file exporting all `.ts`/`.tsx` files in a directory.

---

## Features

- **Convert Filename to kebab-case**
  Rename the selected file (or multiple selected files) from `thisCaseName` or `ThisCaseName` to `this-case-name`.
  When enabled, the extension also updates relative import specifiers in your workspace that reference the renamed file.

- **Rename Local Type/Interface to Props**
  For `.ts`/`.tsx` files, renames a single local (non-exported) `type`/`interface` to `Props`.
  If the local declaration is an `interface`, it is converted to `type Props = ...`:
  - If the file has exactly 1 type/interface and it is not exported: rename to `Props`.

- **Convert Default Export to Named Export**
  For `.ts`/`.tsx` files, previews and converts supported default exports to named exports and updates TS/TSX import and re-export sites in the workspace.

- **Convert Named Export to Default Export**
  For `.ts`/`.tsx` files, previews and converts a single supported named value export to a default export and updates TS/TSX import and re-export sites in the workspace.

- **Remove Unused from Current TS/TSX File**
  Previews and removes unused code from the current file with focused options for:
  - all
  - imports
  - types/interfaces
  - exports
  - functions
  - variables

- **Convert Interfaces to Types**
  Converts top-level interfaces to type aliases where safe. It skips merged interfaces and default-exported interfaces.

- **Generate index.ts Barrel File**
  Create an `index.ts` file exporting all `.ts` and `.tsx` files in the selected folder:

  ```ts
  export * from './filename';
  ```

## Settings

- `codeRefinery.rename.updateImports`: Update TS/JS relative import specifiers after renaming files (default: `true`).
- `codeRefinery.rename.showSummary`: Show a summary message after batch renames (default: `true`).
- `codeRefinery.rename.revealInExplorer`: Reveal the renamed file in the Explorer (default: `true`).

## Usage

You can trigger commands via:

- Right-click context menu on files or folders in the Explorer.

- Keyboard shortcuts:
  - Rename file to kebab-case: `Ctrl+Alt+K`
  - Generate index.ts: `Ctrl+Alt+I`

- Command Palette (`Cmd+P` or `Ctrl+P`), search:
  - Convert Filename to kebab-case
  - Generate index.ts with exports
  - Rename Local Type/Interface to Props
  - Convert Default Export to Named Export
  - Convert Named Export to Default Export
  - Remove Unused from Current TS/TSX File
  - Convert Interfaces to Types

## Installation

Clone the repo or download the extension folder, then:

```bash
npm install
npm run compile
```

Open the folder in VSCode, press `F5` to launch the extension development host, and test commands. Or press `Ctrl+Shift+P` and search for the install extension from location option.
