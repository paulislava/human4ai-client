# human4ai-client

Клиент службы [human4ai](https://github.com/paulislava/human4ai): отдаёшь картинку капчи —
получаешь строку. Внутри у службы каскад «GigaChat → Claude → Павел в Telegram», но клиенту
это знать не нужно: только адрес и свой токен.

Без зависимостей, на встроенном `fetch` (Node 18+), с типами.

## Установка

```bash
npm i human4ai-client
# или прямо из приватного репозитория, без npm-реестра:
npm i github:paulislava/human4ai-client
```

## Разгадать капчу

```ts
import { Human4ai } from 'human4ai-client';

const client = new Human4ai({ token: process.env.HUMAN4AI_TOKEN! });

const { answer, answeredBy } = await client.solveCaptcha({
  image: pngBuffer,              // base64, data-URL или байты
  hint: '4 цифры',               // подсказка модели
  context: 'paulismapa-scraper', // кто просит — видно в логах службы
});

console.log(answer, answeredBy); // '7431' 'gigachat'
```

`answer === null` означает, что каскад не справился и истёк срок — решать, что делать
дальше, клиенту.

## Если сайт ответ не принял

«Решённой» капчу делает не модель, а сайт. На его отказ дёргаем `reject` — служба перейдёт
к следующей ступени и не будет повторно платить за уже провалившуюся:

```ts
const first = await client.solveCaptcha({ image });
if (!siteAccepted(first.answer)) {
  const second = await client.rejectCaptcha(first.id); // например, уже Claude или человек
}
```

То же самое одним вызовом:

```ts
const answer = await client.solveUntilAccepted(
  { image, hint: '4 цифры' },
  (candidate) => siteAccepted(candidate),   // true — приняли, false — дёрнуть reject
  3,                                        // сколько попыток
);
```

## Асинхронно

Когда ждать в том же запросе неудобно (капчу отдаёт воркер, ответ нужен позже):

```ts
const { id } = await client.createCaptcha({ image });
// …
const result = await client.getCaptcha(id);
```

## Спросить человека

Та же служба умеет задавать Павлу любой вопрос — реплаем в Telegram или голосом на
Яндекс-Станции (голосовой вопрос дублируется в Telegram, отвечает тот канал, который
быстрее):

```ts
const { answer } = await client.ask({
  question: 'Мержить MR 42?',
  channel: 'voice',            // 'telegram' по умолчанию
  options: ['да', 'нет'],
  context: 'NoSmoke CI',
});
```

Секреты (`kind: 'secret' | 'code'`) отдаются **один раз** и стираются из базы службы;
голосом они не спрашиваются — колонка проговорила бы их вслух.

## Прочее

```ts
await client.health();   // живость + какие ступени реально подключены
await client.stats();    // точность ступеней по логу попыток
```

## Опции конструктора

| Опция | По умолчанию | Зачем |
|---|---|---|
| `token` | — | обязателен, уходит в заголовке `X-Token` |
| `baseUrl` | `https://human4ai.paulislava.space/api` | своя инсталляция или локальная разработка |
| `requestTimeoutMs` | 11 мин | ограничение на один HTTP-запрос: синхронный вызов ждёт человека |
| `fetch` | глобальный | своя реализация для тестов и нестандартных рантаймов |

Ошибки службы приходят как `Human4aiError` с полями `status` и `body`; таймаут запроса —
тот же класс со `status: 0`.
