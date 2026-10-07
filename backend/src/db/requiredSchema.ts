// Common administrative schema; Forge product tables are a separate concern.
export const REQUIRED_TABLES = ['schema_migrations', 'platform_config', 'production_cutover_record', 'audit_events'] as const;
export const APPEND_ONLY_TABLES = ['audit_events'] as const;
