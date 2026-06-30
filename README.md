# WA Web Dump (extensão Chrome)

Empacota o script `wa-web-dump.js` (auth + app-state) numa extensão MV3. Em vez
de colar no console do DevTools, você clica num botão e baixa o `wa-web-dump.json`.

## Por que precisa rodar no MAIN world

O dump acessa o sistema de módulos interno do WhatsApp Web (`__d` / `require`,
ex.: `WAWebUserPrefsInfoStore`, `WAWebSchemaSyncKeys`). Esses globais só existem
no contexto da própria página. Um content script normal roda num mundo isolado e
**não** os enxerga. Por isso a extensão injeta a função com
`chrome.scripting.executeScript({ world: 'MAIN' })`.

## Instalar

1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor** (canto superior direito)
3. **Carregar sem compactação** → selecione a pasta `extension/`

## Usar

1. Clique no ícone da extensão. O popup detecta o estado e mostra um badge:
   **conectado** (verde), **aguardando login** (amarelo) ou **fechado** (vermelho).
2. **Abrir / focar WhatsApp Web** — abre/foca a aba. Faça login se preciso.
3. **Fazer dump & baixar JSON** — executa o dump e baixa `wa-web-dump.json`.
   Aparece um card com `regId`, `meJid` e um checklist (✓/✗) do que foi capturado
   (`noiseKey`, `identityKey`, `signedPreKey`, contagem de app-state). Botões
   **Copiar JSON** e **Baixar de novo** reaproveitam o último dump.

### Enviar para uma API REST

Expanda **"Enviar para uma API REST"**, informe o endpoint, um header de auth
opcional e o método (`POST`/`PUT`), e clique em **Dump & enviar**. As configs
ficam salvas. Na primeira vez o Chrome pede permissão para o domínio (necessário
para o `fetch` cross-origin; com a permissão concedida o `fetch` ignora CORS).

O header de auth aceita `Nome: valor` (ex. `Authorization: Bearer xxx` ou
`X-Api-Key: abc`); se você passar só o valor, vira `Authorization: <valor>`.

## Observações

- `noiseKey` nulo: o caminho de fallback só funciona antes do primeiro
  `success`. Num tab já logado o caminho do módulo interno costuma resolver;
  se mesmo assim vier nulo, será necessário re-parear (você mantém a identidade
  libsignal, só a chave de transporte Noise é rotacionada).
- `advSecretKey`: o wa-web apaga após o pareamento. A sessão migra normalmente
  sem ela; só um futuro re-pair precisaria.
- O arquivo contém credenciais da **sua própria** sessão. Trate como segredo.

## Arquivos

- `manifest.json` — MV3, permissões `scripting`/`tabs`/`downloads` + host `web.whatsapp.com`.
- `popup.html` / `popup.js` — UI e a função `runWaDump` injetada no MAIN world.
