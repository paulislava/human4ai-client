import http from 'node:http';
import { Human4ai, Human4aiError, toBase64 } from './index';

/** Заглушка службы: отдаём заранее заданные ответы и запоминаем запросы. */
async function fakeService(
  handler: (req: {
    method: string;
    url: string;
    token: string | undefined;
    body: any;
  }) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>,
) {
  const requests: Array<{ method: string; url: string; token?: string; body: any }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString();
      const entry = {
        method: req.method!,
        url: req.url!,
        token: req.headers['x-token'] as string | undefined,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(entry);

      const result = await handler(entry);
      res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/api`,
    close: () =>
      new Promise<void>((resolve) => {
        // Оборванные клиентом соединения иначе держат server.close() открытым.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('Human4ai', () => {
  it('требует токен', () => {
    expect(() => new Human4ai({ token: '' })).toThrow(/token/);
  });

  it('шлёт капчу с токеном и получает ответ', async () => {
    const service = await fakeService(() => ({
      body: { id: 'task_1', status: 'solved', answer: 'a1b2', answeredBy: 'gigachat' },
    }));

    try {
      const client = new Human4ai({ token: 'secret-token', baseUrl: service.baseUrl });
      const result = await client.solveCaptcha({
        image: 'data:image/png;base64,QUJD',
        hint: '4 символа',
        solvers: ['gigachat'],
        timeoutMs: 5_000,
      });

      expect(result.answer).toBe('a1b2');
      expect(service.requests[0]).toMatchObject({
        method: 'POST',
        url: '/api/captcha/solve',
        token: 'secret-token',
        // Префикс data-URL срезан, таймаут ушёл в snake_case — как ждёт служба.
        body: { image: 'QUJD', hint: '4 символа', solvers: ['gigachat'], timeout_ms: 5_000 },
      });
    } finally {
      await service.close();
    }
  });

  it('принимает картинку байтами', async () => {
    const service = await fakeService(() => ({ body: { id: 'x', status: 'solved', answer: 'ok' } }));

    try {
      const client = new Human4ai({ token: 't', baseUrl: service.baseUrl });
      await client.solveCaptcha({ image: new Uint8Array([65, 66, 67]) });
      expect(service.requests[0].body.image).toBe('QUJD');
    } finally {
      await service.close();
    }
  });

  it('не отправляет пустые поля', async () => {
    const service = await fakeService(() => ({ body: { id: 'x', status: 'solved', answer: 'ok' } }));

    try {
      const client = new Human4ai({ token: 't', baseUrl: service.baseUrl });
      await client.solveCaptcha({ image: 'QUJD' });
      expect(Object.keys(service.requests[0].body)).toEqual(['image']);
    } finally {
      await service.close();
    }
  });

  it('без картинки не ходит в сеть', async () => {
    const client = new Human4ai({ token: 't', baseUrl: 'http://127.0.0.1:1' });
    await expect(client.solveCaptcha({ image: '' } as never)).rejects.toThrow(/картинка/);
  });

  it('ошибку службы отдаёт как Human4aiError со статусом', async () => {
    const service = await fakeService(() => ({
      status: 401,
      body: { error: 'Неверный токен клиента' },
    }));

    try {
      const client = new Human4ai({ token: 'bad', baseUrl: service.baseUrl });
      await expect(client.solveCaptcha({ image: 'QUJD' })).rejects.toMatchObject({
        name: 'Human4aiError',
        status: 401,
      });
    } finally {
      await service.close();
    }
  });

  it('таймаут запроса не висит вечно', async () => {
    const service = await fakeService(
      () =>
        new Promise((resolve) => {
          // unref: этот таймер не должен держать процесс после теста.
          setTimeout(() => resolve({ body: {} }), 5_000).unref();
        }),
    );

    try {
      const client = new Human4ai({
        token: 't',
        baseUrl: service.baseUrl,
        requestTimeoutMs: 100,
      });
      await expect(client.solveCaptcha({ image: 'QUJD' })).rejects.toThrow(/таймаут/);
    } finally {
      await service.close();
    }
  });

  it('reject переводит на следующую ступень', async () => {
    const service = await fakeService(({ url }) =>
      url.endsWith('/reject')
        ? { body: { id: 'task_1', status: 'solved', answer: 'от человека', answeredBy: 'human' } }
        : { body: { id: 'task_1', status: 'solved', answer: 'от модели', answeredBy: 'gigachat' } },
    );

    try {
      const client = new Human4ai({ token: 't', baseUrl: service.baseUrl });
      const first = await client.solveCaptcha({ image: 'QUJD' });
      const second = await client.rejectCaptcha(first.id);

      expect([first.answer, second.answer]).toEqual(['от модели', 'от человека']);
      expect(service.requests[1].url).toBe('/api/captcha/task_1/reject');
    } finally {
      await service.close();
    }
  });

  it('solveUntilAccepted дожимает через reject, пока сайт не примет', async () => {
    const answers = ['первый', 'второй', 'третий'];
    let call = 0;
    const service = await fakeService(() => ({
      body: { id: 'task_1', status: 'solved', answer: answers[call++], answeredBy: 'x' },
    }));

    try {
      const client = new Human4ai({ token: 't', baseUrl: service.baseUrl });
      const accepted = await client.solveUntilAccepted(
        { image: 'QUJD' },
        (answer) => answer === 'третий',
      );

      expect(accepted).toBe('третий');
      // Первый запрос — solve, дальше два reject: лишних попыток нет.
      expect(service.requests.map((r) => r.url)).toEqual([
        '/api/captcha/solve',
        '/api/captcha/task_1/reject',
        '/api/captcha/task_1/reject',
      ]);
    } finally {
      await service.close();
    }
  });

  it('solveUntilAccepted отдаёт null, если попытки кончились', async () => {
    const service = await fakeService(() => ({
      body: { id: 'task_1', status: 'solved', answer: 'не подходит', answeredBy: 'x' },
    }));

    try {
      const client = new Human4ai({ token: 't', baseUrl: service.baseUrl });
      const accepted = await client.solveUntilAccepted({ image: 'QUJD' }, () => false, 2);
      expect(accepted).toBeNull();
    } finally {
      await service.close();
    }
  });

  it('solveUntilAccepted не дёргает reject, когда каскад ничего не дал', async () => {
    const service = await fakeService(() => ({
      body: { id: 'task_1', status: 'timeout', answer: null, answeredBy: null },
    }));

    try {
      const client = new Human4ai({ token: 't', baseUrl: service.baseUrl });
      expect(await client.solveUntilAccepted({ image: 'QUJD' }, () => true)).toBeNull();
      expect(service.requests).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it('спрашивает человека голосом', async () => {
    const service = await fakeService(() => ({
      body: { id: 'ask_1', status: 'answered', answer: 'да' },
    }));

    try {
      const client = new Human4ai({ token: 't', baseUrl: service.baseUrl });
      const result = await client.ask({
        question: '  Мержить MR 42?  ',
        channel: 'voice',
        options: ['да', 'нет'],
      });

      expect(result.answer).toBe('да');
      expect(service.requests[0]).toMatchObject({
        url: '/api/ask/solve',
        body: { question: 'Мержить MR 42?', channel: 'voice', options: ['да', 'нет'] },
      });
    } finally {
      await service.close();
    }
  });

  it('health и stats читаются как есть', async () => {
    const service = await fakeService(({ url }) =>
      url.endsWith('/health')
        ? { body: { status: 'ok', solvers: ['gigachat'], asks: true } }
        : { body: { solvers: [] } },
    );

    try {
      const client = new Human4ai({ token: 't', baseUrl: service.baseUrl });
      expect((await client.health()).status).toBe('ok');
      expect(await client.stats()).toEqual({ solvers: [] });
    } finally {
      await service.close();
    }
  });

  it('toBase64 срезает data-URL и кодирует байты', () => {
    expect(toBase64('data:image/jpeg;base64,QUJD')).toBe('QUJD');
    expect(toBase64(new Uint8Array([65, 66, 67]))).toBe('QUJD');
    expect(toBase64(new Uint8Array([65, 66, 67]).buffer)).toBe('QUJD');
  });

  it('экспортирует класс ошибки', () => {
    expect(new Human4aiError('тест', 500, null)).toBeInstanceOf(Error);
  });
});
