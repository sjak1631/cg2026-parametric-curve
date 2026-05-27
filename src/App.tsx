import "./styles.css";
import { useState } from "react";
import DeveloperApp from "./DeveloperApp";
import PainterApp from "./PainterApp";

type Mode = "developer" | "painter";

export default function App() {
  const [mode, setMode] = useState<Mode>("painter");
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 10,
          display: "flex",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 8,
          background: "rgba(32, 35, 42, 0.85)",
          color: "#f8fafc",
          fontSize: 12,
        }}
      >
        <span style={{ alignSelf: "center", opacity: 0.7 }}>mode</span>
        <ModeButton current={mode} value="developer" onClick={setMode} label="developer" />
        <ModeButton current={mode} value="painter" onClick={setMode} label="painter" />
      </div>
      {mode === "developer" ? <DeveloperApp /> : <PainterApp />}
    </div>
  );
}

function ModeButton({
  current,
  value,
  onClick,
  label,
}: {
  current: Mode;
  value: Mode;
  onClick: (v: Mode) => void;
  label: string;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        border: active ? "1px solid #3b82f6" : "1px solid #475569",
        background: active ? "#3b82f6" : "#1f2937",
        color: "#f8fafc",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
