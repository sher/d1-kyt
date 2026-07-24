// ----------------------------------------------------------------------------
// Config Types
// ----------------------------------------------------------------------------

export type NamingStrategy = 'sequential' | 'timestamp';

export interface JikuConfig {
  migrationsDir: string;
  namingStrategy: NamingStrategy;
}

// ----------------------------------------------------------------------------
// defineConfig
// ----------------------------------------------------------------------------

export function defineConfig(config: JikuConfig): JikuConfig {
  return config;
}
