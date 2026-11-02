// Запускатель воркера: регистрирует загрузчик TypeScript (tsx) и подключает worker.ts.
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
