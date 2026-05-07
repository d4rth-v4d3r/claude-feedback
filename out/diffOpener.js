"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openFileDiffVsParent = openFileDiffVsParent;
const vscode = require("vscode");
const path = require("node:path");
const gitTypes_1 = require("./gitTypes");
/**
 * Opens `vscode.diff(parent@mergeBase, workingTree)` for `fileUri`. The
 * working-tree side is the live file, so any review CommentThreads we
 * created are anchored on the right side of the diff for free.
 *
 * If we can't compute a merge-base (e.g. the file is outside any repo, or
 * `origin/HEAD` is unset and no override is configured), we fall back to
 * just opening the file.
 */
async function openFileDiffVsParent(fileUri, resolver) {
    const parent = await resolver.resolve(fileUri);
    if (!parent) {
        await vscode.window.showTextDocument(fileUri, { preview: false });
        return;
    }
    const git = await (0, gitTypes_1.getGitApi)();
    if (!git) {
        await vscode.window.showTextDocument(fileUri, { preview: false });
        return;
    }
    const leftUri = git.toGitUri(fileUri, parent.mergeBaseSha);
    const baseName = path.basename(fileUri.fsPath);
    const shortRef = parent.parentRef.replace(/^refs\/(heads|remotes)\//, "");
    const title = `${baseName} (${shortRef} ↔ ${parent.branchName})`;
    await vscode.commands.executeCommand("vscode.diff", leftUri, fileUri, title, {
        preview: false,
    });
}
//# sourceMappingURL=diffOpener.js.map