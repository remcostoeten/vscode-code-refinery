const assert = require("node:assert/strict")
const path = require("node:path")
const { describe, it, before, afterEach } = require("mocha")
const vscode = require("vscode")

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeWorkspaceFile(relativePath, content) {
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath
    const uri = vscode.Uri.file(path.join(workspaceRoot, relativePath))
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"))
    return uri
}

async function readWorkspaceFile(relativePath) {
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath
    const uri = vscode.Uri.file(path.join(workspaceRoot, relativePath))
    const bytes = await vscode.workspace.fs.readFile(uri)
    return Buffer.from(bytes).toString("utf8")
}

async function openFile(relativePath) {
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath
    const uri = vscode.Uri.file(path.join(workspaceRoot, relativePath))
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc, { preview: false })
    return uri
}

async function closeEditors() {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
}

async function runWithoutBlockingMessages(callback) {
    const originalInfo = vscode.window.showInformationMessage
    const originalError = vscode.window.showErrorMessage
    const originalWarning = vscode.window.showWarningMessage

    vscode.window.showInformationMessage = async () => undefined
    vscode.window.showErrorMessage = async () => undefined
    vscode.window.showWarningMessage = async (...args) => {
        const applyOption = args.find((arg) => arg === "Apply")
        return applyOption
    }

    try {
        return await callback()
    } finally {
        vscode.window.showInformationMessage = originalInfo
        vscode.window.showErrorMessage = originalError
        vscode.window.showWarningMessage = originalWarning
    }
}

describe("Refactor commands", () => {
    before(async () => {
        await vscode.extensions.getExtension("remcostoeten.code-refinery")?.activate()
    })

    afterEach(async () => {
        await closeEditors()
    })

    it("fixPropsType renames a single local interface to Props and updates usages", async () => {
        await writeWorkspaceFile(
            "props-eligible.tsx",
            `interface FooProps {\n  value: string;\n}\n\nexport function Widget(props: FooProps) {\n  return props.value;\n}\n`
        )
        const uri = await openFile("props-eligible.tsx")

        await sleep(1200)
        await runWithoutBlockingMessages(() =>
            vscode.commands.executeCommand("file-utils.fixPropsType", uri)
        )
        await sleep(500)

        const updated = await readWorkspaceFile("props-eligible.tsx")
        assert.match(updated, /type Props = \{\n  value: string;\n\};/)
        assert.match(updated, /Widget\(props: Props\)/)
    })

    it("fixPropsType does nothing when the file has two top-level declarations", async () => {
        const original = `export type PublicProps = {\n  id: string;\n};\n\ntype LocalProps = {\n  value: string;\n};\n\nexport function Widget(props: LocalProps): PublicProps {\n  return { id: props.value };\n}\n`
        await writeWorkspaceFile("props-ineligible.ts", original)
        const uri = await openFile("props-ineligible.ts")

        await sleep(1200)
        await runWithoutBlockingMessages(() =>
            vscode.commands.executeCommand("file-utils.fixPropsType", uri)
        )
        await sleep(300)

        const updated = await readWorkspaceFile("props-ineligible.ts")
        assert.equal(updated, original)
    })

    it("convertDefaultToNamed updates the file and workspace imports", async () => {
        await writeWorkspaceFile(
            "widget-default.ts",
            `export default function Widget() {\n  return 1;\n}\n`
        )
        await writeWorkspaceFile(
            "consumer-default.ts",
            `import Widget from './widget-default';\n\nexport const value = Widget();\n`
        )
        const uri = await openFile("widget-default.ts")

        await sleep(1200)
        await runWithoutBlockingMessages(() =>
            vscode.commands.executeCommand("file-utils.convertDefaultToNamed", uri)
        )
        await sleep(500)

        const producer = await readWorkspaceFile("widget-default.ts")
        const consumer = await readWorkspaceFile("consumer-default.ts")
        assert.match(producer, /export function Widget\(\)/)
        assert.match(consumer, /import \{ Widget \} from '\.\/widget-default';/)
    })

    it("convertNamedToDefault updates the file and workspace imports", async () => {
        await writeWorkspaceFile("widget-named.ts", `export function Widget() {\n  return 1;\n}\n`)
        await writeWorkspaceFile(
            "consumer-named.ts",
            `import { Widget } from './widget-named';\n\nexport const value = Widget();\n`
        )
        const uri = await openFile("widget-named.ts")

        await sleep(1200)
        await runWithoutBlockingMessages(() =>
            vscode.commands.executeCommand("file-utils.convertNamedToDefault", uri)
        )
        await sleep(500)

        const producer = await readWorkspaceFile("widget-named.ts")
        const consumer = await readWorkspaceFile("consumer-named.ts")
        assert.match(producer, /export default function Widget\(\)/)
        assert.match(consumer, /import Widget from '\.\/widget-named';/)
    })

    it("convertInterfacesToTypes preserves export on exported interfaces", async () => {
        await writeWorkspaceFile(
            "interfaces.ts",
            `export interface PublicThing {\n  id: string;\n}\n\ninterface LocalThing extends PublicThing {\n  name: string;\n}\n`
        )
        const uri = await openFile("interfaces.ts")

        await sleep(1200)
        await runWithoutBlockingMessages(() =>
            vscode.commands.executeCommand("file-utils.convertInterfacesToTypes", uri)
        )
        await sleep(300)

        const updated = await readWorkspaceFile("interfaces.ts")
        assert.match(updated, /export type PublicThing = \{\n  id: string;\n\};/)
        assert.match(updated, /type LocalThing = PublicThing & \{\n  name: string;\n\};/)
    })
})
