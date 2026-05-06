import "./styles.css";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { generateBezierCurveCasteljau, generateBezierCurvePolynomial, generateBezierCurvePolynomialN, generateBezierCurveCasteljauN } from "./curve";
import { createThreeRenderer } from "./threeRenderer";

interface ControlPoint {
  position: THREE.Vector3;
  type: "red" | "blue"; // red: 通る点, blue: 通らない点
}

type CurveMethod = "polynomial" | "casteljau";

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const finishButtonRef = useRef<HTMLButtonElement | null>(null);
  const segmentsRef = useRef(64);
  const redrawRef = useRef<(() => void) | null>(null);
  const curveMethodRef = useRef<CurveMethod>("polynomial");
  const degreeRef = useRef<number>(2);
  const [segments, setSegments] = useState(64);
  const [curveMethod, setCurveMethod] = useState<CurveMethod>("polynomial");
  const [degree, setDegree] = useState<number>(2);
  const degreeChangeHandlerRef = useRef<((next: number) => void) | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const rendererApi = createThreeRenderer(container);
    const domElement = rendererApi.domElement;
    const camera = rendererApi.camera;

    const addLine = rendererApi.addLine;
    const addPoint = rendererApi.addPoint;
    const removeLastPointObject = rendererApi.removeLastPointObject;
    const removeFirstPointObject = rendererApi.removeFirstPointObject;
    const clearSceneObjects = rendererApi.clearSceneObjects;
    const screenToWorld = rendererApi.screenToWorld;
    let controlPoints: ControlPoint[] = [];
    let currentCurveStart: THREE.Vector3 | null = null;
    const closedCurves: ControlPoint[][] = []; // 完成した曲線群
    const closedCurveMeta: { points: number; lines: number }[] = []; // 完成曲線ごとのオブジェクト数
    const closedCurveRendered: { points: { x: number; y: number }[]; color: number }[] = [];

    // undo/redo 用の履歴 (スナップショット)
    type Snapshot = {
      controlPoints: { x: number; y: number; type: "red" | "blue" }[];
      currentCurveStart: { x: number; y: number } | null;
      closedCurves: {
        points: { x: number; y: number; type: "red" | "blue" }[];
        closed: boolean;
      }[];
      closedRendered: { points: { x: number; y: number }[]; color: number }[];
    };

    const history: Snapshot[] = [];
    let historyIndex = -1;

    const createSnapshot = (): Snapshot => ({
      controlPoints: controlPoints.map((p) => ({ x: p.position.x, y: p.position.y, type: p.type })),
      currentCurveStart: currentCurveStart
        ? { x: currentCurveStart.x, y: currentCurveStart.y }
        : null,
      closedCurves: closedCurves.map((curve, i) => ({
        points: curve.map((p) => ({ x: p.position.x, y: p.position.y, type: p.type })),
        closed: closedCurveMeta[i] ? closedCurveMeta[i].lines >= closedCurveMeta[i].points : false,
      })),
      closedRendered: closedCurveRendered.map((r) => ({ points: r.points.map((pt) => ({ x: pt.x, y: pt.y })), color: r.color })),
    });

    // clearSceneObjects is provided by rendererApi

    const restoreSnapshot = (snap: Snapshot) => {
      // clear current objects
      clearSceneObjects();

      // reset state arrays
      controlPoints = [];
      currentCurveStart = snap.currentCurveStart
        ? new THREE.Vector3(snap.currentCurveStart.x, snap.currentCurveStart.y)
        : null;
      closedCurves.length = 0;
      closedCurveMeta.length = 0;

      // restore closed curves data (control points only)
      for (const c of snap.closedCurves) {
        const pts: ControlPoint[] = [];
        for (const pt of c.points) {
          const v = new THREE.Vector3(pt.x, pt.y);
          pts.push({ position: v, type: pt.type });
        }
        closedCurves.push(pts);
        const lines = c.closed ? pts.length : Math.max(0, pts.length - 1);
        closedCurveMeta.push({ points: pts.length, lines });
      }

      // restore rendered curve geometries (サンプル済みの座標で復元する)
      closedCurveRendered.length = 0;
      for (const r of snap.closedRendered) {
        const pts = r.points.map((p) => new THREE.Vector3(p.x, p.y));
        addLine(pts, r.color);
        closedCurveRendered.push({ points: r.points.map((p) => ({ x: p.x, y: p.y })), color: r.color });
      }

      // restore current control points
      for (const pt of snap.controlPoints) {
        const v = new THREE.Vector3(pt.x, pt.y);
        controlPoints.push({ position: v, type: pt.type });
        addPoint(v, pt.type === "red" ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));
      }
      addBezierFromControlPoints(controlPoints, 0x8f96a3);
    };

    // history manager (uses createSnapshot / restoreSnapshot)
    const { pushHistory, undoHistory, redoHistory } = (function () {
      const historyLocal: any[] = [];
      let historyIndexLocal = -1;
      return {
        pushHistory: () => {
          const snap = createSnapshot();
          historyLocal.splice(historyIndexLocal + 1);
          historyLocal.push(snap);
          historyIndexLocal = historyLocal.length - 1;
        },
        undoHistory: () => {
          if (historyIndexLocal <= 0) return;
          historyIndexLocal -= 1;
          const snap = historyLocal[historyIndexLocal];
          restoreSnapshot(snap);
        },
        redoHistory: () => {
          if (historyIndexLocal >= historyLocal.length - 1) return;
          historyIndexLocal += 1;
          const snap = historyLocal[historyIndexLocal];
          restoreSnapshot(snap);
        },
      };
    })();

    redrawRef.current = () => {
      restoreSnapshot(createSnapshot());
    };

    // 次数変更時のハンドラを登録（マウント内で controlPoints 等へアクセス可能）
    degreeChangeHandlerRef.current = (next: number) => {
      const old = degreeRef.current;
      // 次数を下げる場合、in-progress の青点が存在すれば青点のみ撤回して赤点は保持する
      if (next < old) {
        const hasBlue = controlPoints.some((p) => p.type === "blue");
        if (hasBlue) {
          // 全ての点表示を一旦消し、赤点のみ再描画して controlPoints を更新する
          (rendererApi as any).removeAllPointObjects();

          const redOnly: ControlPoint[] = controlPoints.filter((p) => p.type === "red");
          controlPoints = redOnly.map((p) => ({ position: p.position.clone(), type: "red" }));

          // 再描画: 赤点だけを復元
          for (const rp of controlPoints) {
            addPoint(rp.position, new THREE.Color(0xff0000));
          }

          // 現在の始点は赤点の先頭を使う（なければ null）
          currentCurveStart = controlPoints.length > 0 ? controlPoints[0].position.clone() : null;

          pushHistory();
        }
      }

      degreeRef.current = next;
      setDegree(next);
      redrawRef.current?.();
    };

    const buildCurvePoints = (pointsVec: THREE.Vector3[], segments: number, degree: number) => {
      if (curveMethodRef.current === "casteljau") {
        return generateBezierCurveCasteljauN(pointsVec, segments);
      }

      return generateBezierCurvePolynomialN(pointsVec, segments);
    };

    const addBezierFromControlPoints = (
      points: ControlPoint[],
      color: number,
      segments: number = segmentsRef.current
    ) => {
      const deg = degreeRef.current;
      const windowSize = Math.max(2, deg + 1);
      if (points.length < windowSize) {
        return;
      }

      for (let i = 0; i + windowSize - 1 < points.length; i += 2) {
        const ctrl = points.slice(i, i + windowSize).map((p) => p.position);
        if (ctrl.length === windowSize) {
          const curvePoints = buildCurvePoints(ctrl, segments, deg);
          addLine(curvePoints, color);
        }
      }
    };

    // 曲線を確定してリセット
    const finishCurve = (isClosed: boolean = false) => {
      if (controlPoints.length === 0) {
        return;
      }

      // 最後の点が青点なら撤回する（ただし閉曲線の場合は除外）
      if (!isClosed && controlPoints.length > 1 && controlPoints[controlPoints.length - 1].type === "blue") {
        controlPoints.pop();
        removeLastPointObject();
      }

      // 保存するオブジェクト数を記録
      const pointsCount = controlPoints.length;
      const linesCount = isClosed ? Math.max(0, pointsCount) : Math.max(0, pointsCount - 1);

      if (controlPoints.length > 0) {
        closedCurves.push([...controlPoints]);
        closedCurveMeta.push({ points: pointsCount, lines: linesCount });
      }

      // 確定した時点で制御点表示は消す
      for (let i = 0; i < pointsCount; i++) {
        removeLastPointObject();
      }

      controlPoints = [];
      currentCurveStart = null;
      pushHistory();
    };

    // Control point を追加
    const addControlPoint = (position: THREE.Vector3) => {
      const deg = Math.max(1, degreeRef.current);
      const stride = deg; // 次数 n のとき区間のシフト幅
      const windowSize = deg + 1; // 必要な制御点数

      // 色付け: ウィンドウの先頭・末尾を赤、それ以外を青にする（先頭は index % stride == 0）
      const type = controlPoints.length % stride === 0 ? "red" : "blue";

      if (type === "red" && currentCurveStart === null) {
        currentCurveStart = position.clone();
      }

      // 始点近傍なら閉曲線として確定（始点表示は消えていても始点座標は保持）
      if (type === "red" && currentCurveStart && controlPoints.length >= deg) {
        const distToStart = position.distanceTo(currentCurveStart);
        if (distToStart < 10) {
          const closingRed: ControlPoint = {
            position: currentCurveStart.clone(),
            type: "red",
          };

          // 最後の degree 個の制御点を取得して closing を付けて描画
          const lastPts = controlPoints.slice(Math.max(0, controlPoints.length - deg)).map(p => p.position);
          const ctrl = [...lastPts, closingRed.position];
          const curvePts = buildCurvePoints(ctrl, segmentsRef.current, degreeRef.current);
          addLine(curvePts, 0x8f96a3);
          closedCurveRendered.push({ points: curvePts.map((p) => ({ x: p.x, y: p.y })), color: 0x8f96a3 });

          controlPoints.push(closingRed);
          finishCurve(true);
          return;
        }
      }

      // 赤点を追加する場合、既存の赤点との距離を確認
      if (type === "red" && controlPoints.length > 0) {
        for (const point of controlPoints) {
          if (point.type === "red") {
            const dist = position.distanceTo(point.position);
            if (dist < 10) {
              // 閉曲線判定：距離が近い場合
              const closingRed: ControlPoint = {
                position: point.position.clone(),
                type: "red",
              };

              // 最後の degree 個の制御点を取得して closing を付けて描画
              if (controlPoints.length >= deg) {
                const lastPts = controlPoints.slice(Math.max(0, controlPoints.length - deg)).map(p => p.position);
                const ctrl = [...lastPts, closingRed.position];
                const curvePts = buildCurvePoints(ctrl, segmentsRef.current, degreeRef.current);
                addLine(curvePts, 0x8f96a3);
                closedCurveRendered.push({ points: curvePts.map((p) => ({ x: p.x, y: p.y })), color: 0x8f96a3 });
              }

              controlPoints.push(closingRed);
              finishCurve(true);
              return;
            }
          }
        }
      }

      controlPoints.push({ position, type });
      addPoint(position, type === "red" ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));

      // ウィンドウが埋まったら（degree+1 個揃ったら）描画し、先頭 stride 個を削除して次区間に進む
      if (controlPoints.length >= windowSize) {
        const seg = controlPoints.slice(controlPoints.length - windowSize);
        const ctrl = seg.map((p) => p.position);
        const curvePts = buildCurvePoints(ctrl, segmentsRef.current, degreeRef.current);
        addLine(curvePts, 0x8f96a3);
        closedCurveRendered.push({ points: curvePts.map((p) => ({ x: p.x, y: p.y })), color: 0x8f96a3 });

        // この区間は確定済みとして保存
        closedCurves.push(seg.map((p) => ({ position: p.position.clone(), type: p.type })));
        closedCurveMeta.push({ points: windowSize, lines: 1 });

        // 確定した制御点は先頭 stride 個を消す（末尾の赤点は残る）
        controlPoints.splice(0, stride);
        for (let i = 0; i < stride; i++) {
          removeFirstPointObject();
        }
      }

      pushHistory();
    };

    // マウスイベント用の状態
    let isDragging = false;
    let prevMouseX = 0;
    let prevMouseY = 0;

    // マウスダウンイベント
    const handleCanvasMouseDown = (event: MouseEvent) => {
      // 右クリック（button === 2）で点を追加
      if (event.button === 2) {
        const worldPos = screenToWorld(event.clientX, event.clientY);
        addControlPoint(worldPos);
      }
      // 左クリック（button === 0）でドラッグ開始
      else if (event.button === 0) {
        isDragging = true;
        prevMouseX = event.clientX;
        prevMouseY = event.clientY;
      }
    };

    // マウスムーブイベント
    const handleCanvasMouseMove = (event: MouseEvent) => {
      if (!isDragging) {
        return;
      }

      const deltaX = event.clientX - prevMouseX;
      const deltaY = event.clientY - prevMouseY;

      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);

      // ワールド座標での移動量を計算
      const worldDeltaX = -(deltaX / width) * (camera.right - camera.left);
      const worldDeltaY = (deltaY / height) * (camera.top - camera.bottom);

      // カメラを移動（逆方向）
      camera.left += worldDeltaX;
      camera.right += worldDeltaX;
      camera.top += worldDeltaY;
      camera.bottom += worldDeltaY;
      camera.updateProjectionMatrix();

      prevMouseX = event.clientX;
      prevMouseY = event.clientY;
    };

    // ホイールでカーソル位置を中心にズーム
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();

      const rect = container.getBoundingClientRect();
      const clientX = event.clientX;
      const clientY = event.clientY;

      const worldBefore = screenToWorld(clientX, clientY);

      const scale = event.deltaY > 0 ? 1.1 : 0.9;

      const newLeft = worldBefore.x - (worldBefore.x - camera.left) * scale;
      const newRight = worldBefore.x + (camera.right - worldBefore.x) * scale;
      const newTop = worldBefore.y + (camera.top - worldBefore.y) * scale;
      const newBottom = worldBefore.y - (worldBefore.y - camera.bottom) * scale;

      camera.left = newLeft;
      camera.right = newRight;
      camera.top = newTop;
      camera.bottom = newBottom;
      camera.updateProjectionMatrix();
    };

    // マウスアップイベント
    const handleCanvasMouseUp = () => {
      isDragging = false;
    };

    // コンテキストメニュー抑止
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    // Finish ボタンイベント
    const handleFinish = () => {
      finishCurve();
    };

    // Delete All
    const deleteAll = () => {
      // clear renderer objects
      clearSceneObjects();
      // reset state
      controlPoints = [];
      currentCurveStart = null;
      closedCurves.length = 0;
      closedCurveMeta.length = 0;
      closedCurveRendered.length = 0;
      pushHistory();
    };

    // Undo (一つ前の操作を取り消す)
    const undo = () => {
      // 進行中のポイントがあれば最後のポイントを削除
      if (controlPoints.length > 0) {
        const lastIndex = controlPoints.length - 1;
        // If there is more than one control point, a connecting line was added when the last point was placed.
        const shouldRemoveLine = controlPoints.length > 1;

        controlPoints.pop();
        // remove last rendered point
        removeLastPointObject();

        // Remove the connecting line only if it was created for this point
        if (shouldRemoveLine) {
          // remove last rendered line
          if ((rendererApi as any).getLineCount && (rendererApi as any).getLineCount() > 0) {
            (rendererApi as any).removeLastLine();
          }
        }

        return;
      }

      // 完了済みの曲線があれば、まずは「直前に確定した曲線を未確定に戻す」挙動を優先
      if (closedCurves.length > 0) {
        // pop last completed curve and restore it to controlPoints
        const lastCurve = closedCurves.pop()!;
        const meta = closedCurveMeta.pop()!;

        // remove the closing line that was drawn at finish (if any)
        if ((rendererApi as any).getLineCount && (rendererApi as any).getLineCount() > 0) {
          (rendererApi as any).removeLastLine();
        }

        // restore controlPoints to the curve's points (so user returns to blue-point context)
        controlPoints = [...lastCurve];

        return;
      }
    };

    domElement.addEventListener("mousedown", handleCanvasMouseDown);
    domElement.addEventListener("mousemove", handleCanvasMouseMove);
    domElement.addEventListener("mouseup", handleCanvasMouseUp);
    domElement.addEventListener("contextmenu", handleContextMenu);
    // wheel for zoom (preventDefault to allow smooth zoom)
    domElement.addEventListener("wheel", handleWheel as EventListener, { passive: false });
    finishButtonRef.current?.addEventListener("click", handleFinish);
    // attach handlers for deleteAll/undo/redo buttons if present
    const deleteButton = document.getElementById("delete-all-button");
    const undoButton = document.getElementById("undo-button");
    const redoButton = document.getElementById("redo-button");
    deleteButton?.addEventListener("click", deleteAll);
    undoButton?.addEventListener("click", undoHistory);
    redoButton?.addEventListener("click", redoHistory);

    // push initial snapshot
    pushHistory();

    // rendererApi manages resize and render loop

    return () => {
      redrawRef.current = null;
      // rendererApi handles animation and resize internally
      domElement.removeEventListener("mousedown", handleCanvasMouseDown);
      domElement.removeEventListener("mousemove", handleCanvasMouseMove);
      domElement.removeEventListener("mouseup", handleCanvasMouseUp);
      domElement.removeEventListener("contextmenu", handleContextMenu);
      domElement.removeEventListener("wheel", handleWheel as EventListener);
      finishButtonRef.current?.removeEventListener("click", handleFinish);
      const deleteButton = document.getElementById("delete-all-button");
      const undoButton = document.getElementById("undo-button");
      const redoButton = document.getElementById("redo-button");
      deleteButton?.removeEventListener("click", deleteAll as EventListener);
      undoButton?.removeEventListener("click", undoHistory as EventListener);
      redoButton?.removeEventListener("click", redoHistory as EventListener);
      // dispose renderer and all objects
      (rendererApi as any).dispose();
    };
  }, []);

  return (
    <div className="app">
      <div className="viewer" ref={containerRef} />
      <div className="hud">
        <div>Bezier 2D Viewer (three.js)</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label htmlFor="segments-slider">segments</label>
          <input
            id="segments-slider"
            type="range"
            min={8}
            max={256}
            step={1}
            value={segments}
            onChange={(event) => {
              const next = Number(event.target.value);
              setSegments(next);
              segmentsRef.current = next;
              redrawRef.current?.();
            }}
          />
          <span>{segments}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label htmlFor="curve-method">method</label>
          <select
            id="curve-method"
            value={curveMethod}
            onChange={(event) => {
              const next = event.target.value as CurveMethod;
              setCurveMethod(next);
              curveMethodRef.current = next;
              redrawRef.current?.();
            }}
          >
            <option value="polynomial">polynomial</option>
            <option value="casteljau">de Casteljau</option>
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label>degree</label>
          <button
            onClick={() => {
              const next = Math.max(1, degree - 1);
              if (degreeChangeHandlerRef.current) {
                degreeChangeHandlerRef.current(next);
              } else {
                setDegree(next);
                degreeRef.current = next;
                redrawRef.current?.();
              }
            }}
          >
            -
          </button>
          <div style={{ width: 28, textAlign: "center" }}>{degree}</div>
          <button
            onClick={() => {
              const next = Math.min(10, degree + 1);
              if (degreeChangeHandlerRef.current) {
                degreeChangeHandlerRef.current(next);
              } else {
                setDegree(next);
                degreeRef.current = next;
                redrawRef.current?.();
              }
            }}
          >
            +
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button ref={finishButtonRef} className="finish-button">
            Finish Curve
          </button>
          <button id="undo-button" className="finish-button">
            ←
          </button>
          <button id="redo-button" className="finish-button">
            →
          </button>
          <button id="delete-all-button" className="finish-button">
            Delete All
          </button>
        </div>
      </div>
    </div>
  );
}
