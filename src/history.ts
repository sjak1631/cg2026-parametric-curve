export type SnapshotGetter = () => any;
export type SnapshotRestorer = (snap: any) => void;

export function createHistory(getSnapshot: SnapshotGetter, restoreSnapshot: SnapshotRestorer) {
    const history: any[] = [];
    let historyIndex = -1;

    const pushHistory = () => {
        const snap = getSnapshot();
        // trim future
        history.splice(historyIndex + 1);
        history.push(snap);
        historyIndex = history.length - 1;
    };

    const undoHistory = () => {
        if (historyIndex <= 0) return;
        historyIndex -= 1;
        const snap = history[historyIndex];
        restoreSnapshot(snap);
    };

    const redoHistory = () => {
        if (historyIndex >= history.length - 1) return;
        historyIndex += 1;
        const snap = history[historyIndex];
        restoreSnapshot(snap);
    };

    return { pushHistory, undoHistory, redoHistory, _debug: { history, get index() { return historyIndex; } } };
}
