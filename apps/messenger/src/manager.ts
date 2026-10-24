import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Instance, type InstanceConfig } from './instance.js';
import type { WireEvent } from './messages.js';
import type { AuthMode, InstanceSpec, InstanceStatus, MessengerKind } from './spec.js';

/** Первый номер виртуального экрана; дальше — по порядку создания. */
export const FIRST_DISPLAY = 10;

/**
 * Реестр экземпляров (`dataDir/instances.json`): что поднять после перезапуска контейнера. Истина о
 * том, какие мессенджеры есть у портала, — база api; сюда api присылает `ensure`.
 */
/** Куда отдавать события переписки (задаёт main: очередь в api). */
let emit: (e: WireEvent) => void = () => undefined;
export const setEventSink = (sink: (e: WireEvent) => void) => void (emit = sink);

export class Manager {
  private readonly items = new Map<string, Instance>();

  constructor(
    private readonly config: InstanceConfig,
    private readonly make: (spec: InstanceSpec) => Instance = (spec) => new Instance(spec, config, undefined, (e) => emit(e)),
  ) {}

  private get file() {
    return `${this.config.dataDir}/instances.json`;
  }

  /** Поднять сохранённые экземпляры (сессии WhatsApp восстанавливаются без нового входа). */
  async boot(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    const saved = await readFile(this.file, 'utf8').then((s) => JSON.parse(s) as InstanceSpec[], () => []);
    for (const spec of saved) {
      const inst = this.make(spec);
      this.items.set(spec.id, inst);
      void inst.start();
    }
  }

  list(): InstanceStatus[] {
    return [...this.items.values()].map((i) => i.info);
  }

  get(id: string): Instance | undefined {
    return this.items.get(id);
  }

  /** Создать (или обновить номер/способ входа) и запустить. Повтор с теми же данными ничего не меняет. */
  async ensure(id: string, kind: MessengerKind, phone: string, auth: AuthMode): Promise<InstanceStatus> {
    const prev = this.items.get(id);
    if (prev && prev.spec.kind === kind && prev.spec.phone === phone && prev.spec.auth === auth) {
      if (prev.info.state === 'stopped' || prev.info.state === 'failed' || prev.info.state === 'disconnected') void prev.start();
      return prev.info;
    }
    if (prev) await prev.stop();
    const used = new Set([...this.items.values()].filter((i) => i.spec.id !== id).map((i) => i.spec.display));
    let display = prev?.spec.display ?? FIRST_DISPLAY;
    while (used.has(display)) display++;
    const inst = this.make({ id, kind, phone, auth, display });
    this.items.set(id, inst);
    await this.save();
    void inst.start();
    return inst.info;
  }

  async restart(id: string): Promise<InstanceStatus | null> {
    const inst = this.items.get(id);
    if (!inst) return null;
    await inst.stop();
    void inst.start();
    return inst.info;
  }

  async stop(id: string): Promise<InstanceStatus | null> {
    const inst = this.items.get(id);
    if (!inst) return null;
    await inst.stop();
    return inst.info;
  }

  /** Выйти из аккаунта, удалить сессию и экземпляр. */
  async remove(id: string): Promise<void> {
    const inst = this.items.get(id);
    await inst?.logout();
    this.items.delete(id);
    await this.save();
    await rm(`${this.config.dataDir}/sessions/session-${id}`, { recursive: true, force: true });
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.items.values()].map((i) => i.stop(false)));
  }

  private async save(): Promise<void> {
    await writeFile(this.file, JSON.stringify([...this.items.values()].map((i) => i.spec), null, 2));
  }
}
