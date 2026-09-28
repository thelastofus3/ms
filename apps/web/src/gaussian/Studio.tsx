import React, { useEffect, useRef, useState } from "react";
import { GaussianRenderer } from "./renderer";
import type { Motion } from "./rig";
import { Photos } from "./Photos";

export function GaussianStudio() {
  const [photosOpen, setPhotosOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null),
    viewer = useRef<GaussianRenderer | undefined>(undefined);
  const [status, setStatus] = useState("Загрузка фотографического примера…");
  const [error, setError] = useState("");
  const [rigged, setRigged] = useState(false),
    [playing, setPlaying] = useState(true);
  const [motion, setMotion] = useState<Motion>("idle");
  const [source, setSource] = useState("HUGS · пример авторов, lab");
  const load = async (file?: File) => {
    const v = viewer.current;
    if (!v) return;
    setError("");
    setRigged(false);
    setStatus("Загрузка Gaussian…");
    try {
      const n = await (file ? v.loadFile(file) : v.loadDemo());
      if (viewer.current !== v || n === undefined) return;
      setRigged(!file);
      setSource(file ? file.name : "HUGS · пример авторов, lab");
      setStatus(
        `${n.toLocaleString("ru-RU")} Gaussian · ${file ? "статическая модель" : "24 сустава"}`,
      );
    } catch (e) {
      if (
        viewer.current !== v ||
        (e instanceof DOMException && e.name === "AbortError")
      )
        return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus("Не удалось загрузить модель");
    }
  };
  useEffect(() => {
    try {
      viewer.current = new GaussianRenderer(host.current!);
      void load();
    } catch (e) {
      setError(String(e));
    }
    return () => {
      viewer.current?.dispose();
      viewer.current = undefined;
    };
  }, []);
  return (
    <main className="gaussian-studio">
      <nav className="photo-navigation" aria-label="Аватар">
        <button aria-pressed={!photosOpen} onClick={() => setPhotosOpen(false)}>
          Просмотр аватара
        </button>
        <button aria-pressed={photosOpen} onClick={() => setPhotosOpen(true)}>
          Мои фотографии
        </button>
      </nav>
      <header>
        <p className="eyebrow">GAUSSIAN AVATAR</p>
        <h1>Фотографический аватар</h1>
        <p>Внешность из реальной съёмки. Движение суставов прямо в браузере.</p>
      </header>
      {photosOpen && <Photos />}
      <div
        className="gaussian-layout"
        style={photosOpen ? { display: "none" } : undefined}
      >
        <div className="gaussian-view" ref={host} />
        <aside className="gaussian-panel">
          <h2>Просмотр и движение</h2>
          <p>{source}</p>
          <p data-testid="gaussian-status">{status}</p>
          <label>
            Движение
            <select
              aria-label="Движение"
              value={motion}
              disabled={!rigged}
              onChange={(e) => {
                const value = e.target.value as Motion;
                setMotion(value);
                if (viewer.current) viewer.current.motion = value;
              }}
            >
              <option value="idle">Спокойная поза</option>
              <option value="wave">Помахать рукой</option>
              <option value="walk">Шаг на месте</option>
              <option value="canonical">Исходная поза</option>
            </select>
          </label>
          <button
            disabled={!rigged}
            onClick={() => {
              setPlaying(!playing);
              if (viewer.current) viewer.current.playing = !playing;
            }}
          >
            {playing ? "Пауза" : "Продолжить"}
          </button>
          <label>
            Развести руки
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              defaultValue="0"
              disabled={!rigged}
              onChange={(e) => {
                if (viewer.current) viewer.current.arms = +e.target.value;
              }}
            />
          </label>
          <button onClick={() => viewer.current?.resetView()}>
            Вернуть камеру
          </button>
          <hr />
          <label>
            Открыть PLY / SPLAT
            <input
              type="file"
              accept=".ply,.splat"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void load(file);
                e.target.value = "";
              }}
            />
          </label>
          <button onClick={() => void load()}>Загрузить пример HUGS</button>
          <p className="gaussian-note">
            {rigged
              ? "Экспериментальная привязка к скелету: при сильных сгибах возможны искажения. Это человек из открытого примера авторов; создание вашего аватара требует отдельной съёмки и обучения."
              : "Обычный PLY / SPLAT содержит внешность. Для движений человека нужны скелет и веса привязки."}
          </p>
        </aside>
      </div>
      <p className="gaussian-note">
        Мышь — поворот · колесо — приближение · правая кнопка — перемещение
        камеры
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
