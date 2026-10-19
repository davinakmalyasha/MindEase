// Package migrations embeds the schema history.
//
// The files are golang-migrate's format, generated from the Prisma migration
// directories this repository used before the port (one
// `<timestamp>_<name>.up.sql` per migration, in the same order). Up-only: the
// Prisma history never carried down migrations, and inventing them now would
// be a second, untested way to change the schema.
package migrations

import "embed"

//go:embed *.up.sql
var FS embed.FS
