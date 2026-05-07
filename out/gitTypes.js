"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGitApi = getGitApi;
const vscode = require("vscode");
async function getGitApi() {
    const ext = vscode.extensions.getExtension("vscode.git");
    if (!ext) {
        return undefined;
    }
    if (!ext.isActive) {
        try {
            await ext.activate();
        }
        catch {
            return undefined;
        }
    }
    try {
        return ext.exports.getAPI(1);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=gitTypes.js.map