/**
 * Клиент службы human4ai: отдаёшь картинку капчи — получаешь строку.
 *
 * Внутри у службы каскад (GigaChat → Claude → Павел в Telegram), но клиенту это
 * не важно: он знает только адрес и свой токен. Поэтому здесь нет ни знания про
 * ступени, ни ретраев «на всякий случай» — только честная передача запроса и
 * ответа, плюс `reject` для случая, когда сайт ответ не принял.
 *
 * Зависимостей нет: работаем на встроенном fetch (Node 18+).
 */

export type CaptchaStatus = 'pending' | 'solved' | 'timeout' | 'failed';
export type AskStatus = 'pending' | 'answered' | 'timeout' | 'taken' | 'skipped';
/** Ступени каскада: клиент может ограничить их список. */
export type Solver = 'gigachat' | 'claude' | 'human';
/** Куда задавать вопрос человеку: реплаем в Telegram или голосом на колонку. */
export type AskChannel = 'telegram' | 'voice';

export interface Human4aiOptions {
  /** Токен клиента (заголовок `X-Token`). Обязателен. */
  token: string;
  /** База API. По умолчанию продовая служба. */
  baseUrl?: string;
  /**
   * Ограничение на один HTTP-запрос. По умолчанию 11 минут: синхронный
   * `solveCaptcha` ждёт человека, у службы срок по умолчанию 10 минут.
   */
  requestTimeoutMs?: number;
  /** Своя реализация fetch — для тестов и нестандартных рантаймов. */
  fetch?: typeof globalThis.fetch;
}

/** Картинка капчи: base64, data-URL или сырые байты. */
export type CaptchaImage = string | Uint8Array | ArrayBuffer;

export interface SolveCaptchaInput {
  image: CaptchaImage;
  /** Подсказка модели: «4 цифры», «латиница без пробелов». */
  hint?: string;
  /** Кто и зачем просит — попадает в логи службы и в сообщение человеку. */
  context?: string;
  /** Ограничить каскад: например `['human']` — спросить сразу человека. */
  solvers?: Solver[];
  /** Сколько службе ждать ответа (мс). */
  timeoutMs?: number;
}

export interface CaptchaResult {
  id: string;
  status: CaptchaStatus;
  /** Разгаданный текст. `null`, если каскад не справился или истёк срок. */
  answer: string | null;
  /** Какая ступень дала ответ: gigachat | claude | human. */
  answeredBy: string | null;
}

export interface AskInput {
  question: string;
  /** `text` (по умолчанию) читается сколько нужно; `secret`/`code` — один раз. */
  kind?: 'text' | 'secret' | 'code';
  channel?: AskChannel;
  context?: string;
  link?: string;
  /** Варианты ответа: в Telegram уйдут опросом, на колонке зачитаются. */
  options?: string[];
  /** Колонка для голосового вопроса: номер, имя или device_id. */
  station?: string;
  timeoutMs?: number;
}

export interface AskResult {
  id: string;
  status: AskStatus;
  answer: string | null;
}

export interface HealthResult {
  status: string;
  solvers: string[];
  asks: boolean;
  voice?: boolean;
  voiceQueue?: number;
  mcp?: boolean;
}

/** Ошибка службы: HTTP-статус и тело ответа как есть. */
export class Human4aiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'Human4aiError';
  }
}

const DEFAULT_BASE_URL = 'https://human4ai.paulislava.space/api';
const DEFAULT_REQUEST_TIMEOUT_MS = 11 * 60 * 1000;

export class Human4ai {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: Human4aiOptions) {
    if (!options?.token) throw new Error('human4ai: нужен token');

    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('human4ai: нет fetch — нужен Node 18+ или свой fetch в опциях');
    }
  }

  /** Синхронно: ждём разгадывания и отдаём ответ (или `null`). */
  async solveCaptcha(input: SolveCaptchaInput): Promise<CaptchaResult> {
    return this.request<CaptchaResult>('POST', '/captcha/solve', captchaBody(input), {
      // Ждать столько же, сколько ждёт служба, плюс запас на сеть.
      timeoutMs: input.timeoutMs ? input.timeoutMs + 30_000 : undefined,
    });
  }

  /** Асинхронно: сразу отдаём id, результат забирается через `getCaptcha`. */
  async createCaptcha(input: SolveCaptchaInput): Promise<{ id: string; status: CaptchaStatus }> {
    return this.request('POST', '/captcha', captchaBody(input));
  }

  getCaptcha(id: string): Promise<CaptchaResult> {
    return this.request('GET', `/captcha/${encodeURIComponent(id)}`);
  }

  /**
   * Сайт ответ не принял — переходим к следующей ступени каскада.
   *
   * Именно так и надо обрабатывать неудачу: «решённой» капчу делает не модель, а
   * сайт. Начинать всё заново незачем — служба помнит, какие ступени уже
   * провалились, и не платит за них второй раз.
   */
  rejectCaptcha(id: string): Promise<CaptchaResult> {
    return this.request('POST', `/captcha/${encodeURIComponent(id)}/reject`);
  }

  /**
   * Разгадать с учётом отказов сайта: `check` говорит, принял ли сайт ответ.
   * Первый ответ берём из каскада, дальше на каждый отказ дёргаем `reject`.
   *
   * -> принятый ответ или `null`, если попытки кончились.
   */
  async solveUntilAccepted(
    input: SolveCaptchaInput,
    check: (answer: string, attempt: number) => boolean | Promise<boolean>,
    attempts = 3,
  ): Promise<string | null> {
    let result = await this.solveCaptcha(input);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!result.answer) return null;
      if (await check(result.answer, attempt)) return result.answer;
      if (attempt === attempts) return null;
      result = await this.rejectCaptcha(result.id);
    }

    return null;
  }

  /** Спросить Павла: реплаем в Telegram или голосом на колонке. */
  async ask(input: AskInput): Promise<AskResult> {
    return this.request<AskResult>('POST', '/ask/solve', askBody(input), {
      timeoutMs: input.timeoutMs ? input.timeoutMs + 30_000 : undefined,
    });
  }

  /** Живость службы и то, какие ступени реально подключены. */
  health(): Promise<HealthResult> {
    return this.request('GET', '/health');
  }

  /** Точность ступеней по логу попыток. */
  stats(): Promise<{ solvers: unknown }> {
    return this.request('GET', '/stats');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.requestTimeoutMs,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-Token': this.token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Human4aiError(`human4ai: ${method} ${path} — таймаут запроса`, 0, null);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    const payload = text ? safeJson(text) : null;

    if (!response.ok) {
      const detail =
        (payload as { error?: string } | null)?.error ?? text.slice(0, 200) ?? '';
      throw new Human4aiError(
        `human4ai: ${method} ${path} — ${response.status} ${detail}`.trim(),
        response.status,
        payload ?? text,
      );
    }

    return payload as T;
  }
}

/** Картинку принимаем как угодно, службе отдаём чистый base64. */
export function toBase64(image: CaptchaImage): string {
  if (typeof image === 'string') {
    return image.replace(/^data:image\/\w+;base64,/, '');
  }

  const bytes = image instanceof ArrayBuffer ? new Uint8Array(image) : image;
  return Buffer.from(bytes).toString('base64');
}

function captchaBody(input: SolveCaptchaInput): Record<string, unknown> {
  if (!input?.image) throw new Error('human4ai: нужна картинка капчи (image)');

  return dropUndefined({
    image: toBase64(input.image),
    hint: input.hint,
    context: input.context,
    solvers: input.solvers,
    timeout_ms: input.timeoutMs,
  });
}

function askBody(input: AskInput): Record<string, unknown> {
  if (!input?.question?.trim()) throw new Error('human4ai: нужен вопрос (question)');

  return dropUndefined({
    question: input.question.trim(),
    kind: input.kind,
    channel: input.channel,
    context: input.context,
    link: input.link,
    options: input.options,
    station: input.station,
    timeout_ms: input.timeoutMs,
  });
}

function dropUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default Human4ai;
