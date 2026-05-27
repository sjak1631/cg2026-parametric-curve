import "./styles.css";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { generateBezierCurveCasteljauN, generateCatmullRomSplineSegment, generateNURBSCurve } from "./curve";
import { createParameterValues } from "./parameterization";
import { createThreeRenderer } from "./threeRenderer";

// painter mode で扱うツール種別
type Tool = "spline" | "bezier2" | "bezier3" | "nurbs" | "edit" | "eraser" | "handwrite";

// 完成済み曲線の論理データ（線修正モード等で参照する）
type StoredCurve =
    | {
        kind: "spline-uniform";
        controlPoints: { x: number; y: number }[]; // 通る点列 (>=4)
        closed?: boolean;
    }
    | {
        kind: "bezier";
        degree: 2 | 3;
        // ベジェ各セグメントの制御点列。stride = degree で連結。
        controlPoints: { x: number; y: number }[];
        closed?: boolean;
    }
    | {
        kind: "nurbs";
        // クリック順の制御点。役割 (通る/通らない) は
        // 末尾を起点とした交互パターンで UI 側が決定する。
        controlPoints: { x: number; y: number }[];
        weights?: number[];
        closed?: boolean;
    }
    | {
        kind: "handwrite";
        points: { x: number; y: number }[];
    };

const SEGMENTS = 96;
const TRACE_LAYER_ORDER = -1;

export default function PainterApp() {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [tool, setTool] = useState<Tool>("spline");
    const toolRef = useRef<Tool>("spline");
    const [bezierDegree, setBezierDegree] = useState<2 | 3>(3);
    const bezierDegreeRef = useRef<2 | 3>(3);
    const [hasTrace, setHasTrace] = useState(false);
    const [hoverInfo, setHoverInfo] = useState<string>("");
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    const [traceVisible, setTraceVisible] = useState(true);

    // 外部呼出し用 refs
    const resetInProgressRef = useRef<() => void>(() => { });
    const undoRef = useRef<() => void>(() => { });
    const redoRef = useRef<() => void>(() => { });
    const resetViewRef = useRef<() => void>(() => { });
    const saveCurvesRef = useRef<() => void>(() => { });
    const loadCurvesRef = useRef<(data: StoredCurve[]) => void>(() => { });
    const curveFileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        toolRef.current = tool;
        resetInProgressRef.current?.();
    }, [tool]);

    useEffect(() => {
        bezierDegreeRef.current = bezierDegree;
        resetInProgressRef.current?.();
    }, [bezierDegree]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const api = createThreeRenderer(container) as any;
        const dom: HTMLCanvasElement = api.domElement;
        const camera: THREE.OrthographicCamera = api.camera;

        // --- 完成済み曲線（"ラスター扱い" = 操作不可な確定線分） ---
        const storedCurves: StoredCurve[] = [];

        // --- 進行中の状態 ---
        // spline: 通る点列を蓄積。常に末尾4点で uniform Catmull-Rom セグメント描画。
        let splinePoints: THREE.Vector3[] = [];
        // bezier2: ユーザクリック点 = [A(通る点), C1, C2, ...] (1点目以外はすべて「通らない制御点」)
        // 曲線上の通過点は連続する制御点の中点とする。
        // bezier2Expanded: 実際のセグメントを stride=2 で表す拡張列 [A, C1, M12, C2, M23, ...]
        let bezier2Points: THREE.Vector3[] = [];
        let bezier2Expanded: THREE.Vector3[] = [];
        // bezier3: drag ごとに 1つの「通るアンカー」を作る。
        //   - drag 始点 = anchor (曲線上の点)
        //   - drag 終点 = forward handle (次セグメント側の「通らない制御点」)
        //   - back  handle = 2*anchor - forward （forward の反対ベクトル）
        // bezier3Expanded: stride=3 の三次ベジェ接続点列 [A_0, F_0, B_1, A_1, F_1, B_2, A_2, ...]
        let bezier3Anchors: { anchor: THREE.Vector3; forward: THREE.Vector3 }[] = [];
        let bezier3Expanded: THREE.Vector3[] = [];

        // nurbs: クリック順の制御点列。Finish まで全点を表示し、
        // ドラッグで個別に位置調整可能。
        // 役割: 末尾を起点とし (N-1-i) % 2 === 0 なら「通る点」、
        //         そうでなければ「通らない点」として色分けする。
        let nurbsPoints: THREE.Vector3[] = [];
        // 進行中にドラッグしている制御点の index（ドラッグ中以外は null）
        let nurbsDragIndex: number | null = null;
        const NURBS_PICK_RADIUS_PX = 10;

        // handwrite: 左クリック長押しで線を描く
        let handwritePoints: THREE.Vector3[] = [];
        let isHandwriting = false;

        // ホバープレビュー用のマウスワールド位置
        let lastMouseWorld: THREE.Vector3 | null = null;

        // live (in-progress) と committed の区別は addLine/addPoint の発行順で管理する。
        // 常に「committed が先 → live が末尾」の順を保つため、新たに描画する前に live を全消ししてから
        // commit → live を追加する。
        let liveLineCount = 0;
        let livePointCount = 0;
        const drawLiveLine = (pts: THREE.Vector3[], color: number) => {
            api.addLine(pts, color);
            liveLineCount += 1;
        };
        const drawLivePoint = (p: THREE.Vector3, color: number) => {
            api.addPoint(p, new THREE.Color(color));
            livePointCount += 1;
        };
        const clearLiveAll = () => {
            for (let i = 0; i < liveLineCount; i++) api.removeLastLine();
            for (let i = 0; i < livePointCount; i++) api.removeLastPointObject();
            liveLineCount = 0;
            livePointCount = 0;
        };

        // --- 確定済み曲線の描画オブジェクト数（undo を限定的に許す場合に使用、ここでは最低限） ---
        let committedLineCount = 0;
        const commitLine = (pts: THREE.Vector3[], color: number) => {
            api.addLine(pts, color);
            committedLineCount += 1;
        };

        // 確定描画は live より前に並ぶため、live を消すときは末尾から消せば OK。

        const v3 = (x: number, y: number) => new THREE.Vector3(x, y, 0);

        // ---- 再描画（live のみ） ----
        // 注意: 呼び出し側で必ず clearLiveAll() を済ませてから呼ぶこと。
        // ここでは live の再描画のみを行う（commit 済みオブジェクトを末尾から誤って削除しないため）。
        const redrawLive = () => {
            const t = toolRef.current;
            if (t === "spline") {
                // 制御点
                for (const p of splinePoints) drawLivePoint(p, 0xff0000);
                // 制御ポリゴン
                if (splinePoints.length >= 2) {
                    drawLiveLine([...splinePoints], 0xbfc7d5);
                }
                // 端点側のセグメントを仮想点で常時補完描画する:
                //   先頭: 仮想点 V_start = 2·p[0] - p[1] を p[0] の前に置く
                //   末尾: 仮想点 V_end   = 2·p[n-1] - p[n-2] を p[n-1] の後に置く
                const nSp = splinePoints.length;
                if (nSp >= 2) {
                    const p0 = splinePoints[0];
                    const p1 = splinePoints[1];
                    const Vs = new THREE.Vector3(
                        2 * p0.x - p1.x,
                        2 * p0.y - p1.y,
                        0
                    );
                    const pLast = splinePoints[nSp - 1];
                    const pPrev = splinePoints[nSp >= 2 ? nSp - 2 : 0];
                    const hovering = lastMouseWorld && !isLeftDragging && !isPanning;
                    // 末尾の第4制御点: ホバー中はカーソルを採用してホバープレビューと接続を滑らかに
                    const Ve = hovering
                        ? (lastMouseWorld as THREE.Vector3)
                        : new THREE.Vector3(
                            2 * pLast.x - pPrev.x,
                            2 * pLast.y - pPrev.y,
                            0
                        );
                    // 先頭セグメント [V_s, p0, p1, P3]
                    const p3First = nSp >= 3 ? splinePoints[2] : Ve;
                    const [tf0, tf1, tf2, tf3] = createParameterValues([Vs, p0, p1, p3First], "centripetal");
                    const segFirst = generateCatmullRomSplineSegment(
                        Vs, p0, p1, p3First, tf0, tf1, tf2, tf3, SEGMENTS
                    );
                    drawLiveLine(segFirst, 0x1f2937);
                    // 末尾セグメント [P0, p[n-2], p[n-1], V_e] (n=2 の場合は先頭と一致するので省略)
                    if (nSp >= 3) {
                        const p0Last = nSp >= 4 ? splinePoints[nSp - 3] : Vs;
                        const [tl0, tl1, tl2, tl3] = createParameterValues([p0Last, pPrev, pLast, Ve], "centripetal");
                        const segLast = generateCatmullRomSplineSegment(
                            p0Last, pPrev, pLast, Ve, tl0, tl1, tl2, tl3, SEGMENTS
                        );
                        drawLiveLine(segLast, 0x1f2937);
                    }
                }
                // ホバープレビュー:
                //   カーソル C を「仮の次点」とし、
                //   さらに「仮想的に一つ先の点」V = 2C - p_last (倍ベクトル) を追加して
                //   カーソル直結のセグメントを Catmull-Rom で描画する。
                if (lastMouseWorld && !isLeftDragging && !isPanning) {
                    const n = splinePoints.length;
                    const C = lastMouseWorld;
                    if (n === 1) {
                        drawLiveLine([splinePoints[0], C], 0x2563eb);
                        drawLivePoint(C, 0xfca5a5);
                    } else if (n >= 2) {
                        const last = splinePoints[n - 1];
                        // 仮想点 V はカーソルから前方に倍ベクトル伸ばした位置
                        const V = new THREE.Vector3(
                            2 * C.x - last.x,
                            2 * C.y - last.y,
                            0
                        );
                        // セグメント p[n-1]→C: 制御 [p[n-2], p[n-1], C, V]
                        // n=2 のときは p[n-2] が無いので V_start を代用
                        const prev = n >= 3
                            ? splinePoints[n - 2]
                            : new THREE.Vector3(
                                2 * splinePoints[0].x - splinePoints[1].x,
                                2 * splinePoints[0].y - splinePoints[1].y,
                                0
                            );
                        const [th0, th1, th2, th3] = createParameterValues([prev, last, C, V], "centripetal");
                        const seg = generateCatmullRomSplineSegment(
                            prev, last, C, V, th0, th1, th2, th3, SEGMENTS
                        );
                        drawLiveLine(seg, 0x2563eb);
                        drawLivePoint(C, 0xfca5a5);
                    }
                }
            } else if (t === "bezier2") {
                // ユーザクリック点: index 0 = 通るアンカー(赤), それ以外 = 通らない制御点(青)
                for (let i = 0; i < bezier2Points.length; i++) {
                    drawLivePoint(bezier2Points[i], i === 0 ? 0xff0000 : 0x0000ff);
                }
                // 制御ポリゴン A → C1 → C2 ...
                if (bezier2Points.length >= 2) drawLiveLine([...bezier2Points], 0xbfc7d5);
                // 暗黙の通過点（連続する C_i, C_{i+1} の中点）を赤で表示
                for (let i = 1; i + 1 < bezier2Points.length; i++) {
                    const a = bezier2Points[i];
                    const b = bezier2Points[i + 1];
                    const m = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
                    drawLivePoint(m, 0xff0000);
                }
                // ホバープレビュー: カーソル位置を次の制御点 C_{k+1} とした場合のセグメントを付属描画
                if (lastMouseWorld && bezier2Points.length >= 1) {
                    const cursor = lastMouseWorld;
                    const k = bezier2Points.length - 1;
                    const Ck = bezier2Points[k];
                    if (k === 0) {
                        // まだ A しか無い。次クリックで C1 になるためセグメントは作れない
                        drawLiveLine([Ck, cursor], 0xdbeafe);
                    } else {
                        const prevLast = bezier2Expanded.length > 0
                            ? bezier2Expanded[bezier2Expanded.length - 1]
                            : bezier2Points[0];
                        const mid = new THREE.Vector3((Ck.x + cursor.x) / 2, (Ck.y + cursor.y) / 2, 0);
                        const seg = generateBezierCurveCasteljauN([prevLast, Ck, mid], 2, SEGMENTS);
                        drawLiveLine(seg, 0x2563eb);
                        drawLivePoint(mid, 0xfca5a5);
                        drawLiveLine([Ck, cursor], 0xdbeafe);
                    }
                }
            } else if (t === "bezier3") {
                // 確定済みアンカー列：anchor (赤) / forward, back (青) / ハンドルポリゴン
                for (const a of bezier3Anchors) {
                    drawLivePoint(a.anchor, 0xff0000);
                    if (!a.forward.equals(a.anchor)) {
                        const back = new THREE.Vector3(
                            2 * a.anchor.x - a.forward.x,
                            2 * a.anchor.y - a.forward.y,
                            0
                        );
                        drawLivePoint(a.forward, 0x0000ff);
                        drawLivePoint(back, 0x0000ff);
                        drawLiveLine([back, a.anchor, a.forward], 0xbfc7d5);
                    }
                }                // ホバープレビュー（ドラッグ前）: 最後のアンカーからカーソルへのプレビュー
                if (!isLeftDragging && lastMouseWorld && bezier3Anchors.length >= 1) {
                    const lastA = bezier3Anchors[bezier3Anchors.length - 1];
                    const color = snapActive ? 0x22c55e : 0x2563eb;
                    const seg = generateBezierCurveCasteljauN(
                        [lastA.anchor, lastA.forward, lastMouseWorld, lastMouseWorld],
                        3,
                        SEGMENTS
                    );
                    drawLiveLine(seg, color);
                    drawLivePoint(lastMouseWorld, snapActive ? 0x22c55e : 0xfca5a5);
                }                // ドラッグ中の暫定描画
                if (isLeftDragging && dragStartWorld && lastMouseWorld) {
                    const anchor = dragStartWorld;
                    const fwd = lastMouseWorld;
                    const back = new THREE.Vector3(
                        2 * anchor.x - fwd.x,
                        2 * anchor.y - fwd.y,
                        0
                    );
                    drawLivePoint(anchor, 0xff0000);
                    if (!fwd.equals(anchor)) {
                        drawLivePoint(fwd, 0x0000ff);
                        drawLivePoint(back, 0x0000ff);
                        drawLiveLine([back, anchor, fwd], 0xbfc7d5);
                    }
                    // 直前アンカーとの間の暫定三次セグメントを描画
                    if (bezier3Anchors.length >= 1) {
                        const prev = bezier3Anchors[bezier3Anchors.length - 1];
                        const seg = generateBezierCurveCasteljauN(
                            [prev.anchor, prev.forward, back, anchor],
                            3,
                            SEGMENTS
                        );
                        drawLiveLine(seg, 0x2563eb);
                    }
                }
            } else if (t === "nurbs") {
                // 全制御点を表示。役割：末尾起点で交互 (P/N)
                const N = nurbsPoints.length;
                for (let i = 0; i < N; i++) {
                    const passing = ((N - 1 - i) % 2) === 0;
                    drawLivePoint(nurbsPoints[i], passing ? 0xff0000 : 0x0000ff);
                }
                // 制御ポリゴン
                if (N >= 2) drawLiveLine([...nurbsPoints], 0xbfc7d5);
                // ダミー曲線（本実装までは制御点をそのまま結ぶ折れ線）
                if (N >= 2) {
                    const samples = generateNURBSCurve([...nurbsPoints]);
                    if (samples.length >= 2) drawLiveLine(samples, 0x2563eb);
                }
            } else if (t === "handwrite") {
                // 手書き: 線を描画
                if (handwritePoints.length >= 2) {
                    drawLiveLine([...handwritePoints], 0x1f2937);
                }
            }
        };

        resetInProgressRef.current = () => {
            splinePoints = [];
            bezier2Points = [];
            bezier2Expanded = [];
            bezier3Anchors = [];
            bezier3Expanded = [];
            nurbsPoints = [];
            nurbsDragIndex = null;
            handwritePoints = [];
            isHandwriting = false;
            hasFirstPoint = false;
            closingDragStarted = false;
            inProgressUndoStack.length = 0;
            inProgressRedoStack.length = 0;
            updateUndoRedoState();
            clearLiveAll();
            redrawLive();
        };

        // ---- 確定処理（"Finish" 相当） ----
        const finishCurrent = () => {
            const t = toolRef.current;
            // undo 可能な操作なのでスナップショットを保存
            const hasWork =
                (t === "spline" && splinePoints.length >= 2) ||
                (t === "bezier2" && bezier2Expanded.length >= 3) ||
                (t === "bezier3" && bezier3Expanded.length >= 4) ||
                (t === "nurbs" && nurbsPoints.length >= 2);
            if (hasWork) snapshotForUndo();
            inProgressUndoStack.length = 0; // 描画中の undo/redo 履歴はクリア
            inProgressRedoStack.length = 0;
            clearLiveAll();
            if (t === "spline") {
                // 中間セグメントはクリックごとに commit 済み。端点側の仮想点補完セグメントを
                // commit して確定線として残す。
                const nSp = splinePoints.length;
                const isClosed = nSp >= 2 &&
                    Math.hypot(
                        splinePoints[nSp - 1].x - splinePoints[0].x,
                        splinePoints[nSp - 1].y - splinePoints[0].y
                    ) < 1e-6;
                if (nSp >= 2) {
                    const p0 = splinePoints[0];
                    const p1 = splinePoints[1];
                    const Vs = new THREE.Vector3(
                        2 * p0.x - p1.x,
                        2 * p0.y - p1.y,
                        0
                    );
                    const pLast = splinePoints[nSp - 1];
                    const pPrev = splinePoints[nSp - 2];
                    const Ve = new THREE.Vector3(
                        2 * pLast.x - pPrev.x,
                        2 * pLast.y - pPrev.y,
                        0
                    );
                    const p3First = nSp >= 3 ? splinePoints[2] : Ve;
                    const [tf0c, tf1c, tf2c, tf3c] = createParameterValues([Vs, p0, p1, p3First], "centripetal");
                    const segFirst = generateCatmullRomSplineSegment(
                        Vs, p0, p1, p3First, tf0c, tf1c, tf2c, tf3c, SEGMENTS
                    );
                    commitLine(segFirst, 0x1f2937);
                    if (nSp >= 3) {
                        const p0Last = nSp >= 4 ? splinePoints[nSp - 3] : Vs;
                        const [tl0c, tl1c, tl2c, tl3c] = createParameterValues([p0Last, pPrev, pLast, Ve], "centripetal");
                        const segLast = generateCatmullRomSplineSegment(
                            p0Last, pPrev, pLast, Ve, tl0c, tl1c, tl2c, tl3c, SEGMENTS
                        );
                        commitLine(segLast, 0x1f2937);
                    }
                }
                if (nSp >= 4) {
                    storedCurves.push({
                        kind: "spline-uniform",
                        controlPoints: splinePoints.map((p) => ({ x: p.x, y: p.y })),
                        closed: isClosed,
                    });
                }
                splinePoints = [];
            } else if (t === "bezier2") {
                // セグメントはクリックごとに都度 commit 済み。全体を一つの StoredCurve として出力する。
                if (bezier2Expanded.length >= 3) {
                    const isClosed = Math.hypot(
                        bezier2Expanded[bezier2Expanded.length - 1].x - bezier2Expanded[0].x,
                        bezier2Expanded[bezier2Expanded.length - 1].y - bezier2Expanded[0].y
                    ) < 1e-6;
                    storedCurves.push({
                        kind: "bezier",
                        degree: 2,
                        controlPoints: bezier2Expanded.map((p) => ({ x: p.x, y: p.y })),
                        closed: isClosed,
                    });
                }
                bezier2Points = [];
                bezier2Expanded = [];
            } else if (t === "bezier3") {
                // セグメントはドラッグごとに都度 commit 済み。全体を一つの StoredCurve として出力する。
                if (bezier3Expanded.length >= 4) {
                    const isClosed = Math.hypot(
                        bezier3Expanded[bezier3Expanded.length - 1].x - bezier3Expanded[0].x,
                        bezier3Expanded[bezier3Expanded.length - 1].y - bezier3Expanded[0].y
                    ) < 1e-6;
                    storedCurves.push({
                        kind: "bezier",
                        degree: 3,
                        controlPoints: bezier3Expanded.map((p) => ({ x: p.x, y: p.y })),
                        closed: isClosed,
                    });
                }
                bezier3Anchors = [];
                bezier3Expanded = [];
            } else if (t === "nurbs") {
                // 進行中は live だけなので commit 済みラインは無い。
                // 曲線データを storedCurves に追加し、sampleCurve 経由で描画されるようにする。
                if (nurbsPoints.length >= 2) {
                    const n = nurbsPoints.length;
                    const isClosed = n >= 3 && Math.hypot(
                        nurbsPoints[n - 1].x - nurbsPoints[0].x,
                        nurbsPoints[n - 1].y - nurbsPoints[0].y
                    ) < 1e-6;
                    storedCurves.push({
                        kind: "nurbs",
                        controlPoints: nurbsPoints.map((p) => ({ x: p.x, y: p.y })),
                        closed: isClosed,
                    });
                    const samples = generateNURBSCurve(nurbsPoints.map((p) => p.clone()));
                    if (samples.length >= 2) commitLine(samples, 0x1f2937);
                }
                nurbsPoints = [];
                nurbsDragIndex = null;
            } else if (t === "handwrite") {
                // 手書きストロークを保存
                if (handwritePoints.length >= 2) {
                    storedCurves.push({
                        kind: "handwrite",
                        points: handwritePoints.map((p) => ({ x: p.x, y: p.y })),
                    });
                    const samples = [...handwritePoints];
                    if (samples.length >= 2) commitLine(samples, 0x1f2937);
                }
                handwritePoints = [];
                isHandwriting = false;
            }
            hasFirstPoint = false;
            redrawLive();
        };

        // ---- マウス操作 ----
        let isPanning = false;
        let panPrevX = 0;
        let panPrevY = 0;

        // bezier3 用ドラッグ状態
        let isLeftDragging = false;
        let dragStartWorld: THREE.Vector3 | null = null;
        let dragMoved = false;
        let closingDragStarted = false;

        const screenToWorld = (cx: number, cy: number) => api.screenToWorld(cx, cy) as THREE.Vector3;

        const onMouseDown = (ev: MouseEvent) => {
            if (ev.button === 2) {
                // 右クリックで pan
                isPanning = true;
                panPrevX = ev.clientX;
                panPrevY = ev.clientY;
                return;
            }
            if (ev.button === 0) {
                // 引き寄せ判定を適用したワールド座標を取得
                let world = screenToWorld(ev.clientX, ev.clientY);
                const t = toolRef.current;
                // ダブルクリックで現在の描画中曲線を確定
                if (ev.detail >= 2 && t !== "edit" && t !== "eraser") {
                    finishCurrent();
                    return;
                }
                if (hasFirstPoint && snapActive && lastMouseWorld) {
                    // onMouseMove で計算済みのスナップ済み座標をそのまま使用
                    world = lastMouseWorld.clone();
                }
                if (t === "bezier3") {
                    if (!hasFirstPoint) {
                        hasFirstPoint = true;
                        firstPointScreenX = ev.clientX;
                        firstPointScreenY = ev.clientY;
                    }
                    saveInProgressSnapshot();
                    isLeftDragging = true;
                    dragStartWorld = world.clone();
                    dragMoved = false;
                    // 最初のアンカーにスナップ中 = 閉じる意図
                    closingDragStarted = snapActive && bezier3Anchors.length >= 1;
                } else if (t === "spline") {
                    if (!hasFirstPoint) {
                        hasFirstPoint = true;
                        firstPointScreenX = ev.clientX;
                        firstPointScreenY = ev.clientY;
                    }
                    saveInProgressSnapshot();
                    // 旧 live を消してから commit → 新 live を描く順序を厳守
                    clearLiveAll();
                    splinePoints.push(world);
                    // n>=4 で新しいセグメント (p[n-4..n-1] → 中間 p[n-3]-p[n-2]) を確定描画
                    if (splinePoints.length >= 4) {
                        const n = splinePoints.length;
                        const [tc0, tc1, tc2, tc3] = createParameterValues(
                            [splinePoints[n - 4], splinePoints[n - 3], splinePoints[n - 2], splinePoints[n - 1]], "centripetal"
                        );
                        const seg = generateCatmullRomSplineSegment(
                            splinePoints[n - 4], splinePoints[n - 3], splinePoints[n - 2], splinePoints[n - 1],
                            tc0, tc1, tc2, tc3, SEGMENTS
                        );
                        commitLine(seg, 0x1f2937);
                    }
                    // スナップ中のクリック（= 始点に閉じる）→ 自動 Finish
                    const nSpNow = splinePoints.length;
                    if (nSpNow >= 3 &&
                        splinePoints[nSpNow - 1].distanceTo(splinePoints[0]) < 1e-6) {
                        finishCurrent();
                    } else {
                        redrawLive();
                    }
                } else if (t === "bezier2") {
                    if (!hasFirstPoint) {
                        hasFirstPoint = true;
                        firstPointScreenX = ev.clientX;
                        firstPointScreenY = ev.clientY;
                    }
                    saveInProgressSnapshot();
                    clearLiveAll();
                    bezier2Points.push(world);
                    const k = bezier2Points.length - 1;
                    // クリック一回ごとに、k>=2 なら新しいセグメント [prevLast, C_{k-1}, M(C_{k-1}, C_k)] を commit。
                    if (k >= 2) {
                        const Ckm1 = bezier2Points[k - 1];
                        const Ck = bezier2Points[k];
                        const M = new THREE.Vector3((Ckm1.x + Ck.x) / 2, (Ckm1.y + Ck.y) / 2, 0);
                        if (bezier2Expanded.length === 0) {
                            bezier2Expanded.push(bezier2Points[0].clone());
                        }
                        const prevLast = bezier2Expanded[bezier2Expanded.length - 1];
                        bezier2Expanded.push(Ckm1.clone(), M.clone());
                        const seg = generateBezierCurveCasteljauN([prevLast, Ckm1, M], 2, SEGMENTS);
                        commitLine(seg, 0x1f2937);
                    }
                    // スナップ中のクリック（= 始点に閉じる）→ 自動 Finish
                    if (snapActive && k >= 2) {
                        finishCurrent();
                        return;
                    }
                    redrawLive();
                } else if (t === "nurbs") {
                    // Ctrl + 左クリック: 既存制御点のドラッグ編集
                    // 通常の左クリック: 新規制御点を追加
                    if (ev.ctrlKey || ev.metaKey) {
                        let hitIdx = -1;
                        let bestDist = NURBS_PICK_RADIUS_PX;
                        for (let i = 0; i < nurbsPoints.length; i++) {
                            const s = worldToScreen(nurbsPoints[i]);
                            const d = Math.hypot(s.x - ev.clientX, s.y - ev.clientY);
                            if (d < bestDist) { bestDist = d; hitIdx = i; }
                        }
                        if (hitIdx >= 0) {
                            saveInProgressSnapshot();
                            nurbsDragIndex = hitIdx;
                            isLeftDragging = true;
                            dragStartWorld = nurbsPoints[hitIdx].clone();
                            dragMoved = false;
                        }
                        // ヒットしなかった場合は何もしない（Ctrl+クリックでは新規追加しない）
                    } else {
                        if (!hasFirstPoint) {
                            hasFirstPoint = true;
                            firstPointScreenX = ev.clientX;
                            firstPointScreenY = ev.clientY;
                        }
                        saveInProgressSnapshot();
                        clearLiveAll();
                        nurbsPoints.push(world);
                        redrawLive();
                    }
                } else if (t === "edit") {
                    if (!ev.shiftKey && !ev.altKey) {
                        const cpHit = findNearestDraggableCP(world);
                        if (cpHit) {
                            snapshotForUndo();
                            editDragging = { curveIndex: cpHit.curveIndex, cpIndex: cpHit.cpIndex };
                            showEditOverlay(cpHit.curveIndex);
                            return;
                        }
                    }
                    handleEditClick(world, ev.shiftKey, ev.altKey);
                } else if (t === "eraser") {
                    const hit = findNearestEditTarget(world);
                    if (hit) {
                        snapshotForUndo();
                        storedCurves.splice(hit.curveIndex, 1);
                        redrawAllCommitted();
                    }
                } else if (t === "handwrite") {
                    if (!hasFirstPoint) {
                        hasFirstPoint = true;
                        firstPointScreenX = ev.clientX;
                        firstPointScreenY = ev.clientY;
                        saveInProgressSnapshot();
                    }
                    isHandwriting = true;
                    clearLiveAll();
                    handwritePoints.push(world);
                    redrawLive();
                }
            }
        };

        // 開始点（スクリーン座標）と現在位置の距離でスナップ判定
        let firstPointScreenX = 0;
        let firstPointScreenY = 0;
        let hasFirstPoint = false;
        let snapActive = false;
        const SNAP_DISTANCE_PX = 10;

        const worldToScreen = (world: THREE.Vector3): { x: number; y: number } => {
            const pos = world.clone();
            pos.project(camera);
            const w = Math.max(container.clientWidth, 1);
            const h = Math.max(container.clientHeight, 1);
            return {
                x: (pos.x * 0.5 + 0.5) * w,
                y: (0.5 - pos.y * 0.5) * h,
            };
        };

        const onMouseMove = (ev: MouseEvent) => {
            // マウスワールド座標を常時トラックしてホバープレビュー更新に使う
            let rawWorld = screenToWorld(ev.clientX, ev.clientY);

            snapActive = false;
            const tSnap = toolRef.current;
            if (tSnap === "bezier2" && bezier2Points.length >= 2) {
                // 通る制御点（中点 M = (Ck + cursor) / 2）が始点アンカーに近いかチェック
                const Ck = bezier2Points[bezier2Points.length - 1];
                const firstAnchor = bezier2Points[0];
                const firstScreen = worldToScreen(firstAnchor);
                const CkScreen = worldToScreen(Ck);
                const midScreenX = (CkScreen.x + ev.clientX) / 2;
                const midScreenY = (CkScreen.y + ev.clientY) / 2;
                if (Math.hypot(midScreenX - firstScreen.x, midScreenY - firstScreen.y) <= SNAP_DISTANCE_PX) {
                    rawWorld = new THREE.Vector3(2 * firstAnchor.x - Ck.x, 2 * firstAnchor.y - Ck.y, 0);
                    snapActive = true;
                }
            } else if (tSnap === "spline" && splinePoints.length >= 2) {
                // spline: マウスが最初の点の現在スクリーン位置に近いかチェック
                const firstScreen = worldToScreen(splinePoints[0]);
                const screenDist = Math.hypot(ev.clientX - firstScreen.x, ev.clientY - firstScreen.y);
                if (screenDist <= SNAP_DISTANCE_PX) {
                    rawWorld = splinePoints[0].clone();
                    snapActive = true;
                }
            } else if (tSnap === "bezier3" && bezier3Anchors.length >= 1) {
                // bezier3: マウスが最初のアンカーの現在スクリーン位置に近いかチェック
                const firstScreen = worldToScreen(bezier3Anchors[0].anchor);
                const screenDist = Math.hypot(ev.clientX - firstScreen.x, ev.clientY - firstScreen.y);
                if (screenDist <= SNAP_DISTANCE_PX) {
                    rawWorld = bezier3Anchors[0].anchor.clone();
                    snapActive = true;
                }
            }
            lastMouseWorld = rawWorld;

            if (isPanning) {
                const dx = ev.clientX - panPrevX;
                const dy = ev.clientY - panPrevY;
                const w = Math.max(container.clientWidth, 1);
                const h = Math.max(container.clientHeight, 1);
                const wdx = -(dx / w) * (camera.right - camera.left);
                const wdy = (dy / h) * (camera.top - camera.bottom);
                camera.left += wdx;
                camera.right += wdx;
                camera.top += wdy;
                camera.bottom += wdy;
                camera.updateProjectionMatrix();
                panPrevX = ev.clientX;
                panPrevY = ev.clientY;
                return;
            }
            if (isLeftDragging && toolRef.current === "bezier3" && dragStartWorld) {
                dragMoved = true;
                // lastMouseWorld は先頭で更新済み。redrawLive がそれを見て暫定描画する。
                clearLiveAll();
                redrawLive();
                return;
            }
            if (isLeftDragging && toolRef.current === "nurbs" && nurbsDragIndex !== null) {
                dragMoved = true;
                nurbsPoints[nurbsDragIndex] = rawWorld.clone();
                clearLiveAll();
                redrawLive();
                return;
            }
            if (toolRef.current === "edit" || toolRef.current === "eraser") {
                if (toolRef.current === "edit" && editDragging) {
                    // CP ドラッグ中: 制御点を更新して再描画
                    const { curveIndex, cpIndex } = editDragging;
                    const curve = storedCurves[curveIndex];
                    // handwrite は controlPoints を持たないため、型ガード
                    if (curve.kind === "handwrite") return;
                    const cps = curve.controlPoints;
                    const dx = rawWorld.x - cps[cpIndex].x;
                    const dy = rawWorld.y - cps[cpIndex].y;
                    cps[cpIndex] = { x: rawWorld.x, y: rawWorld.y };
                    if (curve.kind === "bezier" && curve.degree === 2) {
                        // 奇数インデックス（通らない制御点）の場合のみ隣接中点を再計算
                        const ei = cpIndex;
                        if (ei % 2 === 1) {
                            if (ei >= 2) {
                                cps[ei - 1] = { x: (cps[ei - 2].x + cps[ei].x) / 2, y: (cps[ei - 2].y + cps[ei].y) / 2 };
                            }
                            if (ei + 2 < cps.length) {
                                cps[ei + 1] = { x: (cps[ei].x + cps[ei + 2].x) / 2, y: (cps[ei].y + cps[ei + 2].y) / 2 };
                            }
                        }
                    } else if (curve.kind === "bezier" && curve.degree === 3 && cpIndex % 3 === 0) {
                        // bezier3 アンカー: 前後のハンドルを相対移動
                        if (cpIndex + 1 < cps.length) {
                            cps[cpIndex + 1] = { x: cps[cpIndex + 1].x + dx, y: cps[cpIndex + 1].y + dy };
                        }
                        if (cpIndex > 0) {
                            cps[cpIndex - 1] = { x: cps[cpIndex - 1].x + dx, y: cps[cpIndex - 1].y + dy };
                        }
                        // 閉曲線: 接続反対側（もう一方の端）のハンドルも相対移動
                        if (curve.closed && cpIndex === 0 && cps.length >= 3) {
                            cps[cps.length - 2] = { x: cps[cps.length - 2].x + dx, y: cps[cps.length - 2].y + dy };
                        } else if (curve.closed && cpIndex === cps.length - 1 && cps.length >= 3) {
                            cps[1] = { x: cps[1].x + dx, y: cps[1].y + dy };
                        }
                    }
                    // 閉曲線: 始点と終点を同じ位置に同期
                    if (curve.closed) {
                        if (cpIndex === 0) {
                            cps[cps.length - 1] = { x: rawWorld.x, y: rawWorld.y };
                        } else if (cpIndex === cps.length - 1) {
                            cps[0] = { x: rawWorld.x, y: rawWorld.y };
                        }
                    }
                    redrawAllCommitted();
                    showEditOverlay(curveIndex);
                    return;
                }
                if (toolRef.current === "edit") {
                    const hit = findEditHoverTarget(rawWorld);
                    if (hit) {
                        const cpHit = findNearestDraggableCP(rawWorld);
                        setHoverInfo(cpHit
                            ? `curve#${hit.curveIndex} drag=CP移動 / shift=追加 / alt=削除`
                            : `curve#${hit.curveIndex} shift=追加 / alt=削除`
                        );
                        showEditOverlay(hit.curveIndex);
                    } else {
                        setHoverInfo("");
                        showEditOverlay(-1);
                    }
                } else {
                    // eraser: 曲線のみ検出
                    const hit = findNearestEditTarget(rawWorld);
                    if (hit) {
                        setHoverInfo(`curve#${hit.curveIndex} (${hit.distance.toFixed(1)}px) click=delete`);
                        showEditOverlay(hit.curveIndex);
                    } else {
                        setHoverInfo("");
                        showEditOverlay(-1);
                    }
                }
            }
            // bezier2 / spline / bezier3 のホバープレビューを毎フレーム更新
            if (!isPanning && !isLeftDragging) {
                const t = toolRef.current;
                if (t === "bezier2" || t === "spline" || t === "bezier3") {
                    clearLiveAll();
                    redrawLive();
                }
            }
            // handwrite: isHandwriting 中は点を追加して再描画
            if (isHandwriting && toolRef.current === "handwrite") {
                const world = screenToWorld(ev.clientX, ev.clientY);
                if (!handwritePoints.length || handwritePoints[handwritePoints.length - 1].distanceTo(world) > 0.1) {
                    handwritePoints.push(world);
                    clearLiveAll();
                    redrawLive();
                }
            }
        };

        const onMouseLeave = () => {
            lastMouseWorld = null;
            const t = toolRef.current;
            if (t === "bezier2" || t === "spline" || t === "bezier3" || t === "nurbs") {
                clearLiveAll();
                redrawLive();
            } else if (t === "edit" || t === "eraser") {
                editDragging = null;
                showEditOverlay(-1);
                setHoverInfo("");
            }
        };

        const onMouseUp = (ev: MouseEvent) => {
            if (ev.button === 2 && isPanning) {
                isPanning = false;
                return;
            }
            if (ev.button === 0 && editDragging) {
                editDragging = null;
                return;
            }
            if (ev.button === 0 && isLeftDragging) {
                isLeftDragging = false;
                const t = toolRef.current;
                if (t === "nurbs" && nurbsDragIndex !== null) {
                    // ドラッグをそのまま確定。位置はムーブ中に更新済み。
                    nurbsDragIndex = null;
                    dragStartWorld = null;
                    dragMoved = false;
                    redrawLive();
                    return;
                }
                if (t === "bezier3" && dragStartWorld) {
                    const world = screenToWorld(ev.clientX, ev.clientY);
                    const anchor = dragStartWorld.clone();
                    const forward = dragMoved ? world.clone() : anchor.clone();
                    clearLiveAll();
                    if (bezier3Anchors.length >= 1) {
                        const prev = bezier3Anchors[bezier3Anchors.length - 1];
                        const back = new THREE.Vector3(
                            2 * anchor.x - forward.x,
                            2 * anchor.y - forward.y,
                            0
                        );
                        const ctrl = [prev.anchor, prev.forward, back, anchor];
                        const seg = generateBezierCurveCasteljauN(ctrl, 3, SEGMENTS);
                        commitLine(seg, 0x1f2937);
                        if (bezier3Expanded.length === 0) {
                            bezier3Expanded.push(prev.anchor.clone());
                        }
                        bezier3Expanded.push(prev.forward.clone(), back.clone(), anchor.clone());
                    }
                    bezier3Anchors.push({ anchor, forward });
                    dragStartWorld = null;
                    dragMoved = false;
                    // 閉じるドラッグ → 自動 Finish
                    if (closingDragStarted) {
                        closingDragStarted = false;
                        finishCurrent();
                    } else {
                        redrawLive();
                    }
                }
            }
            // handwrite: mouseup で手書きストロークを確定
            if (isHandwriting && toolRef.current === "handwrite") {
                isHandwriting = false;
                if (handwritePoints.length >= 2) {
                    const points = handwritePoints.map(p => ({ x: p.x, y: p.y }));
                    storedCurves.push({ kind: "handwrite", points });
                    redrawAllCommitted();
                } else {
                    clearLiveAll();
                }
                handwritePoints = [];
                hasFirstPoint = false;
                redrawLive();
            }
        };

        const onWheel = (ev: WheelEvent) => {
            ev.preventDefault();
            const worldBefore = screenToWorld(ev.clientX, ev.clientY);
            const scale = ev.deltaY > 0 ? 1.1 : 0.9;
            camera.left = worldBefore.x - (worldBefore.x - camera.left) * scale;
            camera.right = worldBefore.x + (camera.right - worldBefore.x) * scale;
            camera.top = worldBefore.y + (camera.top - worldBefore.y) * scale;
            camera.bottom = worldBefore.y - (worldBefore.y - camera.bottom) * scale;
            camera.updateProjectionMatrix();
        };

        const onContextMenu = (ev: MouseEvent) => ev.preventDefault();

        // ---- 線修正モード ----
        const distanceToSegment = (
            p: THREE.Vector3,
            a: THREE.Vector3,
            b: THREE.Vector3
        ) => {
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const apx = p.x - a.x;
            const apy = p.y - a.y;
            const len2 = abx * abx + aby * aby;
            let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
            t = Math.max(0, Math.min(1, t));
            const cx = a.x + t * abx;
            const cy = a.y + t * aby;
            return Math.hypot(p.x - cx, p.y - cy);
        };

        const sampleCurve = (curve: StoredCurve): THREE.Vector3[] => {
            if (curve.kind === "handwrite") {
                return curve.points.map((p) => v3(p.x, p.y));
            }
            const pts = curve.controlPoints.map((p) => v3(p.x, p.y));
            if (curve.kind === "spline-uniform") {
                const out: THREE.Vector3[] = [];
                if (pts.length < 2) return out;
                const n = pts.length;
                // finishCurrent と同様に仮想端点を追加してエンドキャップセグメントも生成する
                const Vs = new THREE.Vector3(2 * pts[0].x - pts[1].x, 2 * pts[0].y - pts[1].y, 0);
                const Ve = new THREE.Vector3(2 * pts[n - 1].x - pts[n - 2].x, 2 * pts[n - 1].y - pts[n - 2].y, 0);
                const aug = [Vs, ...pts, Ve];
                for (let i = 0; i + 3 < aug.length; i++) {
                    const [tr0, tr1, tr2, tr3] = createParameterValues(
                        [aug[i], aug[i + 1], aug[i + 2], aug[i + 3]], "centripetal"
                    );
                    const seg = generateCatmullRomSplineSegment(
                        aug[i], aug[i + 1], aug[i + 2], aug[i + 3],
                        tr0, tr1, tr2, tr3, 32
                    );
                    if (i > 0) seg.shift();
                    out.push(...seg);
                }
                return out;
            } else if (curve.kind === "nurbs") {
                // ダミー関数を呼ぶ。本実装までは制御点をそのまま返すので折れ線になる。
                return generateNURBSCurve(pts);
            } else {
                const deg = curve.degree;
                const out: THREE.Vector3[] = [];
                for (let i = 0; i + deg < pts.length; i += deg) {
                    const ctrl = pts.slice(i, i + deg + 1);
                    const seg = generateBezierCurveCasteljauN(ctrl, deg, 32);
                    if (i > 0) seg.shift();
                    out.push(...seg);
                }
                return out;
            }
        };

        const findNearestEditTarget = (world: THREE.Vector3) => {
            let best: { curveIndex: number; distance: number } | null = null;
            const threshold = 10; // world 単位
            for (let ci = 0; ci < storedCurves.length; ci++) {
                const samples = sampleCurve(storedCurves[ci]);
                let minD = Infinity;
                for (let i = 0; i + 1 < samples.length; i++) {
                    const d = distanceToSegment(world, samples[i], samples[i + 1]);
                    if (d < minD) minD = d;
                }
                if (minD <= threshold && (!best || minD < best.distance)) {
                    best = { curveIndex: ci, distance: minD };
                }
            }
            return best;
        };

        /** 編集モードでドラッグ可能な制御点の中で最近傍を返す。
         *  bezier2 は奇数インデックスのみ（通らない制御点）。spline/bezier3 は全点。 */
        const findNearestDraggableCP = (world: THREE.Vector3): { curveIndex: number; cpIndex: number; distance: number } | null => {
            const CP_THRESHOLD = 12;
            let best: { curveIndex: number; cpIndex: number; distance: number } | null = null;
            for (let ci = 0; ci < storedCurves.length; ci++) {
                const c = storedCurves[ci];
                // handwrite は編集不可
                if (c.kind === "handwrite") continue;
                const cps = c.controlPoints;
                for (let pi = 0; pi < cps.length; pi++) {
                    // bezier2: 内部中点（偶数インデックス、始点・終点を除く）は除外
                    if (c.kind === "bezier" && c.degree === 2 && pi % 2 === 0 && pi !== 0 && pi !== cps.length - 1) continue;
                    const d = Math.hypot(cps[pi].x - world.x, cps[pi].y - world.y);
                    if (d <= CP_THRESHOLD && (!best || d < best.distance)) {
                        best = { curveIndex: ci, cpIndex: pi, distance: d };
                    }
                }
            }
            return best;
        };

        /** 編集モードのホバー検出。曲線・制御点・制御ポリゴンセグメントのいずれかが近ければヒット。
         *  制御ポリゴン線を閾値に含めることで、曲線と離れた制御点への移動中もオーバーレイが消えない。
         *  handwrite は制御点編集対象外だが、ホバー検出には含める（削除用）。 */
        const findEditHoverTarget = (world: THREE.Vector3): { curveIndex: number; distance: number } | null => {
            let best: { curveIndex: number; distance: number } | null = null;
            const HOVER_THRESHOLD = 12;
            for (let ci = 0; ci < storedCurves.length; ci++) {
                const c = storedCurves[ci];
                let minD = Infinity;
                // 曲線サンプル点との距離
                const samples = sampleCurve(c);
                for (let i = 0; i + 1 < samples.length; i++) {
                    const d = distanceToSegment(world, samples[i], samples[i + 1]);
                    if (d < minD) minD = d;
                }
                // 制御点との距離（handwrite は controlPoints 無いのでスキップ）
                if (c.kind !== "handwrite") {
                    for (const cp of c.controlPoints) {
                        const d = Math.hypot(cp.x - world.x, cp.y - world.y);
                        if (d < minD) minD = d;
                    }
                    // 制御ポリゴンのセグメント（曲線→制御点間のギャップを埋める）
                    for (let j = 0; j + 1 < c.controlPoints.length; j++) {
                        const a = v3(c.controlPoints[j].x, c.controlPoints[j].y);
                        const b = v3(c.controlPoints[j + 1].x, c.controlPoints[j + 1].y);
                        const d = distanceToSegment(world, a, b);
                        if (d < minD) minD = d;
                    }
                }
                if (minD <= HOVER_THRESHOLD && (!best || minD < best.distance)) {
                    best = { curveIndex: ci, distance: minD };
                }
            }
            return best;
        };

        // 編集モード時の制御点オーバーレイ（live 領域で表現）
        let editOverlayCurveIndex = -1;
        let editDragging: { curveIndex: number; cpIndex: number } | null = null;
        const showEditOverlay = (index: number) => {
            if (index === editOverlayCurveIndex) return;
            editOverlayCurveIndex = index;
            // redrawLive は他の進行中状態を上書きしないため、別経路で末尾に制御点を出すだけにする
            // ここでは liveLineCount/livePointCount を使ってクリアする
            clearLiveAll();
            if (index >= 0) {
                const c = storedCurves[index];
                // handwrite は制御点を表示しない
                if (c.kind !== "handwrite") {
                    for (const cp of c.controlPoints) {
                        drawLivePoint(v3(cp.x, cp.y), 0x10b981);
                    }
                    drawLiveLine(c.controlPoints.map((p) => v3(p.x, p.y)), 0x10b981);
                }
            }
        };

        const handleEditClick = (world: THREE.Vector3, shift: boolean, alt: boolean) => {
            const hit = findNearestEditTarget(world);
            if (!hit) return;
            snapshotForUndo();
            const curve = storedCurves[hit.curveIndex];
            // handwrite は制御点編集不可
            if (curve.kind === "handwrite") return;
            if (shift) {
                // 制御点追加: クリック位置に最も近い制御点の手前に挿入
                const cps = curve.controlPoints;
                let bestIdx = 0;
                let bestD = Infinity;
                for (let i = 0; i < cps.length; i++) {
                    const d = Math.hypot(cps[i].x - world.x, cps[i].y - world.y);
                    if (d < bestD) {
                        bestD = d;
                        bestIdx = i;
                    }
                }
                cps.splice(Math.max(0, bestIdx), 0, { x: world.x, y: world.y });
            } else if (alt) {
                // 制御点削除: クリック位置に最も近い制御点を削除
                const cps = curve.controlPoints;
                if (cps.length <= 2) return;
                let bestIdx = 0;
                let bestD = Infinity;
                for (let i = 0; i < cps.length; i++) {
                    const d = Math.hypot(cps[i].x - world.x, cps[i].y - world.y);
                    if (d < bestD) {
                        bestD = d;
                        bestIdx = i;
                    }
                }
                cps.splice(bestIdx, 1);
            } else {
                return;
            }
            // 全体を再描画
            redrawAllCommitted();
        };

        const redrawAllCommitted = () => {
            // 削除順序: live を先に消してから commit を消す（renderer は末尾から削除するため）
            clearLiveAll();
            for (let i = 0; i < committedLineCount; i++) api.removeLastLine?.();
            committedLineCount = 0;
            for (const c of storedCurves) {
                const samples = sampleCurve(c);
                if (samples.length >= 2) commitLine(samples, 0x1f2937);
            }
            editOverlayCurveIndex = -1;
            redrawLive();
        };

        // ---- undo / redo / reset view ----
        type InProgressSnap = {
            splinePoints: { x: number; y: number }[];
            bezier2Points: { x: number; y: number }[];
            bezier2Expanded: { x: number; y: number }[];
            bezier3Anchors: { anchor: { x: number; y: number }; forward: { x: number; y: number } }[];
            bezier3Expanded: { x: number; y: number }[];
            nurbsPoints: { x: number; y: number }[];
            committedLineCount: number;
        };
        type UndoEntry = { curves: StoredCurve[]; inProgressStack: InProgressSnap[] };
        const undoStack: UndoEntry[] = [];
        const redoStack: UndoEntry[] = [];
        const inProgressUndoStack: InProgressSnap[] = [];
        const inProgressRedoStack: InProgressSnap[] = [];
        const updateUndoRedoState = () => {
            setCanUndo(undoStack.length > 0 || inProgressUndoStack.length > 0);
            setCanRedo(redoStack.length > 0 || inProgressRedoStack.length > 0);
        };
        const snapshotForUndo = () => {
            undoStack.push({
                curves: JSON.parse(JSON.stringify(storedCurves)),
                inProgressStack: JSON.parse(JSON.stringify(inProgressUndoStack)),
            });
            redoStack.length = 0;
            updateUndoRedoState();
        };
        /** 配列復元後、描画中の確定済みセグメントをシーンに再追加する */
        const redrawInProgressCommitted = () => {
            const t = toolRef.current;
            if (t === "spline") {
                for (let i = 0; i + 3 < splinePoints.length; i++) {
                    const [tp0, tp1, tp2, tp3] = createParameterValues(
                        [splinePoints[i], splinePoints[i + 1], splinePoints[i + 2], splinePoints[i + 3]], "centripetal"
                    );
                    const seg = generateCatmullRomSplineSegment(
                        splinePoints[i], splinePoints[i + 1], splinePoints[i + 2], splinePoints[i + 3],
                        tp0, tp1, tp2, tp3, SEGMENTS
                    );
                    commitLine(seg, 0x1f2937);
                }
            } else if (t === "bezier2") {
                for (let i = 0; i + 2 < bezier2Expanded.length; i += 2) {
                    const seg = generateBezierCurveCasteljauN(
                        [bezier2Expanded[i], bezier2Expanded[i + 1], bezier2Expanded[i + 2]],
                        2, SEGMENTS
                    );
                    commitLine(seg, 0x1f2937);
                }
            } else if (t === "bezier3") {
                for (let i = 0; i + 3 < bezier3Expanded.length; i += 3) {
                    const seg = generateBezierCurveCasteljauN(
                        [bezier3Expanded[i], bezier3Expanded[i + 1], bezier3Expanded[i + 2], bezier3Expanded[i + 3]],
                        3, SEGMENTS
                    );
                    commitLine(seg, 0x1f2937);
                }
            }
        };
        /** 描画中の配列をスナップショットから復元する（committedLineCount は呼び出し側で管理） */
        const applyInProgressSnap = (snap: InProgressSnap) => {
            splinePoints = snap.splinePoints.map(p => v3(p.x, p.y));
            bezier2Points = snap.bezier2Points.map(p => v3(p.x, p.y));
            bezier2Expanded = snap.bezier2Expanded.map(p => v3(p.x, p.y));
            bezier3Anchors = snap.bezier3Anchors.map(a => ({
                anchor: v3(a.anchor.x, a.anchor.y),
                forward: v3(a.forward.x, a.forward.y),
            }));
            bezier3Expanded = snap.bezier3Expanded.map(p => v3(p.x, p.y));
            nurbsPoints = (snap.nurbsPoints ?? []).map(p => v3(p.x, p.y));
            nurbsDragIndex = null;
            hasFirstPoint = splinePoints.length > 0 || bezier2Points.length > 0 || bezier3Anchors.length > 0 || nurbsPoints.length > 0;
            closingDragStarted = false;
            isLeftDragging = false;
            dragStartWorld = null;
            dragMoved = false;
        };
        const saveInProgressSnapshot = () => {
            inProgressUndoStack.push({
                splinePoints: splinePoints.map(p => ({ x: p.x, y: p.y })),
                bezier2Points: bezier2Points.map(p => ({ x: p.x, y: p.y })),
                bezier2Expanded: bezier2Expanded.map(p => ({ x: p.x, y: p.y })),
                bezier3Anchors: bezier3Anchors.map(a => ({
                    anchor: { x: a.anchor.x, y: a.anchor.y },
                    forward: { x: a.forward.x, y: a.forward.y },
                })),
                bezier3Expanded: bezier3Expanded.map(p => ({ x: p.x, y: p.y })),
                nurbsPoints: nurbsPoints.map(p => ({ x: p.x, y: p.y })),
                committedLineCount,
            });
            inProgressRedoStack.length = 0; // 新規操作でredoキャッシュをクリア
            redoStack.length = 0;
            updateUndoRedoState();
        };
        const undo = () => {
            // 描画中は一つ前の制御点配置に戻す
            if (inProgressUndoStack.length > 0) {
                // 現在の描画状態を redo スタックに保存
                inProgressRedoStack.push({
                    splinePoints: splinePoints.map(p => ({ x: p.x, y: p.y })),
                    bezier2Points: bezier2Points.map(p => ({ x: p.x, y: p.y })),
                    bezier2Expanded: bezier2Expanded.map(p => ({ x: p.x, y: p.y })),
                    bezier3Anchors: bezier3Anchors.map(a => ({
                        anchor: { x: a.anchor.x, y: a.anchor.y },
                        forward: { x: a.forward.x, y: a.forward.y },
                    })),
                    bezier3Expanded: bezier3Expanded.map(p => ({ x: p.x, y: p.y })),
                    nurbsPoints: nurbsPoints.map(p => ({ x: p.x, y: p.y })),
                    committedLineCount,
                });
                const snap = inProgressUndoStack.pop()!;
                const linesToRemove = committedLineCount - snap.committedLineCount;
                clearLiveAll();
                for (let i = 0; i < linesToRemove; i++) api.removeLastLine?.();
                committedLineCount = snap.committedLineCount;
                applyInProgressSnap(snap);
                redrawLive();
                updateUndoRedoState();
                return;
            }
            // 確定済み曲線の undo
            if (undoStack.length === 0) return;
            redoStack.push({ curves: JSON.parse(JSON.stringify(storedCurves)), inProgressStack: [] });
            const prev = undoStack.pop()!;
            storedCurves.length = 0;
            storedCurves.push(...prev.curves);
            if (prev.inProgressStack.length > 0) {
                // 閉曲線完成直前の描画中状態を復元
                const lastSnap = prev.inProgressStack[prev.inProgressStack.length - 1];
                inProgressUndoStack.length = 0;
                inProgressUndoStack.push(...prev.inProgressStack.slice(0, -1));
                clearLiveAll();
                for (let i = 0; i < committedLineCount; i++) api.removeLastLine?.();
                committedLineCount = 0;
                for (const c of prev.curves) {
                    const samples = sampleCurve(c);
                    if (samples.length >= 2) commitLine(samples, 0x1f2937);
                }
                applyInProgressSnap(lastSnap);
                redrawInProgressCommitted();
                redrawLive();
            } else {
                resetInProgressRef.current?.();
                redrawAllCommitted();
            }
            updateUndoRedoState();
        };
        const redo = () => {
            // 描画中の redo を優先
            if (inProgressRedoStack.length > 0) {
                // 現在の描画状態を undo スタックに保存
                inProgressUndoStack.push({
                    splinePoints: splinePoints.map(p => ({ x: p.x, y: p.y })),
                    bezier2Points: bezier2Points.map(p => ({ x: p.x, y: p.y })),
                    bezier2Expanded: bezier2Expanded.map(p => ({ x: p.x, y: p.y })),
                    bezier3Anchors: bezier3Anchors.map(a => ({
                        anchor: { x: a.anchor.x, y: a.anchor.y },
                        forward: { x: a.forward.x, y: a.forward.y },
                    })),
                    bezier3Expanded: bezier3Expanded.map(p => ({ x: p.x, y: p.y })),
                    nurbsPoints: nurbsPoints.map(p => ({ x: p.x, y: p.y })),
                    committedLineCount,
                });
                const snap = inProgressRedoStack.pop()!;
                clearLiveAll();
                for (let i = 0; i < committedLineCount; i++) api.removeLastLine?.();
                committedLineCount = 0;
                for (const c of storedCurves) {
                    const samples = sampleCurve(c);
                    if (samples.length >= 2) commitLine(samples, 0x1f2937);
                }
                applyInProgressSnap(snap);
                redrawInProgressCommitted();
                redrawLive();
                updateUndoRedoState();
                return;
            }
            // 確定済み曲線の redo
            if (redoStack.length === 0) return;
            undoStack.push({
                curves: JSON.parse(JSON.stringify(storedCurves)),
                inProgressStack: JSON.parse(JSON.stringify(inProgressUndoStack)),
            });
            const next = redoStack.pop()!;
            storedCurves.length = 0;
            storedCurves.push(...next.curves);
            inProgressUndoStack.length = 0;
            inProgressRedoStack.length = 0;
            resetInProgressRef.current?.();
            redrawAllCommitted();
            updateUndoRedoState();
        };

        undoRef.current = undo;
        redoRef.current = redo;
        resetViewRef.current = () => {
            const w = Math.max(container.clientWidth, 1);
            const h = Math.max(container.clientHeight, 1);
            camera.left = -w / 2;
            camera.right = w / 2;
            camera.top = h / 2;
            camera.bottom = -h / 2;
            camera.updateProjectionMatrix();
        };

        // ---- 保存 / 復元 ----
        saveCurvesRef.current = () => {
            const json = JSON.stringify(storedCurves, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "curves.json";
            a.click();
            URL.revokeObjectURL(url);
        };

        loadCurvesRef.current = (data: StoredCurve[]) => {
            snapshotForUndo();
            storedCurves.length = 0;
            storedCurves.push(...data);
            resetInProgressRef.current();
            redrawAllCommitted();
        };

        dom.addEventListener("mousedown", onMouseDown);
        dom.addEventListener("mousemove", onMouseMove);
        dom.addEventListener("mouseleave", onMouseLeave);
        window.addEventListener("mouseup", onMouseUp);
        dom.addEventListener("contextmenu", onContextMenu);
        dom.addEventListener("wheel", onWheel as EventListener, { passive: false });

        // 外部ボタン
        const finishBtn = document.getElementById("painter-finish-button");
        const clearBtn = document.getElementById("painter-clear-button");
        const handleFinish = () => finishCurrent();
        const handleClear = () => {
            clearLiveAll();
            for (let i = 0; i < committedLineCount; i++) api.removeLastLine?.();
            committedLineCount = 0;
            storedCurves.length = 0;
            hasFirstPoint = false;
            resetInProgressRef.current?.();
        };
        finishBtn?.addEventListener("click", handleFinish);
        clearBtn?.addEventListener("click", handleClear);

        // トレース画像セット用
        (window as any).__painter_setTrace = (url: string | null) => {
            api.setBackgroundImage?.(url);
        };
        (window as any).__painter_setTraceVisible = (v: boolean) => {
            (api as any).setTraceVisible?.(v);
        };

        return () => {
            dom.removeEventListener("mousedown", onMouseDown);
            dom.removeEventListener("mousemove", onMouseMove);
            dom.removeEventListener("mouseleave", onMouseLeave);
            window.removeEventListener("mouseup", onMouseUp);
            dom.removeEventListener("contextmenu", onContextMenu);
            dom.removeEventListener("wheel", onWheel as EventListener);
            finishBtn?.removeEventListener("click", handleFinish);
            clearBtn?.removeEventListener("click", handleClear);
            delete (window as any).__painter_setTrace;
            delete (window as any).__painter_setTraceVisible;
            api.dispose?.();
        };
    }, []);

    const onPickTrace = (ev: React.ChangeEvent<HTMLInputElement>) => {
        const f = ev.target.files?.[0];
        if (!f) return;
        const url = URL.createObjectURL(f);
        (window as any).__painter_setTrace?.(url);
        setHasTrace(true);
    };

    const onClearTrace = () => {
        (window as any).__painter_setTrace?.(null);
        setHasTrace(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const onPickCurves = (ev: React.ChangeEvent<HTMLInputElement>) => {
        const f = ev.target.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target?.result as string) as StoredCurve[];
                if (!Array.isArray(data)) throw new Error("invalid format");
                loadCurvesRef.current(data);
            } catch {
                alert("曲線データの読み込みに失敗しました。");
            } finally {
                if (curveFileInputRef.current) curveFileInputRef.current.value = "";
            }
        };
        reader.readAsText(f);
    };

    return (
        <div className="app">
            <div className="viewer" ref={containerRef} />

            {/* Top UI Bar - Commands */}
            <div style={{
                position: "absolute",
                top: 12,
                left: 12,
                display: "flex",
                gap: 4,
                alignItems: "center",
                padding: "6px 12px",
                borderRadius: 8,
                background: "rgba(32, 35, 42, 0.85)",
                border: "1px solid rgba(100, 116, 139, 0.3)",
                zIndex: 100,
            }}>
                <button
                    onClick={() => undoRef.current()}
                    disabled={!canUndo}
                    className="finish-button"
                    style={{
                        padding: "6px 8px",
                        width: 32,
                        height: 32,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: canUndo ? "#374151" : "#1f2937",
                        opacity: canUndo ? 1 : 0.4,
                        fontSize: 16
                    }}
                    title="Undo"
                >↶</button>
                <button
                    onClick={() => redoRef.current()}
                    disabled={!canRedo}
                    className="finish-button"
                    style={{
                        padding: "6px 8px",
                        width: 32,
                        height: 32,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: canRedo ? "#374151" : "#1f2937",
                        opacity: canRedo ? 1 : 0.4,
                        fontSize: 16
                    }}
                    title="Redo"
                >↷</button>
                <div style={{ width: 1, height: 20, background: "rgba(100,116,139,0.3)" }} />
                <button id="painter-finish-button" className="finish-button" style={{ fontSize: 12, padding: "6px 10px" }}>✓ Finish</button>
                <button id="painter-clear-button" className="finish-button" style={{ background: "#ef4444", fontSize: 12, padding: "6px 10px" }}>✕ Clear</button>
                <button
                    onClick={() => resetViewRef.current()}
                    className="finish-button"
                    style={{ background: "#64748b", fontSize: 12, padding: "6px 10px" }}
                >⊙ Reset</button>
                <button
                    onClick={() => saveCurvesRef.current()}
                    className="finish-button"
                    style={{ background: "#0f766e", fontSize: 12, padding: "6px 10px" }}
                >⬇ Save</button>
                <button
                    onClick={() => curveFileInputRef.current?.click()}
                    className="finish-button"
                    style={{ background: "#0f766e", fontSize: 12, padding: "6px 10px" }}
                >⬆ Load</button>
                <input
                    ref={curveFileInputRef}
                    type="file"
                    accept=".json,application/json"
                    style={{ display: "none" }}
                    onChange={onPickCurves}
                />
                <div style={{ width: 1, height: 20, background: "rgba(100,116,139,0.3)" }} />
                {/* Trace layer */}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="finish-button"
                        style={{ background: "#64748b", fontSize: 12, padding: "6px 10px" }}
                        title="トレースレイヤーを読み込み"
                    >trace 📁</button>
                    <input ref={fileInputRef} type="file" accept="image/*" onChange={onPickTrace} style={{ display: "none" }} />
                    {hasTrace && (
                        <>
                            <button
                                className="finish-button"
                                onClick={() => {
                                    const next = !traceVisible;
                                    setTraceVisible(next);
                                    (window as any).__painter_setTraceVisible?.(next);
                                }}
                                style={{ background: "#64748b", fontSize: 12, padding: "6px 8px" }}
                                title={traceVisible ? "トレースを非表示" : "トレースを表示"}
                            >{traceVisible ? "👁" : "👁‍🗨"}</button>
                            <button
                                className="finish-button"
                                onClick={onClearTrace}
                                style={{ background: "#64748b", fontSize: 12, padding: "6px 8px" }}
                                title="トレースをクリア"
                            >✕</button>
                        </>
                    )}
                </div>
            </div>

            {/* Left Tool Buttons - Vertical */}
            <div style={{
                position: "absolute",
                top: "50%",
                left: 12,
                transform: "translateY(-50%)",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                zIndex: 99,
            }}>
                {/* Draw button with hover menu — ラッパーでホバー管理することでギャップ問題を解消 */}
                <div
                    style={{ position: "relative", display: "flex", flexDirection: "row", alignItems: "center" }}
                    onMouseEnter={(e) => {
                        const menu = e.currentTarget.querySelector(".draw-submenu") as HTMLElement;
                        if (menu) { menu.style.opacity = "1"; menu.style.pointerEvents = "auto"; }
                    }}
                    onMouseLeave={(e) => {
                        const menu = e.currentTarget.querySelector(".draw-submenu") as HTMLElement;
                        if (menu) { menu.style.opacity = "0"; menu.style.pointerEvents = "none"; }
                    }}
                >
                    <button
                        onClick={() => {
                            if (!(tool === "spline" || tool === "bezier2" || tool === "bezier3" || tool === "nurbs")) {
                                setTool("spline");
                            }
                        }}
                        style={{
                            padding: "10px 12px",
                            borderRadius: 6,
                            border: tool === "spline" || tool === "bezier2" || tool === "bezier3" || tool === "nurbs" ? "2px solid #3b82f6" : "2px solid #475569",
                            background: tool === "spline" || tool === "bezier2" || tool === "bezier3" || tool === "nurbs" ? "#3b82f6" : "#1f2937",
                            color: "#f8fafc",
                            fontSize: 18,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 42,
                            height: 42,
                        }}
                        title="描画ツール（ホバーでメニュー表示）"
                    >
                        🖌
                    </button>
                    {/* Hover menu — left=42 でボタンに隙間なく接続 */}
                    <div
                        className="draw-submenu"
                        style={{
                            position: "absolute",
                            left: 42,
                            top: 0,
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                            opacity: 0,
                            pointerEvents: "none",
                            transition: "opacity 0.15s",
                            background: "rgba(22,26,34,0.97)",
                            padding: "8px",
                            borderRadius: 6,
                            border: "1px solid #475569",
                            minWidth: 100,
                            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                        }}
                    >
                        <button onClick={() => setTool("spline")} style={{ padding: "6px 8px", fontSize: 12, border: "1px solid #475569", background: tool === "spline" ? "#3b82f6" : "#1f2937", color: "#f8fafc", borderRadius: 4, cursor: "pointer", textAlign: "left" }}>〰 Spline</button>
                        <button onClick={() => setTool("bezier2")} style={{ padding: "6px 8px", fontSize: 12, border: "1px solid #475569", background: tool === "bezier2" ? "#3b82f6" : "#1f2937", color: "#f8fafc", borderRadius: 4, cursor: "pointer", textAlign: "left" }}>⌒ Bezier 2</button>
                        <button onClick={() => setTool("bezier3")} style={{ padding: "6px 8px", fontSize: 12, border: "1px solid #475569", background: tool === "bezier3" ? "#3b82f6" : "#1f2937", color: "#f8fafc", borderRadius: 4, cursor: "pointer", textAlign: "left" }}>⌒ Bezier 3</button>
                        <button onClick={() => setTool("nurbs")} style={{ padding: "6px 8px", fontSize: 12, border: "1px solid #475569", background: tool === "nurbs" ? "#3b82f6" : "#1f2937", color: "#f8fafc", borderRadius: 4, cursor: "pointer", textAlign: "left" }}>∿ NURBS</button>
                        <button onClick={() => setTool("handwrite")} style={{ padding: "6px 8px", fontSize: 12, border: "1px solid #475569", background: tool === "handwrite" ? "#3b82f6" : "#1f2937", color: "#f8fafc", borderRadius: 4, cursor: "pointer", textAlign: "left" }}>✒️ 手書き</button>
                    </div>
                </div>

                <button
                    onClick={() => setTool("edit")}
                    style={{
                        padding: "10px 12px",
                        borderRadius: 6,
                        border: tool === "edit" ? "2px solid #3b82f6" : "2px solid #475569",
                        background: tool === "edit" ? "#3b82f6" : "#1f2937",
                        color: "#f8fafc",
                        fontSize: 18,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 42,
                        height: 42,
                    }}
                    title="線修正"
                >
                    🔧
                </button>

                <button
                    onClick={() => setTool("eraser")}
                    style={{
                        padding: "10px 12px",
                        borderRadius: 6,
                        border: tool === "eraser" ? "2px solid #3b82f6" : "2px solid #475569",
                        background: tool === "eraser" ? "#3b82f6" : "#1f2937",
                        color: "#f8fafc",
                        fontSize: 18,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 42,
                        height: 42,
                    }}
                    title="消去"
                >
                    🗑
                </button>
            </div>

            {/* Tool Info */}
            <div style={{
                position: "absolute",
                top: 80,
                left: 12,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxWidth: 300,
                padding: "8px 12px",
                borderRadius: 8,
                background: "rgba(32, 35, 42, 0.80)",
                border: "1px solid rgba(100, 116, 139, 0.3)",
                color: "#f8fafc",
                fontSize: 11,
                opacity: 0.85,
            }}>
                {(tool === "bezier2" || tool === "bezier3") && (
                    <div>
                        {tool === "bezier3" && <div>左ドラッグ: 始点=通る点, 終点=制御点</div>}
                        {tool === "bezier2" && <div>左クリックで通らない制御点を順次追加</div>}
                    </div>
                )}
                {tool === "spline" && (
                    <div>左クリックで通る点を追加 (knot: uniform 固定)</div>
                )}
                {tool === "nurbs" && (
                    <div>
                        <div>左クリック=追加 / ドラッグ=移動</div>
                        <div>末尾=通る点(赤) ↔ 通らない点(青) 交互</div>
                    </div>
                )}
                {tool === "edit" && (
                    <div>
                        <div>線に近づくと制御点表示</div>
                        <div>shift+左クリック=追加 / alt+左クリック=削除</div>
                        <div>{hoverInfo}</div>
                    </div>
                )}
                {tool === "eraser" && (
                    <div>
                        <div>線に近づいてクリックで削除</div>
                        <div>{hoverInfo}</div>
                    </div>
                )}
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>右クリックドラッグで pan / ホイールで zoom</div>
            </div>
        </div>
    );
}
