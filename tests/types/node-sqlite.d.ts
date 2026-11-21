declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      get(...values: any[]): any;
      all(...values: any[]): any[];
    };
    close(): void;
  }
}
