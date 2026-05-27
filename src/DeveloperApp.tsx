import "./styles.css";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { generateBezierCurvePolynomialN, generateBezierCurveCasteljauN, generateBezierCurveMonomialN, generateCatmullRomSplineSegment, generateNURBSCurve } from "./curve";
import { createParameterValues, type ParametrizationType } from "./parameterization";
import { createThreeRenderer } from "./threeRenderer";

interface ControlPoint {
  position: THREE.Vector3;
  type: "red" | "blue"; // red: 通る点, blue: 通らない点
  t?: number;
}

type CurveMethod = "polynomial" | "casteljau" | "monomial";
type CurveType = "bezier" | "spline" | "nurbs";

export default function DeveloperApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const finishButtonRef = useRef<HTMLButtonElement | null>(null);
  const segmentsRef = useRef(64);
  const redrawRef = useRef<(() => void) | null>(null);
  const curveMethodRef = useRef<CurveMethod>("polynomial");
  const curveTypeRef = useRef<CurveType>("bezier");
  const catmullRomParameterTypeRef = useRef<ParametrizationType>("uniform");
  const degreeRef = useRef<number>(2);
  const [segments, setSegments] = useState(64);
  const [curveType, setCurveType] = useState<CurveType>("bezier");
  const [catmullRomParameterType, setCatmullRomParameterType] = useState<ParametrizationType>("uniform");
  const [curveMethod, setCurveMethod] = useState<CurveMethod>("polynomial");
  const [degree, setDegree] = useState<number>(2);
  const degreeChangeHandlerRef = useRef<((next: number) => void) | null>(null);
  const typeChangeHandlerRef = useRef<((next: CurveType) => void) | null>(null);
  const nurbsDegreeRef = useRef<number>(3);
  const nurbsParameterTypeRef = useRef<ParametrizationType>("uniform");
  const updateNurbsWeightRef = useRef<((idx: number, val: number) => void) | null>(null);
  const [nurbsDegree, setNurbsDegree] = useState<number>(3);
  const [nurbsParameterType, setNurbsParameterType] = useState<ParametrizationType>("uniform");
  const [nurbsWeightsState, setNurbsWeightsState] = useState<number[]>([]);
  const [nurbsOverlayPositions, setNurbsOverlayPositions] = useState<{ x: number; y: number }[]>([]);

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
    const closedCurveInfo: { curveType: CurveType; degree: number }[] = []; // 各セグメントの曲線種別と次数

    // NURBS 用状態変数
    let nurbsPoints: THREE.Vector3[] = [];
    let nurbsWeights: number[] = [];
    let nurbsDragIndex: number | null = null;
    const NURBS_PICK_RADIUS_PX = 10;

    // オーバーレイ位置をスクリーン座標に変換して React state に同期
    const syncOverlay = () => {
      const rect = container.getBoundingClientRect();
      setNurbsOverlayPositions(nurbsPoints.map(p => ({
        x: (p.x - camera.left) / (camera.right - camera.left) * rect.width,
        y: (1 - (p.y - camera.bottom) / (camera.top - camera.bottom)) * rect.height,
      })));
      setNurbsWeightsState([...nurbsWeights]);
    };

    updateNurbsWeightRef.current = (idx: number, val: number) => {
      nurbsWeights[idx] = val;
      setNurbsWeightsState([...nurbsWeights]);
      redrawRef.current?.();
    };

    // undo/redo 用の履歴 (スナップショット)
    type Snapshot = {
      controlPoints: { x: number; y: number; type: "red" | "blue"; t?: number }[];
      currentCurveStart: { x: number; y: number } | null;
      closedCurves: {
        points: { x: number; y: number; type: "red" | "blue"; t?: number }[];
        closed: boolean;
        curveType: CurveType;
        degree: number;
      }[];
      closedRendered: { points: { x: number; y: number }[]; color: number }[];
      nurbsPoints: { x: number; y: number }[];
      nurbsWeights: number[];
    };

    const history: Snapshot[] = [];
    let historyIndex = -1;

    const createSnapshot = (): Snapshot => ({
      controlPoints: controlPoints.map((p) => ({ x: p.position.x, y: p.position.y, type: p.type, t: p.t })),
      currentCurveStart: currentCurveStart
        ? { x: currentCurveStart.x, y: currentCurveStart.y }
        : null,
      closedCurves: closedCurves.map((curve, i) => ({
        points: curve.map((p) => ({ x: p.position.x, y: p.position.y, type: p.type, t: p.t })),
        closed: closedCurveMeta[i] ? closedCurveMeta[i].lines >= closedCurveMeta[i].points : false,
        curveType: closedCurveInfo[i]?.curveType ?? "bezier",
        degree: closedCurveInfo[i]?.degree ?? degreeRef.current,
      })),
      closedRendered: closedCurveRendered.map((r) => ({ points: r.points.map((pt) => ({ x: pt.x, y: pt.y })), color: r.color })),
      nurbsPoints: nurbsPoints.map((p) => ({ x: p.x, y: p.y })),
      nurbsWeights: [...nurbsWeights],
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
      closedCurveInfo.length = 0;
      nurbsPoints = snap.nurbsPoints.map((p) => new THREE.Vector3(p.x, p.y));
      nurbsWeights = snap.nurbsWeights ? [...snap.nurbsWeights] : nurbsPoints.map(() => 1.0);
      nurbsDragIndex = null;

      // restore closed curves data (control points only)
      for (const c of snap.closedCurves) {
        const pts: ControlPoint[] = [];
        for (const pt of c.points) {
          const v = new THREE.Vector3(pt.x, pt.y);
          pts.push({ position: v, type: pt.type, t: pt.t });
        }
        closedCurves.push(pts);
        const lines = c.closed ? pts.length : Math.max(0, pts.length - 1);
        closedCurveMeta.push({ points: pts.length, lines });
        closedCurveInfo.push({ curveType: c.curveType ?? "bezier", degree: c.degree ?? degreeRef.current });
      }

      // restore rendered curve geometries
      // bezier/spline は現在の設定で再評価し、NURBS は保存済み座標で復元する
      closedCurveRendered.length = 0;
      for (let ri = 0; ri < snap.closedRendered.length; ri++) {
        const r = snap.closedRendered[ri];
        const curveSnap = snap.closedCurves[ri];
        if (curveSnap?.curveType === "bezier") {
          const ctrl = curveSnap.points.map((p) => new THREE.Vector3(p.x, p.y));
          const curvePoints = buildCurvePoints(ctrl, segmentsRef.current, curveSnap.degree);
          addLine(curvePoints, r.color);
          closedCurveRendered.push({ points: curvePoints.map((p) => ({ x: p.x, y: p.y })), color: r.color });
        } else if (curveSnap?.curveType === "spline") {
          const ctrl = curveSnap.points.map((p) => new THREE.Vector3(p.x, p.y));
          const paramValues = createParameterValues(ctrl, catmullRomParameterTypeRef.current);
          const splinePoints = buildSplineSegmentPoints(
            ctrl[0], ctrl[1], ctrl[2], ctrl[3],
            paramValues[0], paramValues[1], paramValues[2], paramValues[3],
            segmentsRef.current
          );
          addLine(splinePoints, r.color);
          closedCurveRendered.push({ points: splinePoints.map((p) => ({ x: p.x, y: p.y })), color: r.color });
        } else {
          const pts = r.points.map((p) => new THREE.Vector3(p.x, p.y));
          addLine(pts, r.color);
          closedCurveRendered.push({ points: r.points.map((p) => ({ x: p.x, y: p.y })), color: r.color });
        }
      }

      // restore current control points
      for (const pt of snap.controlPoints) {
        const v = new THREE.Vector3(pt.x, pt.y);
        controlPoints.push({ position: v, type: pt.type, t: pt.t });
        addPoint(v, pt.type === "red" ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));
      }

      // restore NURBS points
      for (const p of nurbsPoints) {
        const passing = ((nurbsPoints.length - 1 - nurbsPoints.indexOf(p)) % 2) === 0;
        addPoint(p, passing ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));
      }
      if (nurbsPoints.length >= 2) {
        addLine([...nurbsPoints], 0xbfc7d5);
        const wts = nurbsWeights.length === nurbsPoints.length ? nurbsWeights : undefined;
        const samples = generateNURBSCurve([...nurbsPoints], wts, segmentsRef.current, nurbsDegreeRef.current, undefined, nurbsParameterTypeRef.current);
        if (samples.length >= 2) addLine(samples, 0x2563eb);
      }

      addActiveCurveFromControlPoints(controlPoints, 0x8f96a3);
      syncOverlay();
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

    const buildSplineSegmentPoints = (
      p0: THREE.Vector3,
      p1: THREE.Vector3,
      p2: THREE.Vector3,
      p3: THREE.Vector3,
      t0: number,
      t1: number,
      t2: number,
      t3: number,
      segments: number
    ) => {
      return generateCatmullRomSplineSegment(p0, p1, p2, p3, t0, t1, t2, t3, segments);
    };

    // 次数変更時のハンドラを登録（マウント内で controlPoints 等へアクセス可能）
    degreeChangeHandlerRef.current = (next: number) => {
      if (curveTypeRef.current !== "bezier") {
        degreeRef.current = next;
        setDegree(next);
        return;
      }

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

    typeChangeHandlerRef.current = (next: CurveType) => {
      const current = curveTypeRef.current;
      if (next === current) {
        return;
      }

      if (controlPoints.length > 0) {
        (rendererApi as any).removeAllPointObjects();
        controlPoints = [];
        currentCurveStart = null;
        pushHistory();
      }

      if (nurbsPoints.length > 0) {
        (rendererApi as any).removeAllPointObjects();
        nurbsPoints = [];
        nurbsWeights = [];
        nurbsDragIndex = null;
        syncOverlay();
        pushHistory();
      }

      curveTypeRef.current = next;
      setCurveType(next);
      redrawRef.current?.();
    };

    const buildCurvePoints = (pointsVec: THREE.Vector3[], segments: number, degree: number) => {
      if (curveMethodRef.current === "casteljau") {
        return generateBezierCurveCasteljauN(pointsVec, degree, segments);
      }

      if (curveMethodRef.current === "monomial") {
        return generateBezierCurveMonomialN(pointsVec, degree, segments);
      }

      return generateBezierCurvePolynomialN(pointsVec, degree, segments);
    };

    const addSplineFromControlPoints = (
      points: ControlPoint[],
      color: number,
      segments: number = segmentsRef.current
    ) => {
      if (points.length < 4) {
        return;
      }

      for (let i = 0; i + 3 < points.length; i += 1) {
        const segmentPoints = buildSplineSegmentPoints(
          points[i].position,
          points[i + 1].position,
          points[i + 2].position,
          points[i + 3].position,
          points[i].t ?? i,
          points[i + 1].t ?? i + 1,
          points[i + 2].t ?? i + 2,
          points[i + 3].t ?? i + 3,
          segments
        );
        addLine(segmentPoints, color);
      }
    };

    const addNurbsFromControlPoints = (
      points: ControlPoint[],
      color: number,
      segments: number = segmentsRef.current
    ) => {
      if (points.length < 2) {
        return;
      }

      const ctrl = points.map((p) => p.position);
      const curvePoints = generateNURBSCurve(ctrl, undefined, segments);
      addLine(curvePoints, color);
    };

    const addActiveCurveFromControlPoints = (
      points: ControlPoint[],
      color: number,
      segments: number = segmentsRef.current
    ) => {
      if (curveTypeRef.current === "spline") {
        addSplineFromControlPoints(points, color, segments);
        return;
      }
      if (curveTypeRef.current === "nurbs") {
        addNurbsFromControlPoints(points, color, segments);
        return;
      }

      addBezierFromControlPoints(points, color, segments);
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
      const hasControl = controlPoints.length > 0;
      const hasNurbs = nurbsPoints.length > 0;

      if (!hasControl && !hasNurbs) {
        return;
      }

      if (curveTypeRef.current === "spline") {
        if (!hasControl) return;
        const pointsCount = controlPoints.length;
        for (let i = 0; i < pointsCount; i++) {
          removeLastPointObject();
        }

        controlPoints = [];
        currentCurveStart = null;
        pushHistory();
        return;
      }

      if (curveTypeRef.current === "nurbs") {
        if (!hasNurbs) return;
        // Remove all NURBS control point objects
        const pointsCount = nurbsPoints.length;
        for (let i = 0; i < pointsCount; i++) {
          removeLastPointObject();
        }
        // Remove control polygon line
        if (pointsCount >= 2) removeLastPointObject(); // for control polygon
        // Remove NURBS curve line
        const wts0 = nurbsWeights.length === nurbsPoints.length ? nurbsWeights : undefined;
        const samples0 = generateNURBSCurve([...nurbsPoints], wts0, segmentsRef.current, nurbsDegreeRef.current, undefined, nurbsParameterTypeRef.current);
        if (samples0.length >= 2) removeLastPointObject();

        // Save to closedCurves for display
        if (nurbsPoints.length >= 2) {
          const n = nurbsPoints.length;
          const isClosed_nurbs = n >= 3 && Math.hypot(
            nurbsPoints[n - 1].x - nurbsPoints[0].x,
            nurbsPoints[n - 1].y - nurbsPoints[0].y
          ) < 1e-6;
          closedCurves.push(nurbsPoints.map((p) => ({
            position: p.clone(),
            type: "red" as const,
          })));
          closedCurveMeta.push({ points: nurbsPoints.length, lines: 1 });
          closedCurveInfo.push({ curveType: "nurbs", degree: nurbsDegreeRef.current });

          // Commit the final NURBS curve
          const wts1 = nurbsWeights.length === nurbsPoints.length ? nurbsWeights : undefined;
          const samples = generateNURBSCurve([...nurbsPoints], wts1, segmentsRef.current, nurbsDegreeRef.current, undefined, nurbsParameterTypeRef.current);
          if (samples.length >= 2) {
            const pts = samples.map((p) => new THREE.Vector3(p.x, p.y));
            addLine(pts, 0x8f96a3);
            closedCurveRendered.push({ points: pts.map((p) => ({ x: p.x, y: p.y })), color: 0x8f96a3 });
          }
        }

        nurbsPoints = [];
        nurbsWeights = [];
        nurbsDragIndex = null;
        syncOverlay();
        pushHistory();
        return;
      }

      // Bezier handling
      if (!hasControl) return;

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
        closedCurveInfo.push({ curveType: "bezier", degree: degreeRef.current });
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
      if (curveTypeRef.current === "nurbs") {
        // NURBS: 既存制御点をピック可能にして、ドラッグ開始 or 新規追加
        // ここではクリック=新規追加のみ。ドラッグはマウスイベントで処理。
        nurbsPoints.push(position);
        nurbsWeights.push(1.0);

        // 全体を再描画する
        (rendererApi as any).clearSceneObjects();

        // 制御点を描画
        const N = nurbsPoints.length;
        for (let i = 0; i < N; i++) {
          const passing = ((N - 1 - i) % 2) === 0;
          addPoint(nurbsPoints[i], passing ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));
        }

        // 制御ポリゴンを描画
        if (N >= 2) {
          addLine([...nurbsPoints], 0xbfc7d5);
        }

        // NURBS曲線を描画
        if (N >= 2) {
          const wts = nurbsWeights.length === N ? nurbsWeights : undefined;
          const samples = generateNURBSCurve([...nurbsPoints], wts, segmentsRef.current, nurbsDegreeRef.current, undefined, nurbsParameterTypeRef.current);
          if (samples.length >= 2) {
            addLine(samples, 0x2563eb);
          }
        }

        syncOverlay();
        pushHistory();
        return;
      }

      if (curveTypeRef.current === "spline") {
        controlPoints.push({ position, type: "red" });

        // パラメータ値を再計算
        const positions = controlPoints.map(p => p.position);
        const paramValues = createParameterValues(positions, catmullRomParameterTypeRef.current);
        controlPoints.forEach((cp, i) => { cp.t = paramValues[i]; });

        addPoint(position, new THREE.Color(0xff0000));

        if (controlPoints.length >= 4) {
          const last4 = controlPoints.slice(controlPoints.length - 4);
          const splinePoints = buildSplineSegmentPoints(
            last4[0].position,
            last4[1].position,
            last4[2].position,
            last4[3].position,
            last4[0].t ?? 0,
            last4[1].t ?? 1,
            last4[2].t ?? 2,
            last4[3].t ?? 3,
            segmentsRef.current
          );
          addLine(splinePoints, 0x8f96a3);
          closedCurveRendered.push({ points: splinePoints.map((p) => ({ x: p.x, y: p.y })), color: 0x8f96a3 });
          closedCurves.push(last4.map((p) => ({ position: p.position.clone(), type: p.type, t: p.t })));
          closedCurveMeta.push({ points: 4, lines: 1 });
          closedCurveInfo.push({ curveType: "spline", degree: 0 });

          controlPoints.shift();
          removeFirstPointObject();
        }

        pushHistory();
        return;
      }

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
          // パラメータ値を再計算（closing red を追加した場合）
          const positionsWithClosing = controlPoints.map(p => p.position).concat(currentCurveStart);
          const paramValues = createParameterValues(positionsWithClosing, catmullRomParameterTypeRef.current);
          const closingRed: ControlPoint = {
            position: currentCurveStart.clone(),
            type: "red",
            t: paramValues[paramValues.length - 1],
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
              // パラメータ値を再計算（closing red を追加した場合）
              const positionsWithClosing = controlPoints.map(p => p.position).concat(point.position);
              const paramValues = createParameterValues(positionsWithClosing, catmullRomParameterTypeRef.current);
              const closingRed: ControlPoint = {
                position: point.position.clone(),
                type: "red",
                t: paramValues[paramValues.length - 1],
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
        closedCurves.push(seg.map((p) => ({ position: p.position.clone(), type: p.type, t: p.t })));
        closedCurveMeta.push({ points: windowSize, lines: 1 });
        closedCurveInfo.push({ curveType: "bezier", degree: degreeRef.current });

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
      // 左クリック（button === 0）で点を追加
      if (event.button === 0) {
        const worldPos = screenToWorld(event.clientX, event.clientY);

        // NURBS: 既存制御点をピック可能にする
        if (curveTypeRef.current === "nurbs") {
          let hitIdx = -1;
          let bestDist = NURBS_PICK_RADIUS_PX;
          for (let i = 0; i < nurbsPoints.length; i++) {
            const screenPos = screenToWorld(event.clientX, event.clientY);
            const rect = container.getBoundingClientRect();
            const sx = screenToWorld(event.clientX, event.clientY).x;
            const sy = screenToWorld(event.clientX, event.clientY).y;

            // screen coordinates distance
            const dx = event.clientX - (rect.left + (nurbsPoints[i].x - camera.left) / (camera.right - camera.left) * rect.width);
            const dy = event.clientY - (rect.top + (camera.top - nurbsPoints[i].y) / (camera.top - camera.bottom) * rect.height);
            const d = Math.hypot(dx, dy);
            if (d < bestDist) { bestDist = d; hitIdx = i; }
          }
          if (hitIdx >= 0) {
            nurbsDragIndex = hitIdx;
            isDragging = true;
            prevMouseX = event.clientX;
            prevMouseY = event.clientY;
            return;
          }
        }

        addControlPoint(worldPos);
      }
      // 右クリック（button === 2）でドラッグ開始
      else if (event.button === 2) {
        isDragging = true;
        prevMouseX = event.clientX;
        prevMouseY = event.clientY;
      }
    };

    // マウスムーブイベント
    const handleCanvasMouseMove = (event: MouseEvent) => {
      // NURBS point dragging
      if (curveTypeRef.current === "nurbs" && nurbsDragIndex !== null && isDragging) {
        const worldPos = screenToWorld(event.clientX, event.clientY);
        nurbsPoints[nurbsDragIndex] = worldPos.clone();

        // 全体を再描画する
        (rendererApi as any).clearSceneObjects();

        // 制御点を描画
        const N = nurbsPoints.length;
        for (let i = 0; i < N; i++) {
          const passing = ((N - 1 - i) % 2) === 0;
          addPoint(nurbsPoints[i], passing ? new THREE.Color(0xff0000) : new THREE.Color(0x0000ff));
        }

        // 制御ポリゴンを描画
        if (N >= 2) {
          addLine([...nurbsPoints], 0xbfc7d5);
        }

        // NURBS曲線を描画
        if (N >= 2) {
          const wts = nurbsWeights.length === N ? nurbsWeights : undefined;
          const samples = generateNURBSCurve([...nurbsPoints], wts, segmentsRef.current, nurbsDegreeRef.current, undefined, nurbsParameterTypeRef.current);
          if (samples.length >= 2) {
            addLine(samples, 0x2563eb);
          }
        }

        syncOverlay();
        return;
      }

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
      if (nurbsPoints.length > 0) syncOverlay();
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
      if (nurbsPoints.length > 0) syncOverlay();
    };

    // マウスアップイベント
    const handleCanvasMouseUp = () => {
      if (curveTypeRef.current === "nurbs" && nurbsDragIndex !== null) {
        nurbsDragIndex = null;
        pushHistory();
      }
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
      closedCurveInfo.length = 0;
      // NURBS関連の状態をリセット
      nurbsPoints = [];
      nurbsWeights = [];
      setNurbsWeightsState([]);
      setNurbsOverlayPositions([]);
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
      {curveType === "nurbs" && nurbsOverlayPositions.length > 0 && (
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          {nurbsOverlayPositions.map((pos, idx) => (
            <div
              key={idx}
              style={{
                position: "absolute",
                left: pos.x + 10,
                top: pos.y - 12,
                pointerEvents: "auto",
                display: "flex",
                alignItems: "center",
                gap: 2,
                background: "rgba(12, 16, 24, 0.82)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 4,
                padding: "1px 4px",
                fontSize: 11,
                color: "#e2e8f0",
                userSelect: "none",
                lineHeight: 1.5,
              }}
            >
              <button
                style={{ width: 16, height: 16, padding: 0, cursor: "pointer", fontSize: 12, border: "none", background: "transparent", color: "inherit" }}
                onClick={() => {
                  const cur = nurbsWeightsState[idx] ?? 1.0;
                  updateNurbsWeightRef.current?.(idx, Math.max(0.1, +(cur - 0.1).toFixed(1)));
                }}
              >−</button>
              <span style={{ minWidth: 28, textAlign: "center" }}>{(nurbsWeightsState[idx] ?? 1.0).toFixed(1)}</span>
              <button
                style={{ width: 16, height: 16, padding: 0, cursor: "pointer", fontSize: 12, border: "none", background: "transparent", color: "inherit" }}
                onClick={() => {
                  const cur = nurbsWeightsState[idx] ?? 1.0;
                  updateNurbsWeightRef.current?.(idx, Math.min(10.0, +(cur + 0.1).toFixed(1)));
                }}
              >+</button>
            </div>
          ))}
        </div>
      )}
      <div className="hud">
        <div>Parametric Curve Editor</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label htmlFor="curve-type">type</label>
          <select
            id="curve-type"
            value={curveType}
            onChange={(event) => {
              const next = event.target.value as CurveType;
              if (typeChangeHandlerRef.current) {
                typeChangeHandlerRef.current(next);
              } else {
                curveTypeRef.current = next;
                setCurveType(next);
                redrawRef.current?.();
              }
            }}
          >
            <option value="bezier">bezier</option>
            <option value="spline">spline (catmull-rom)</option>
            <option value="nurbs">nurbs</option>
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label htmlFor="segments-slider">segments</label>
          <input
            id="segments-slider"
            type="range"
            min={8}
            max={10000}
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
        {curveType === "spline" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="catmull-rom-parameter">parameter</label>
            <select
              id="catmull-rom-parameter"
              value={catmullRomParameterType}
              onChange={(event) => {
                const next = event.target.value as ParametrizationType;
                catmullRomParameterTypeRef.current = next;
                setCatmullRomParameterType(next);
                redrawRef.current?.();
              }}
            >
              <option value="uniform">uniform</option>
              <option value="chordal">chordal</option>
              <option value="centripetal">centripetal</option>
            </select>
          </div>
        )}
        {curveType === "bezier" && (
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
              <option value="monomial">monomial (unstable)</option>
            </select>
          </div>
        )}
        {curveType === "bezier" && (
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
                const next = degree + 1;
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
        )}
        {curveType === "nurbs" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label>degree</label>
              <button onClick={() => {
                const next = Math.max(1, nurbsDegree - 1);
                setNurbsDegree(next);
                nurbsDegreeRef.current = next;
                redrawRef.current?.();
              }}>-</button>
              <div style={{ width: 28, textAlign: "center" }}>{nurbsDegree}</div>
              <button onClick={() => {
                const maxDeg = Math.max(1, nurbsOverlayPositions.length - 1);
                const next = Math.min(maxDeg > 0 ? maxDeg : 10, nurbsDegree + 1);
                setNurbsDegree(next);
                nurbsDegreeRef.current = next;
                redrawRef.current?.();
              }}>+</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label>knot</label>
              <select value={nurbsParameterType} onChange={(e) => {
                const next = e.target.value as ParametrizationType;
                setNurbsParameterType(next);
                nurbsParameterTypeRef.current = next;
                redrawRef.current?.();
              }}>
                <option value="uniform">uniform</option>
                <option value="chordal">chordal</option>
                <option value="centripetal">centripetal</option>
              </select>
            </div>
          </>
        )}
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
