import React, { useEffect, useState } from "react";

type Capture = {
  id: string;
  created_at: string;
  photo_count: number;
  status: "photos_ready";
};
const api = "/v1/photo-captures";
async function request(path = "", options?: RequestInit) {
  const response = await fetch(api + path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Error(
      typeof body.detail === "string"
        ? body.detail
        : "Сервис фотографий недоступен. Попробуйте позже.",
    );
  }
  return response.status === 204 ? null : response.json();
}
export function Photos() {
  const [files, setFiles] = useState<File[]>([]),
    [previews, setPreviews] = useState<string[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoaded(false);
    request("", { signal: controller.signal })
      .then((items) => {
        if (active) {
          setCaptures(items);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [retry]);
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);
  const upload = async () => {
    if (!loaded || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      files.forEach((file) => body.append("photos", file));
      const item = await request("", { method: "POST", body });
      setCaptures((items) => [item, ...items]);
      setFiles([]);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await request(`/${id}`, { method: "DELETE" });
      setCaptures((items) => items.filter((item) => item.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="photo-workspace" aria-label="Личные фотографии">
      <h2>Ваши фотографии</h2>
      <p>
        Подготовьте фотографии одного человека в одинаковой одежде: в полный
        рост спереди, сзади и с двух боков. Ровный свет, видимые руки и ноги,
        без фильтров.
      </p>
      <div className="photo-notice">
        <strong>Создание аватара пока недоступно</strong>
        <p>
          Фото можно сохранить уже сейчас. Движок реконструкции ещё не
          подключён; сохранение набора не запускает обучение и не заменяет
          человека в примере.
        </p>
      </div>
      <label>
        Фотографии человека
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            const selected = Array.from(e.target.files || []);
            e.target.value = "";
            setError("");
            if (
              selected.length > 32 ||
              selected.some((file) => file.size > 10 * 1024 * 1024) ||
              selected.reduce((sum, file) => sum + file.size, 0) >
                100 * 1024 * 1024
            ) {
              setError("До 32 фотографий, 10 МБ на фото и 100 МБ на набор");
              return;
            }
            setFiles(selected);
          }}
        />
      </label>
      <p className="gaussian-note">
        JPEG, PNG или WebP · до 32 фото · до 10 МБ и 24 Мп на фото · до 100 МБ
        всего
      </p>
      <div className="photo-previews">
        {previews.map((url, i) => (
          <img key={url} src={url} alt={`Выбранное фото ${i + 1}`} />
        ))}
      </div>
      <button
        disabled={!loaded || !files.length || busy}
        onClick={() => void upload()}
      >
        {busy ? "Обработка…" : "Сохранить фотографии"}
      </button>
      <p className="gaussian-note">
        Наборы хранятся локально на сервере приложения и доступны в этом
        браузере. Очистка cookie лишит доступа к ним. Удалить набор можно ниже.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loaded && error && (
        <button
          onClick={() => {
            setError("");
            setRetry((value) => value + 1);
          }}
        >
          Проверить соединение
        </button>
      )}
      <h3>Сохранённые наборы</h3>
      {loaded && !captures.length && <p>Сохранённых наборов пока нет.</p>}
      <div className="photo-captures">
        {captures.map((item) => (
          <article key={item.id}>
            <img src={`${api}/${item.id}/photos/0`} alt="Первое фото набора" />
            <div>
              <strong>Фото сохранены</strong>
              <p>
                {item.photo_count} фото ·{" "}
                {new Date(item.created_at).toLocaleString("ru-RU")}
              </p>
              <p className="gaussian-note">Аватар ещё не создан</p>
            </div>
            <button disabled={busy} onClick={() => void remove(item.id)}>
              Удалить набор
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
