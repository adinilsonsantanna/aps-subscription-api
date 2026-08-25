# Rollback

This migration is additive and does not update historical rows. Existing `isActive`
values remain unchanged, `installationGeneration` receives only its safe default `0`,
and both lifecycle timestamps remain `NULL`.

If this unapplied migration must be reverted, drop the two indexes first, then drop
`lastInstalledAt`, `lastUninstalledAt`, and `installationGeneration`. Do not run this
rollback automatically or against production; take a backup and verify no deployed
code depends on the columns before applying a reviewed rollback migration.
