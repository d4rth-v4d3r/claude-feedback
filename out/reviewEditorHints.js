"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewEditorHints = void 0;
const vscode = require("vscode");
const store_1 = require("./store");
const PREVIEW_CHARS = 48;
const LENS_CHARS = 40;
function truncate(text, max) {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
function showInlinePending() {
    return vscode.workspace.getConfiguration("codeReview").get("showInlinePending", true);
}
/**
 * Light decorations that complement the native CommentThreads:
 *   - colored gutter icon and overview-ruler tick for any line with a pending review
 *   - end-of-line preview snippet (since the thread itself is collapsible/below the line)
 *   - CodeLens with the comment body, plus an "Add review comment…" lens on the cursor line
 *
 * Disable entirely with `codeReview.showInlinePending: false`.
 */
class ReviewEditorHints {
    constructor(context, getPending) {
        this.context = context;
        this.getPending = getPending;
        this.codeLensEmitter = new vscode.EventEmitter();
        this.disposables = [];
        this.lineDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
            gutterIconPath: vscode.Uri.joinPath(this.context.extensionUri, "media", "review-comment-gutter.svg"),
            gutterIconSize: "contain",
            dark: { backgroundColor: "rgba(234, 179, 8, 0.07)" },
            light: { backgroundColor: "rgba(202, 138, 4, 0.12)" },
        });
        const provider = {
            onDidChangeCodeLenses: this.codeLensEmitter.event,
            provideCodeLenses: (document) => this.provideCodeLenses(document),
        };
        this.disposables.push(this.lineDecoration, vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider), vscode.window.onDidChangeTextEditorSelection(() => this.raiseCodeLens()), vscode.window.onDidChangeActiveTextEditor(() => this.raiseCodeLens()), vscode.workspace.onDidChangeTextDocument((e) => {
            for (const ed of vscode.window.visibleTextEditors) {
                if (ed.document === e.document) {
                    this.refreshDecorations();
                    this.raiseCodeLens();
                    return;
                }
            }
        }), vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()), vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("codeReview.showInlinePending")) {
                this.refresh();
            }
        }));
        this.refresh();
    }
    dispose() {
        vscode.Disposable.from(...this.disposables).dispose();
        this.codeLensEmitter.dispose();
    }
    refresh() {
        this.refreshDecorations();
        this.raiseCodeLens();
    }
    raiseCodeLens() {
        this.codeLensEmitter.fire();
    }
    refreshDecorations() {
        if (!showInlinePending()) {
            for (const editor of vscode.window.visibleTextEditors) {
                editor.setDecorations(this.lineDecoration, []);
            }
            return;
        }
        const pending = this.getPending();
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme !== "file") {
                editor.setDecorations(this.lineDecoration, []);
                continue;
            }
            this.applyDecorations(editor, pending);
        }
    }
    applyDecorations(editor, pending) {
        const fsPath = editor.document.uri.fsPath;
        const forFile = pending.filter((c) => c.filePath === fsPath);
        const opts = forFile.map((c) => {
            const lineIdx = Math.max(0, Math.min(c.line - 1, editor.document.lineCount - 1));
            const lt = editor.document.lineAt(lineIdx);
            const endChar = Math.max(lt.text.length, 1);
            const range = new vscode.Range(lineIdx, 0, lineIdx, endChar);
            const body = (0, store_1.commentBodyForSend)(c);
            const md = new vscode.MarkdownString("", true);
            md.appendMarkdown("**Pending review**\n\n");
            md.appendText(body);
            const preview = truncate(body, PREVIEW_CHARS);
            return {
                range,
                hoverMessage: md,
                renderOptions: {
                    after: {
                        contentText: `    ·  ${preview}`,
                        color: new vscode.ThemeColor("descriptionForeground"),
                        fontStyle: "italic",
                    },
                },
            };
        });
        editor.setDecorations(this.lineDecoration, opts);
    }
    provideCodeLenses(document) {
        if (!showInlinePending() || document.uri.scheme !== "file") {
            return [];
        }
        const lenses = [];
        const fsPath = document.uri.fsPath;
        const pending = this.getPending().filter((c) => c.filePath === fsPath);
        const linesWithPending = new Set(pending.map((c) => c.line));
        for (const c of pending) {
            const lineIdx = Math.max(0, Math.min(c.line - 1, document.lineCount - 1));
            const lt = document.lineAt(lineIdx);
            const endChar = Math.max(lt.text.length, 1);
            const range = new vscode.Range(lineIdx, 0, lineIdx, endChar);
            lenses.push(new vscode.CodeLens(range, {
                title: `$(comment-discussion) ${truncate((0, store_1.commentBodyForSend)(c), LENS_CHARS)}`,
                command: "codeReview.openFileDiff",
                arguments: [document.uri],
                tooltip: "Open diff vs parent branch",
            }));
        }
        const active = vscode.window.activeTextEditor;
        if (!active || active.document.uri.toString() !== document.uri.toString()) {
            return this.sortLenses(lenses);
        }
        const cursorLine = active.selection.active.line;
        const cursorLine1 = cursorLine + 1;
        if (!linesWithPending.has(cursorLine1)) {
            const lt = document.lineAt(cursorLine);
            const endChar = Math.max(lt.text.length, 1);
            const range = new vscode.Range(cursorLine, 0, cursorLine, endChar);
            lenses.push(new vscode.CodeLens(range, {
                title: "$(add) Add review comment…",
                command: "codeReview.addComment",
                arguments: [],
                tooltip: "Add a pending review comment for this line",
            }));
        }
        return this.sortLenses(lenses);
    }
    sortLenses(lenses) {
        return lenses.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
    }
}
exports.ReviewEditorHints = ReviewEditorHints;
//# sourceMappingURL=reviewEditorHints.js.map