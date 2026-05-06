import "./styles.css";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { generateBezierCurve } from "./curve";

interface ControlPoint {
  position: THREE.Vector3;
  type: "red" | "blue"; // red: 通る点, blue: 通らない点
}

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const finishButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f8fa);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);

    const lineObjects: THREE.Line[] = [];
    const pointObjects: THREE.Mesh[] = [];
    let controlPoints: ControlPoint[] = [];
    const closedCurves: ControlPoint[][] = []; // 完成した曲線群
    const closedCurveMeta: { points: number; lines: number }[] = []; // 完成曲線ごとのオブジェクト数

    // undo/redo 用の履歴 (スナップショット)
    type Snapshot = {
      controlPoints: { x: number; y: number; z: number; type: "red" | "blue" }[];
      closedCurves: { points: { x: number; y: number; z: number; type: "red" | "blue" }[]; closed: boolean }[];
    };

    const history: Snapshot[] = [];
    let historyIndex = -1;

    const createSnapshot = (): Snapshot => ({
      controlPoints: controlPoints.map((p) => ({ x: p.position.x, y: p.position.y, z: p.position.z, type: p.type })),
      closedCurves: closedCurves.map((curve, i) => ({
        points: curve.map((p) => ({ x: p.position.x, y: p.position.y, z: p.position.z, type: p.type })),
        closed: closedCurveMeta[i] ? closedCurveMeta[i].lines >= closedCurveMeta[i].points : false,
      })),
    });

    const clearSceneObjects = () => {
      while (lineObjects.length) {
        const l = lineObjects.pop()!;
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
        scene.remove(l);
      }
      while (pointObjects.length) {
        const p = pointObjects.pop()!;
        (p.geometry as THREE.BufferGeometry).dispose();
        (p.material as THREE.Material).dispose();
        scene.remove(p);
      }
    };

    const restoreSnapshot = (snap: Snapshot) => {
      // clear current objects
      clearSceneObjects();

      // reset state arrays
      controlPoints = [];
      closedCurves.length = 0;
      closedCurveMeta.length = 0;

      // restore closed curves
      for (const c of snap.closedCurves) {
        const pts: ControlPoint[] = [];
        for (const pt of c.points) {
          const v = new THREE.Vector3(pt.x, pt.y, pt.z);
          pts.push({ position: v, type: pt.type });
          addPoint(v, pt.type === "red" ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));
        }
        // draw lines between consecutive points
        for (let i = 1; i < pts.length; i++) {
          addLine([pts[i - 1].position, pts[i].position], 0x8f96a3);
        }
        // if closed, add closing line
        if (c.closed && pts.length > 1) {
          addLine([pts[pts.length - 1].position, pts[0].position], 0x8f96a3);
        }
        closedCurves.push(pts);
        const lines = c.closed ? pts.length : Math.max(0, pts.length - 1);
        closedCurveMeta.push({ points: pts.length, lines });
      }

      // restore current control points
      for (const pt of snap.controlPoints) {
        const v = new THREE.Vector3(pt.x, pt.y, pt.z);
        controlPoints.push({ position: v, type: pt.type });
        addPoint(v, pt.type === "red" ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));
      }
      for (let i = 1; i < controlPoints.length; i++) {
        addLine([controlPoints[i - 1].position, controlPoints[i].position], 0x8f96a3);
      }
    };

    const pushHistory = () => {
      const snap = createSnapshot();
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

    const addLine = (points: THREE.Vector3[], color: number) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color });
      const line = new THREE.Line(geometry, material);
      scene.add(line);
      lineObjects.push(line);
    };

    const addPoint = (position: THREE.Vector3, color: THREE.Color) => {
      const geometry = new THREE.SphereGeometry(3, 24, 24);
      const material = new THREE.MeshBasicMaterial({ color });
      const sphere = new THREE.Mesh(geometry, material);
      sphere.position.copy(position);
      scene.add(sphere);
      pointObjects.push(sphere);
    };

    // スクリーン座標をワールド座標に変換
    const screenToWorld = (clientX: number, clientY: number): THREE.Vector3 => {
      const rect = container.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;

      const normalizedX = (x / rect.width) * 2 - 1;
      const normalizedY = -(y / rect.height) * 2 + 1;

      const vector = new THREE.Vector3(normalizedX, normalizedY, 0);
      vector.unproject(camera);

      return vector;
    };

    // 曲線を確定してリセット
    const finishCurve = (isClosed: boolean = false) => {
      if (controlPoints.length === 0) {
        return;
      }

      // 最後の点が青点なら撤回する（ただし閉曲線の場合は除外）
      if (!isClosed && controlPoints.length > 1 && controlPoints[controlPoints.length - 1].type === "blue") {
        const lastPoint = controlPoints.pop();
        pointObjects.pop();
        (scene.children[scene.children.length - 1] as THREE.Object3D).parent && scene.remove(scene.children[scene.children.length - 1]);
        lineObjects.pop();
        (scene.children[scene.children.length - 1] as THREE.Object3D).parent && scene.remove(scene.children[scene.children.length - 1]);
      }

      // 保存するオブジェクト数を記録
      const pointsCount = controlPoints.length;
      const linesCount = isClosed ? Math.max(0, pointsCount) : Math.max(0, pointsCount - 1);

      if (controlPoints.length > 0) {
        closedCurves.push([...controlPoints]);
        closedCurveMeta.push({ points: pointsCount, lines: linesCount });
      }

      controlPoints = [];
      pushHistory();
    };

    // Control point を追加
    const addControlPoint = (position: THREE.Vector3) => {
      // 赤、青、赤、青...の交互パターン
      const type = controlPoints.length % 2 === 0 ? "red" : "blue";

      // 赤点を追加する場合、既存の赤点との距離を確認
      if (type === "red" && controlPoints.length > 0) {
        for (const point of controlPoints) {
          if (point.type === "red") {
            const dist = position.distanceTo(point.position);
            if (dist < 10) {
              // 閉曲線判定：距離が近い場合
              // 最後の点（青点）と既存の赤点を結ぶ線を描画
              if (controlPoints.length > 1) {
                const lastPoint = controlPoints[controlPoints.length - 1];
                addLine([lastPoint.position, point.position], 0x8f96a3);
              }
              finishCurve(true);
              return;
            }
          }
        }
      }

      controlPoints.push({ position, type });
      addPoint(position, type === "red" ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));

      // 前のポイントがあれば接続線を描画
      if (controlPoints.length > 1) {
        const prevPoint = controlPoints[controlPoints.length - 2];
        const currentPoint = controlPoints[controlPoints.length - 1];
        addLine([prevPoint.position, currentPoint.position], 0x8f96a3);
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
      // remove lines
      while (lineObjects.length) {
        const l = lineObjects.pop()!;
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
        scene.remove(l);
      }
      // remove points
      while (pointObjects.length) {
        const p = pointObjects.pop()!;
        (p.geometry as THREE.BufferGeometry).dispose();
        (p.material as THREE.Material).dispose();
        scene.remove(p);
      }
      // reset state
      controlPoints = [];
      closedCurves.length = 0;
      closedCurveMeta.length = 0;
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
        const lastPoint = pointObjects.pop();
        if (lastPoint) {
          (lastPoint.geometry as THREE.BufferGeometry).dispose();
          (lastPoint.material as THREE.Material).dispose();
          scene.remove(lastPoint);
        }

        // Remove the connecting line only if it was created for this point
        if (shouldRemoveLine) {
          const lastLine = lineObjects.pop();
          if (lastLine) {
            lastLine.geometry.dispose();
            (lastLine.material as THREE.Material).dispose();
            scene.remove(lastLine);
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
        if (lineObjects.length > 0) {
          const closingLine = lineObjects.pop()!;
          closingLine.geometry.dispose();
          (closingLine.material as THREE.Material).dispose();
          scene.remove(closingLine);
        }

        // restore controlPoints to the curve's points (so user returns to blue-point context)
        controlPoints = [...lastCurve];

        return;
      }
    };

    renderer.domElement.addEventListener("mousedown", handleCanvasMouseDown);
    renderer.domElement.addEventListener("mousemove", handleCanvasMouseMove);
    renderer.domElement.addEventListener("mouseup", handleCanvasMouseUp);
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);
    // wheel for zoom (preventDefault to allow smooth zoom)
    renderer.domElement.addEventListener("wheel", handleWheel as EventListener, { passive: false });
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

    const resize = () => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);

      renderer.setSize(width, height);

      camera.left = -width / 2;
      camera.right = width / 2;
      camera.top = height / 2;
      camera.bottom = -height / 2;
      camera.updateProjectionMatrix();
    };

    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    let animationFrameId = 0;
    const render = () => {
      animationFrameId = window.requestAnimationFrame(render);
      renderer.render(scene, camera);
    };
    render();

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("mousedown", handleCanvasMouseDown);
      renderer.domElement.removeEventListener("mousemove", handleCanvasMouseMove);
      renderer.domElement.removeEventListener("mouseup", handleCanvasMouseUp);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      renderer.domElement.removeEventListener("wheel", handleWheel as EventListener);
      finishButtonRef.current?.removeEventListener("click", handleFinish);
      const deleteButton = document.getElementById("delete-all-button");
      const undoButton = document.getElementById("undo-button");
      const redoButton = document.getElementById("redo-button");
      deleteButton?.removeEventListener("click", deleteAll as EventListener);
      undoButton?.removeEventListener("click", undoHistory as EventListener);
      redoButton?.removeEventListener("click", redoHistory as EventListener);

      for (const line of lineObjects) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
        scene.remove(line);
      }

      for (const point of pointObjects) {
        (point.geometry as THREE.BufferGeometry).dispose();
        (point.material as THREE.Material).dispose();
        scene.remove(point);
      }

      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="app">
      <div className="viewer" ref={containerRef} />
      <div className="hud">
        <div>Bezier 2D Viewer (three.js)</div>
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
