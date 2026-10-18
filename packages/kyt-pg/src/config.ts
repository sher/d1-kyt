export type NamingStrategy = 'sequential' | 'timestamp';

export interface KytPgConfig {
  migrationsDir: string;
  namingStrategy: NamingStrategy;
}

export function defineConfig(config: KytPgConfig): KytPgConfig {
  return config;
}
