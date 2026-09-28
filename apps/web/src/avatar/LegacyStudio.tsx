import React, { useEffect, useRef, useState } from "react";

import { AvatarRenderer, type Manifest } from "./renderer";



type Job = {
  id: string;
  avatar_id: string;
  version: number;
  status: string;
  error?: string;
  approved?: boolean;
};
export function LegacyStudio() {
  const container = useRef<HTMLDivElement>(null),
    renderer = useRef<AvatarRenderer | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [token, setToken] = useState(""),
    [name, setName] = useState("Новый аватар"),
    [height, setHeight] = useState(1.8);
  const [gender, setGender] = useState(0.5),
    [age, setAge] = useState(0.4),
    [muscle, setMuscle] = useState(0.5),
    [weight, setWeight] = useState(0.5);
  const [noseWidth, setNoseWidth] = useState(0),
    [chinWidth, setChinWidth] = useState(0),
    [eyeSize, setEyeSize] = useState(0);
  const [skin, setSkin] = useState("#b98970"),
    [clothing, setClothing] = useState("#375a91"),
    [hairColor, setHairColor] = useState("#382923"),
    [hair, setHair] = useState("short");
  const [message, setMessage] = useState("Откройте демо или создайте аватара"),
    [details, setDetails] = useState(""),
    [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [source, setSource] = useState("клавиатура");
  const [references, setReferences] = useState<{ id: string; url: string }[]>(
    [],
  );
  const previews = useRef<string[]>([]);
  const previewGeneration = useRef(0);
  const [displayedJobId, setDisplayedJobId] = useState<string | null>(null);
  function beginPreview() {
    setDisplayedJobId(null);
    setMessage("Загрузка модели…");
    renderer.current?.cancelPendingLoads();
    return ++previewGeneration.current;
  }
  useEffect(() => {
    const view = new AvatarRenderer(container.current!);
    renderer.current = view;
    return () => {
      view.dispose();
      if (timer.current) clearInterval(timer.current);
      for (const url of previews.current) URL.revokeObjectURL(url);
    };
  }, []);
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ detail: response.statusText }));
      throw Error(
        typeof body.detail === "string"
          ? body.detail
          : JSON.stringify(body.detail),
      );
    }
    return response;
  }
  async function show(
    manifest: Manifest,
    bytes: ArrayBuffer,
    generation: number,
    jobId: string | null = null,
  ) {
    if (generation !== previewGeneration.current) return;
    if (timer.current) clearInterval(timer.current);
    const info = await renderer.current!.load(manifest, bytes);
    if (!info || generation !== previewGeneration.current) return;
    setDisplayedJobId(jobId);
    setSource("клавиатура");
    setMessage("Модель загружена");
    if (info)
      setDetails(
        `${info.bones} костей · рост ${info.height.toFixed(2)} м · ${info.clips.join(", ")}`,
      );
  }
  async function demo() {
    setError("");
    const generation = beginPreview();
    try {
      const manifestResponse = await fetch("/demo/manifest.json");
      if (!manifestResponse.ok)
        throw Error("Демо не сгенерировано. Выполните команду из README.");
      const manifest = await manifestResponse.json();
      await show(
        manifest,
        await (await fetch("/demo/avatar.glb")).arrayBuffer(),
        generation,
      );
    } catch (e) {
      setError(String(e));
    }
  }
  async function preview(current: Job) {
    const generation = beginPreview();
    setError("");
    const base = `/v1/avatars/${current.avatar_id}/versions/${current.version}`;
    try {
      const manifest = await (await request(base)).json();
      if (
        manifest.avatar_id !== current.avatar_id ||
        manifest.version !== current.version
      )
        throw Error("Получена другая версия аватара");
      await show(
        manifest,
        await (await request(base + "/model")).arrayBuffer(),
        generation,
        current.id,
      );
    } catch (error) {
      if (generation === previewGeneration.current) {
        setError(String(error));
        setMessage("Не удалось загрузить модель");
      }
    }
  }
  useEffect(() => {
    if (!job || !["QUEUED", "RUNNING"].includes(job.status)) return;
    let active = true;
    const handle = setInterval(async () => {
      try {
        const next = await (await request("/v1/avatar-jobs/" + job.id)).json();
        if (!active) return;
        setJob(next);
        if (next.status === "SUCCEEDED") {
          await preview(next);
        }
        if (next.status === "FAILED") setError(next.error);
      } catch (e) {
        if (active) setError(String(e));
      }
    }, 1500);
    return () => {
      active = false;
      clearInterval(handle);
    };
  }, [job?.id, job?.status, token]);
  async function create() {
    setDisplayedJobId(null);
    setBusy(true);
    setError("");
    try {
      const next = await (
        await request("/v1/avatar-jobs", {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            avatar_id: job?.avatar_id,
            profile: {
              name,
              height_m: height,
              gender,
              age,
              muscle,
              weight,
              nose_width: noseWidth,
              chin_width: chinWidth,
              eye_size: eyeSize,
              skin_color: skin,
              clothing_color: clothing,
              hair_color: hairColor,
              hair,
              clothing: "casual",
              references: references.map((r) => r.id),
            },
          }),
        })
      ).json();
      setJob(next);
      setMessage("Генерация аватара");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    setError("");
    try {
      if (references.length + files.length > 4)
        throw Error("Можно загрузить до четырёх фотографий");
      const added: { id: string; url: string }[] = [];
      for (const file of files) {
        const data = new FormData();
        data.append("file", file);
        const result = await (
          await request("/v1/references", { method: "POST", body: data })
        ).json();
        const url = URL.createObjectURL(file);
        previews.current.push(url);
        added.push({ id: result.id, url });
      }
      setReferences((old) => [...old, ...added]);
    } catch (e) {
      setError(String(e));
    }
  }
  function mode(camera: boolean) {
    if (timer.current) clearInterval(timer.current);
    renderer.current?.controller?.setSource(camera ? "camera" : "keyboard");
    setSource(camera ? "тестовая поза" : "клавиатура");
    if (camera) {
      let sequence = 0;
      timer.current = setInterval(() => {
        const angle = 0.6 * Math.sin(sequence / 12);
        renderer.current?.controller?.receive(
          {
            sequence: sequence++,
            timestamp_ms: Date.now(),
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            joints: {
              leftUpperArm: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
              rightUpperArm: [0, 0, -Math.sin(angle / 2), Math.cos(angle / 2)],
            },
            confidence: 1,
            tracking_state: "TRACKED",
          },
          performance.now(),
        );
      }, 67);
    }
  }
  async function approve() {
    if (!job || displayedJobId !== job.id) return;
    try {
      await request(
        `/v1/avatars/${job.avatar_id}/versions/${job.version}/approve`,
        { method: "POST" },
      );
      setJob({ ...job, approved: true });
    } catch (e) {
      setError(String(e));
    }
  }
  async function download() {
    if (!job) return;
    try {
      const blob = await (
        await request(
          `/v1/avatars/${job.avatar_id}/versions/${job.version}/package`,
        )
      ).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `avatar-${job.avatar_id}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <main>
      <header>
        <div className="brand">
          ◈ <span>DIGITAL ROOM</span>
        </div>
        <span className="badge">AVATAR STUDIO · 01</span>
      </header>
      <div className="heading">
        <div>
          <p className="eyebrow">ПРОФИЛЬ УЧАСТНИКА</p>
          <h1>
            Ваше присутствие.
            <br />
            <span>В цифровом пространстве.</span>
          </h1>
        </div>
        <p>
          Создайте аватара, настройте внешность
          <br />и проверьте его движения.
        </p>
      </div>
      <div className="studio">
        <aside>
          <h2>01 / Внешность</h2>
          <label>
            Токен доступа
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Токен локального сервиса"
              autoComplete="off"
            />
          </label>
          <label>
            Имя
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </label>
          <label>
            Рост, м
            <input
              type="number"
              step=".01"
              min="1.2"
              max="2.3"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
            />
          </label>
          {(
            [
              ["Телосложение", gender, setGender],
              ["Возраст", age, setAge],
              ["Мышцы", muscle, setMuscle],
              ["Вес", weight, setWeight],
            ] as const
          ).map(([label, value, set]) => (
            <label key={label}>
              {label}
              <input
                type="range"
                min="0"
                max="1"
                step=".01"
                value={value}
                onChange={(e) => set(Number(e.target.value))}
              />
            </label>
          ))}
          <details>
            <summary>Черты лица</summary>
            {(
              [
                ["Ширина носа", noseWidth, setNoseWidth],
                ["Ширина подбородка", chinWidth, setChinWidth],
                ["Размер глаз", eyeSize, setEyeSize],
              ] as const
            ).map(([label, value, set]) => (
              <label key={label}>
                {label}
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step=".01"
                  value={value}
                  onChange={(e) => set(Number(e.target.value))}
                />
              </label>
            ))}
          </details>
          <div className="colors">
            <label>
              Кожа
              <input
                type="color"
                value={skin}
                onChange={(e) => setSkin(e.target.value)}
              />
            </label>
            <label>
              Одежда
              <input
                type="color"
                value={clothing}
                onChange={(e) => setClothing(e.target.value)}
              />
            </label>
            <label>
              Волосы
              <input
                type="color"
                value={hairColor}
                onChange={(e) => setHairColor(e.target.value)}
              />
            </label>
          </div>
          <label>
            Причёска
            <select value={hair} onChange={(e) => setHair(e.target.value)}>
              <option value="short">Короткая</option>
              <option value="none">Без волос</option>
            </select>
          </label>
          <label className="upload">
            + Фото-эталоны
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg"
              onChange={(e) => upload(e.target.files)}
              disabled={!token}
            />
          </label>
          <div className="references">
            {references.map((ref) => (
              <img key={ref.id} src={ref.url} alt="Фото-эталон участника" />
            ))}
          </div>
          <p className="hint">
            Фото служат ориентиром для ручной настройки. Автоматическое
            восстановление лица пока не подключено.
          </p>
          <button
            className="primary"
            disabled={busy || !token}
            onClick={create}
          >
            {busy
              ? "Отправка…"
              : job
                ? "Создать новую версию →"
                : "Создать аватара →"}
          </button>
        </aside>
        <section className="preview">
          <div className="preview-header">
            <span>02 / Предпросмотр</span>
            <span className="live">
              ● {source === "клавиатура" ? "REMOTE" : "TEST POSE"}
            </span>
          </div>
          <div
            ref={container}
            className="viewport"
            aria-label="Трёхмерный аватар"
          />
          <div className="preview-bottom">
            <strong>{message}</strong>
            <small>{details}</small>
            <p>Источник: {source}</p>
            <div className="buttons">
              <button onClick={demo}>Открыть демо</button>
              <button onClick={() => mode(false)}>Клавиатура</button>
              <button onClick={() => mode(true)}>Тест позы</button>
            </div>
            <p className="hint">
              Нажмите на сцену: W/S — движение, A/D — поворот. Мышь — обзор.
            </p>
          </div>
        </section>
      </div>
      <footer>
        {job ? (
          <>
            <span>
              Задание {job.id.slice(0, 8)} · {job.status}
            </span>
            {["QUEUED", "RUNNING"].includes(job.status) && (
              <button
                onClick={async () => {
                  try {
                    setJob(
                      await (
                        await request("/v1/avatar-jobs/" + job.id + "/cancel", {
                          method: "POST",
                        })
                      ).json(),
                    );
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Отменить
              </button>
            )}
            {job.status === "SUCCEEDED" && (
              <>
                <button onClick={() => preview(job)}>
                  Показать результат задания
                </button>
                <button
                  onClick={approve}
                  disabled={!!job.approved || displayedJobId !== job.id}
                >
                  {job.approved
                    ? "Внешность подтверждена"
                    : "Подтвердить внешность"}
                </button>
                <button onClick={download}>Скачать пакет</button>
              </>
            )}
          </>
        ) : (
          <span>MPFB · Скелетная модель · Локальная генерация</span>
        )}
      </footer>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </main>
  );
}
