declare module "bun:sqlite" {
  export class Database {
    constructor(filename: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    query(sql: string): {
      run(...values: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get(...values: unknown[]): any;
      all(...values: unknown[]): any[];
    };
    transaction<T extends (...args: any[]) => any>(callback: T): (...args: Parameters<T>) => ReturnType<T>;
    close(): void;
  }
}
