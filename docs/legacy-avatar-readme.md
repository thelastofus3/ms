# Digital Room

Прототип сервиса аватаров для цифровой копии комнаты. Реализован путь MPFB → GLB → React/Three.js, API заданий и отдельный воркер. Генерация комнаты, камера, распознавание участников и конференция пока описаны в [архитектуре](docs/README.md), но не реализованы.

## Запуск на Windows

Требуются Python 3.13, Node.js 22+ (проверено на 24), Git, Docker Desktop и доступ к интернету при установке. Генератор работает на CPU; GPU нужен браузеру для просмотра. Инструменты и результаты находятся в `.tools` и `.runtime` и исключены из Git.

Из корня проекта:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-avatar.ps1
py -3.13 -m venv .venv
.venv/Scripts/python.exe -m pip install -r services/avatar/requirements.lock
.venv/Scripts/python.exe -m pip install -e 'services/avatar[test]'
npm --prefix apps/web ci
docker compose up -d avatar-db
```

Запустите три процесса в отдельных терминалах из корня проекта:

```powershell
# Терминал 1: API. Этот токен предназначен только для локальной разработки.
$env:AVATAR_TOKENS='{"local-dev-alice":"alice"}'
.venv/Scripts/python.exe -m uvicorn avatar_service.api:create_app --factory --host 127.0.0.1 --port 8001
```

```powershell
# Терминал 2: один воркер
.venv/Scripts/python.exe -m avatar_service.worker
```

```powershell
# Терминал 3: интерфейс
npm --prefix apps/web run dev
```

Откройте **http://127.0.0.1:5173**, введите `local-dev-alice`, настройте профиль и нажмите «Создать аватара». Фото используются оператором как эталоны, а не для автоматического восстановления лица. После просмотра можно подтвердить внешность, скачать пакет или создать следующую версию того же аватара.

W/S перемещают аватара, A/D поворачивают; сначала нажмите на сцену. Мышь управляет камерой. «Тест позы» подаёт синтетические движения — это не подключение реальной камеры.

Для просмотра без API сначала сгенерируйте локальное демо, затем нажмите «Открыть демо»:

```powershell
.venv/Scripts/python.exe -m avatar_service.cli generate --profile services/avatar/examples/profile.json --output apps/web/public/demo
```

Команда не перезаписывает существующий каталог. Для повторной генерации выберите новый каталог. Проверка пакета: `python -m avatar_service.cli validate PATH` из установленного окружения.

## Проверка

```powershell
$env:AVATAR_INTEGRATION='1'
$env:AVATAR_TEST_DATABASE_URL='postgresql+psycopg://avatar:avatar-local@127.0.0.1:55432/avatar'
.venv/Scripts/python.exe -m pytest services/avatar/tests -q
npm --prefix apps/web test
npm --prefix apps/web run build
```

Для браузерных тестов нужно сгенерированное демо; для полного сценария — запущенные API и воркер:

```powershell
Set-Location apps/web
npx playwright install chromium
$env:AVATAR_E2E_TOKEN='local-dev-alice'
npm run test:browser
```

Тесты очереди PostgreSQL следует выполнять при остановленном рабочем воркере: они создают задания и самостоятельно захватывают их. Используйте отдельную тестовую БД, если в основной есть реальные задания. Без переменных окружения тяжёлые Blender/PostgreSQL проверки явно пропускаются.

Подробности: [сервис и API](services/avatar/README.md), [контракты движения](contracts/avatar/README.md), [лицензии инструментов и ассетов](services/avatar/THIRD_PARTY.md), [план реализации](docs/superpowers/plans/2026-09-23-avatar-implementation.md).

Варианты следующего этапа, без удаления MPFB: [реалистичные меши и Gaussian-аватары](docs/research/2026-09-25-realistic-avatar-options.md), [схема draw.io](docs/architecture/avatar-evolution.drawio).
