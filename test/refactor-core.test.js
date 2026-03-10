const assert = require("node:assert/strict")
const {
    buildTypeAliasFromInterface,
    collectDefaultToNamedReferenceRewrites,
    collectNamedToDefaultReferenceRewrites,
    createSourceFile,
    getTopLevelTypeLikeDecls
} = require("../dist/refactor-core.js")

function applyRewrites(text, rewrites) {
    return [...rewrites]
        .sort((left, right) => right.start - left.start)
        .reduce(
            (acc, rewrite) =>
                acc.slice(0, rewrite.start) + rewrite.replacement + acc.slice(rewrite.end),
            text
        )
}

{
    const text = `
type LocalProps = { foo: string };
`
    const decls = getTopLevelTypeLikeDecls(text)
    assert.equal(decls.length, 1)
    assert.equal(decls[0].name, "LocalProps")
    assert.equal(decls[0].exported, false)
}

{
    const text = `
export type PublicThing = { id: string };
interface LocalProps {
  foo: string;
}
`
    const decls = getTopLevelTypeLikeDecls(text)
    assert.equal(decls.length, 2)
    assert.equal(decls.filter((decl) => !decl.exported).length, 1)
}

{
    const text = `interface Props<T> extends Foo, Bar<T> { baz: T }`
    const decl = getTopLevelTypeLikeDecls(text)[0]
    const conversion = buildTypeAliasFromInterface(text, decl, "Props")
    assert.ok(conversion)
    assert.equal(conversion.replacement, "type Props<T> = Foo & Bar<T> & { baz: T };")
}

{
    const text = `
import Widget from './widget';
import WidgetAlias, { helper } from "./widget";
export { default as WidgetExport } from './widget';
`
    const sourceFile = createSourceFile("/tmp/consumer.ts", text)
    const rewrites = collectDefaultToNamedReferenceRewrites(
        sourceFile,
        new Set(["./widget"]),
        "Widget"
    )
    const updated = applyRewrites(text, rewrites)
    assert.match(updated, /import \{ Widget \} from '\.\/widget';/)
    assert.match(updated, /import \{ Widget as WidgetAlias, helper \} from "\.\/widget";/)
    assert.match(updated, /export \{ Widget as WidgetExport \} from '\.\/widget';/)
}

{
    const text = `
import { Widget } from './widget';
import { Widget as WidgetAlias, helper } from "./widget";
export { Widget as WidgetExport } from './widget';
`
    const sourceFile = createSourceFile("/tmp/consumer.ts", text)
    const rewrites = collectNamedToDefaultReferenceRewrites(
        sourceFile,
        new Set(["./widget"]),
        "Widget"
    )
    const updated = applyRewrites(text, rewrites)
    assert.match(updated, /import Widget from '\.\/widget';/)
    assert.match(updated, /import WidgetAlias, \{ helper \} from "\.\/widget";/)
    assert.match(updated, /export \{ default as WidgetExport \} from '\.\/widget';/)
}

console.log("refactor-core tests passed")
