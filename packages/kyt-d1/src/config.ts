// ----------------------------------------------------------------------------
// Config Types
// ----------------------------------------------------------------------------

export type NamingStrategy = 'sequential' | 'timestamp';

export interface KytD1Config {
  migrationsDir: string;
  namingStrategy: NamingStrategy;
}

// ----------------------------------------------------------------------------
// defineConfig
// ----------------------------------------------------------------------------

export function defineConfig(config: KytD1Config): KytD1Config {
  return config;
}

/** @deprecated Use KytD1Config. */
export type D1KytConfig = KytD1Config;
