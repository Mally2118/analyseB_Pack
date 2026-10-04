# Размещение на GitHub Pages

Репозиторий: https://github.com/Mally2118/analyseB_Pack.

После успешной публикации стандартный адрес сайта будет https://mally2118.github.io/analyseB_Pack/. Адрес фактически опубликованного сайта также появится в Settings → Pages и в результате запуска workflow.

В проект уже добавлен `.github/workflows/pages.yml`. Он публикует содержимое `portfolio-lab/dist` при каждом обновлении ветки `main`. Сборка и установка npm-пакетов для публикации не нужны: HTML, JavaScript, CSS и библиотеки уже находятся в этой папке. Относительные пути позволяют сайту работать в подпапке `/analyseB_Pack/`.

## 1. Включить GitHub Pages

1. Откройте репозиторий на GitHub.
2. Перейдите в **Settings → Pages**.
3. В разделе **Build and deployment** выберите **Source → GitHub Actions**.

GitHub Pages на бесплатном плане доступен для публичных репозиториев. Если репозиторий приватный, для Pages нужен подходящий платный план либо публичный репозиторий. Меняйте видимость только если готовы открыть его содержимое.

## 2. Отправить подготовленные изменения

Откройте PowerShell в корневой папке `analyseB_Pack`, где расположены `README.md` и `.github`, и выполните команды по одной:

```powershell
git status
git add .
git commit -m "Configure GitHub Pages deployment"
git push origin main
```

Перед `git add .` проверьте список из `git status`: команда добавит все незакоммиченные изменения проекта. Каталоги зависимостей, тестовых отчётов и временные файлы исключены через `.gitignore`.

Если используете GitHub Desktop: выберите репозиторий, просмотрите изменения, выполните **Commit to main**, затем **Push origin**.

## 3. Дождаться публикации

1. В репозитории откройте **Actions**.
2. Выберите **Deploy GitHub Pages** и последний запуск.
3. Дождитесь успешного завершения задания `deploy`.
4. Откройте ссылку из результата задания или из **Settings → Pages**.

Если изменения были отправлены до включения Pages, после выбора GitHub Actions откройте **Actions → Deploy GitHub Pages → Run workflow → main → Run workflow**. Создавать новый коммит для повторного запуска не требуется.

## Обновления

После изменения файлов сайта сделайте новый коммит и `git push origin main`. Workflow заново разместит сайт. Локальное приложение запускается отдельно через `portfolio-lab/Запустить.bat`; сервер Node.js на GitHub Pages не используется. Excel обрабатывается браузером посетителя, загрузка файлов не требует серверной части.

## Если публикация не работает

- **404:** сначала проверьте успешное завершение workflow и адрес из Settings → Pages. Репозиторий `analyseB_Pack` публикуется в `/analyseB_Pack/`, а не в корне домена.
- **Get Pages site failed / Not Found:** в Settings → Pages должен быть выбран источник GitHub Actions, а Pages должен быть доступен на вашем плане.
- **Workflow не запускается:** файл должен находиться в `.github/workflows/pages.yml` в корне репозитория, изменения должны попасть в ветку `main`, GitHub Actions должен быть включён для репозитория.
- **Ошибка прав доступа или environment:** посмотрите текст ошибки в Actions. Workflow уже задаёт `pages: write`, `id-token: write` и среду `github-pages`; правила репозитория или организации могут дополнительно ограничивать публикацию.
- **git push отклонён:** проверьте сообщение Git и доступ к репозиторию. Не используйте принудительный push для обхода расхождения истории.

Официальные инструкции: [автоматическая публикация](https://docs.github.com/en/get-started/start-your-journey/deploying-your-website-automatically), [собственные workflows GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [доступность GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
