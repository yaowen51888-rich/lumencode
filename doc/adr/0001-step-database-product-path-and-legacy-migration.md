# Step Database product path and legacy migration

LumenCode stores project-local Step Database files under `.lumencode/steps.db`. Older `.ccusage/steps.db` databases are treated as legacy data: when the new database is missing and the legacy database exists, LumenCode copies the legacy database to the new path, keeps the legacy file as a rollback-safe backup, and writes only to the new path afterwards. Non-default custom `stepTracking.dbPath` values are respected and are not migrated.
