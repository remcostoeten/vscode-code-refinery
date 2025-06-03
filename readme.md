# VSCode Personal Utilities

Rename files to kebab-case and generate an `index.ts` barrel file exporting all `.ts`/`.tsx` files in a directory.

---

## Features

- **Convert Filename to kebab-case**
  Rename the selected file from `thisCaseName` or `ThisCaseName` to `this-case-name`.

- **Generate index.ts Barrel File**
  Create an `index.ts` file exporting all `.ts` and `.tsx` files in the selected folder:

  ```ts
  export * from './filename';
  ```

## Usage

You can trigger commands via:

- Right-click context menu on files or folders in the Explorer.

- Keyboard shortcuts:
  - Rename file to kebab-case: `Ctrl+Alt+K`
  - Generate index.ts: `Ctrl+Alt+I`

- Command Palette (`Cmd+P` or `Ctrl+P`), search:
  - Convert Filename to kebab-case
  - Generate index.ts with exports

## Installation

Clone the repo or download the extension folder, then:

```bash
npm install
npm run compile
```

Open the folder in VSCode, press `F5` to launch the extension development host, and test commands. Or press `Ctrl+Shift+P` and search for the install extension from location option.

