// ----------------------------------------------------------------------------
// Config Types
// ----------------------------------------------------------------------------

export type NamingStrategy = 'sequential' | 'timestamp';

export interface D1KytConfig {
  migrationsDir: string;
  dbDir: string;
  namingStrategy: NamingStrategy;
}

// ----------------------------------------------------------------------------
// defineConfig
// ----------------------------------------------------------------------------

export function defineConfig(config: D1KytConfig): D1KytConfig {
  return config;
}
