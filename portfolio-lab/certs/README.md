# Сертификаты для статистики Росстата

Сайт Росстата использует сертификат `Russian Trusted Sub CA`. Для загрузки статистики в GitHub Actions нужен доверенный корневой сертификат этого удостоверяющего центра.

Публичные сертификаты в `rosstat-ca.pem` получены 6 октября 2026 года с официальных адресов, опубликованных для [сертификатов Госуслуг](https://www.gosuslugi.ru/crt):

- [Russian Trusted Root CA](https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt)
- [Russian Trusted Sub CA](https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt)

SHA-256 отпечатки DER-сертификатов:

```text
Root: D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31
Sub:  BBBDE2103E790B999EC62BD03CF625A5A2E7C316E10AFE6A490EEDEAD8B3FD9B
```

`node portfolio-lab/configure-rosstat-trust.mjs` получает текущую официальную пару по HTTPS и создаёт `portfolio-lab/artifacts/rosstat-ca.pem`. Проверяются закреплённый отпечаток корня, подписи, сроки действия и признак CA обоих сертификатов. Замена промежуточного сертификата допускается, если он подписан тем же корнем. При недоступности официальных файлов используется вложенная копия после тех же проверок.

GitHub Actions передаёт `NODE_EXTRA_CA_CERTS` только шагам подготовки цепочки и обновления статистики. Подготовка использует вложенную официальную пару, обновление — проверенный подготовленный файл. Хранилище доверия операционной системы не изменяется. Проверка HTTPS и имени сайта остаётся включённой; личные и корпоративные сертификаты в набор не входят. Сертификаты не попадают в публикуемую папку `dist`.

Механизмы проверки описаны в документации Node.js: [X509Certificate](https://nodejs.org/docs/latest-v24.x/api/crypto.html#class-x509certificate) и [NODE_EXTRA_CA_CERTS](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_extra_ca_certsfile).
