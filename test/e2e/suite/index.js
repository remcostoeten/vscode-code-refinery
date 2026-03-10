const path = require("node:path")
const Mocha = require("mocha")

async function run() {
    const mocha = new Mocha({
        ui: "bdd",
        color: true,
        timeout: 30000
    })

    mocha.addFile(path.resolve(__dirname, "./refactor-commands.test.js"))

    await new Promise((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} test(s) failed.`))
                return
            }
            resolve()
        })
    })
}

module.exports = { run }
