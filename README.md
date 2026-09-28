# Digital Room

Основа приложения — фотографический Gaussian-аватар с движением суставов в браузере.
Есть просмотр примера HUGS, управление позой и загрузка личных фотографий.
**Автоматическая реконструкция человека по загруженным фото пока не подключена.**
Сохранённые наборы не являются готовыми аватарами.

## Запуск

На подготовленном компьютере, из корня проекта:

```powershell
docker compose up -d --build avatar-photos
./scripts/prepare-gaussian-demo.ps1
npm --prefix apps/web ci
npm --prefix apps/web run dev
```

Откройте http://127.0.0.1:5173. «Мои фотографии» позволяет выбрать JPEG/PNG/WebP,
посмотреть их, сохранить набор и удалить его. Наборы доступны в том же браузере:
очистка cookie лишает доступа. Хранилище находится в Docker volume avatar-photos.
Лимиты: 32 фото, 10 МБ и 24 Мп на фото, 100 МБ на набор.

Для примера нужен подготовленный пакет `.runtime/hugs-output/browser-lab`.
На новой машине его нужно экспортировать по [инструкции](services/avatar/gaussian/README.md).
Пример HUGS принадлежит авторам набора; это не пользовательский человек.
При сильных сгибах пока видны артефакты. Локальный импорт PLY/SPLAT без скелета
отображается как статическая модель.

## Проверка

```powershell
.venv/Scripts/python.exe -m pytest services/avatar/tests -q
npm --prefix apps/web test
npm --prefix apps/web run build
cd apps/web
npx playwright test
```

Браузерным тестам нужны подготовленный Gaussian-пакет и работающий avatar-photos.
Они проверяют настоящие загрузку, хранение, перезагрузку страницы и удаление набора.
Тяжёлые проверки старого backend с PostgreSQL/Blender без настройки пропускаются.

[Сервис и ограничения](services/avatar/README.md) ·
[Актуальный план](docs/superpowers/plans/2026-09-26-personal-photo-avatar.md) ·
[Контекст для нового чата](docs/handoff/current.md).