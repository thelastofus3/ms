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
    [name, setName] = useState("New avatar"),
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
  const [message, setMessage] = useState("Open the demo or create an avatar"),
    [details, setDetails] = useState(""),
    [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [source, setSource] = useState("keyboard");
  const [references, setReferences] = useState<{ id: string; url: string }[]>(
    [],
  );
  const previews = useRef<string[]>([]);
  const previewGeneration = useRef(0);
  const [displayedJobId, setDisplayedJobId] = useState<string | null>(null);
  function beginPreview() {
    setDisplayedJobId(null);
    setMessage("Loading model…");
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
    setSource("keyboard");
    setMessage("Model loaded");
    if (info)
      setDetails(
        `${info.bones} bones · height ${info.height.toFixed(2)} m · ${info.clips.join(", ")}`,
      );
  }
  async function demo() {
    setError("");
    const generation = beginPreview();
    try {
      const manifestResponse = await fetch("/demo/manifest.json");
      if (!manifestResponse.ok)
        throw Error("The demo has not been generated. Run the command from the README.");
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
        throw Error("A different avatar version was received");
      await show(
        manifest,
        await (await request(base + "/model")).arrayBuffer(),
        generation,
        current.id,
      );
    } catch (error) {
      if (generation === previewGeneration.current) {
        setError(String(error));
        setMessage("The model could not be loaded");
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
      setMessage("Generating avatar");
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
        throw Error("Up to four photos can be uploaded");
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
    setSource(camera ? "test pose" : "keyboard");
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
          <p className="eyebrow">PARTICIPANT PROFILE</p>
          <h1>
            Your presence.
            <br />
            <span>In a digital space.</span>
          </h1>
        </div>
        <p>
          Create an avatar, tune its appearance
          <br />and check how it moves.
        </p>
      </div>
      <div className="studio">
        <aside>
          <h2>01 / Appearance</h2>
          <label>
            Access token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Local service token"
              autoComplete="off"
            />
          </label>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </label>
          <label>
            Height, m
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
              ["Build", gender, setGender],
              ["Age", age, setAge],
              ["Muscle", muscle, setMuscle],
              ["Weight", weight, setWeight],
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
            <summary>Facial features</summary>
            {(
              [
                ["Nose width", noseWidth, setNoseWidth],
                ["Chin width", chinWidth, setChinWidth],
                ["Eye size", eyeSize, setEyeSize],
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
              Skin
              <input
                type="color"
                value={skin}
                onChange={(e) => setSkin(e.target.value)}
              />
            </label>
            <label>
              Clothing
              <input
                type="color"
                value={clothing}
                onChange={(e) => setClothing(e.target.value)}
              />
            </label>
            <label>
              Hair
              <input
                type="color"
                value={hairColor}
                onChange={(e) => setHairColor(e.target.value)}
              />
            </label>
          </div>
          <label>
            Hairstyle
            <select value={hair} onChange={(e) => setHair(e.target.value)}>
              <option value="short">Short</option>
              <option value="none">No hair</option>
            </select>
          </label>
          <label className="upload">
            + Reference photos
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
              <img key={ref.id} src={ref.url} alt="Participant reference photo" />
            ))}
          </div>
          <p className="hint">
            Photos are a reference for manual tuning. Automatic face
            reconstruction is not connected yet.
          </p>
          <button
            className="primary"
            disabled={busy || !token}
            onClick={create}
          >
            {busy
              ? "Sending…"
              : job
                ? "Create a new version →"
                : "Create avatar →"}
          </button>
        </aside>
        <section className="preview">
          <div className="preview-header">
            <span>02 / Preview</span>
            <span className="live">
              ● {source === "keyboard" ? "REMOTE" : "TEST POSE"}
            </span>
          </div>
          <div
            ref={container}
            className="viewport"
            aria-label="3D avatar"
          />
          <div className="preview-bottom">
            <strong>{message}</strong>
            <small>{details}</small>
            <p>Source: {source}</p>
            <div className="buttons">
              <button onClick={demo}>Open demo</button>
              <button onClick={() => mode(false)}>Keyboard</button>
              <button onClick={() => mode(true)}>Pose test</button>
            </div>
            <p className="hint">
              Click the scene: W/S move, A/D turn. Mouse looks around.
            </p>
          </div>
        </section>
      </div>
      <footer>
        {job ? (
          <>
            <span>
              Job {job.id.slice(0, 8)} · {job.status}
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
                Cancel
              </button>
            )}
            {job.status === "SUCCEEDED" && (
              <>
                <button onClick={() => preview(job)}>
                  Show job result
                </button>
                <button
                  onClick={approve}
                  disabled={!!job.approved || displayedJobId !== job.id}
                >
                  {job.approved
                    ? "Appearance confirmed"
                    : "Confirm appearance"}
                </button>
                <button onClick={download}>Download package</button>
              </>
            )}
          </>
        ) : (
          <span>MPFB · Skeletal model · Local generation</span>
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
